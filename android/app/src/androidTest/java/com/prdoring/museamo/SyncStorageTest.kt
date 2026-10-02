package com.prdoring.museamo

import android.content.Context
import android.content.ContextWrapper
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class SyncStorageTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    @get:Rule val migrations = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), MuseamoDatabase::class.java)
    private lateinit var db: MuseamoDatabase
    private lateinit var repo: Repository
    private lateinit var platform: SyncPlatform
    private lateinit var isolated: Context
    @Before fun setup() {
        assertTrue("Bundled Rust JNI library must load", SyncCore.available())
        val directory = File(context.cacheDir, "sync-test-${uid()}").apply { mkdirs() }
        isolated = object : ContextWrapper(context) { override fun getFilesDir(): File = directory }
        db = Room.inMemoryDatabaseBuilder(context, MuseamoDatabase::class.java).build(); repo = Repository(db); platform = SyncPlatform(isolated, repo)
        SyncJournal.configure(SyncIdentity(isolated))
    }
    @After fun close() { runCatching { SyncCore.stop() }; db.close(); isolated.filesDir.listFiles()?.filter { it.isFile }?.forEach { it.delete() }; isolated.filesDir.delete() }
    private fun call(method: String, input: JSONObject = JSONObject()): JSONObject {
        val response = JSONObject(platform.platformCall(method, input.toString()))
        assertTrue(response.optString("error"), response.getBoolean("ok")); return response.getJSONObject("result")
    }
    private fun enroll(): String { val group = uid(); call("syncEnroll", JSONObject().put("groupId", group)); return group }
    private fun identity(): JSONObject = call("syncIdentity")
    private fun applyInput(group: String, envelopes: JSONArray = JSONArray()): JSONObject = JSONObject().put("groupId", group).put("envelopes", envelopes).put("members", JSONArray().put(identity())).put("authorizedHistory", JSONObject()).put("authorizedAnchors", JSONObject()).put("purgeProofs", JSONArray()).put("purged", JSONArray())
    private fun signed(group: String, origin: String, sequence: Long, kind: String, entityId: String, payload: JSONObject, previous: String = "", context: JSONObject? = null): JSONObject {
        val revision = JSONObject().put("entityId", entityId).put("dot", JSONObject().put("origin", origin).put("sequence", sequence)).put("context", context ?: JSONObject().put(origin, sequence - 1)).put("clock", JSONObject().put("wall", sequence).put("logical", 0)).put("deleted", false).put("payloadHash", SyncCore.request(JSONObject().put("action", "hash").put("value", payload)).getString("hash"))
        val header = JSONObject().put("protocol", 1).put("group", group).put("kind", kind).put("previousHash", previous).put("revision", revision)
        val signature = call("syncSign", JSONObject().put("bytes", SyncCore.request(JSONObject().put("action", "headerBytes").put("header", header)).getString("bytes"))).getString("signature")
        return JSONObject().put("header", header).put("signature", signature).put("payload", payload)
    }

    @Test fun signedBaselineAndSavedMutationsSurviveCanonicalJniBoundary() {
        val tag = repo.saveTag(null, "Café")
        val entry = repo.commitDraft(repo.draft("test", null, null).copy(text = "Signed\nthought 😀", tagIds = jsonIds(listOf(tag.id))))
        val group = enroll(); repo.dao.updateEntry(entry.copy(starred = true))
        val exported = call("syncExport", JSONObject().put("groupId", group).put("after", JSONObject()).put("limit", 32)).getJSONArray("envelopes")
        assertEquals(3, exported.length())
        for (index in 0 until exported.length()) {
            val envelope = exported.getJSONObject(index)
            assertTrue(SyncCore.request(JSONObject().put("action", "verifyEnvelope").put("envelope", envelope).put("group", group).put("key", identity().getString("signingPublic")).put("purged", false)).getBoolean("valid"))
        }
        assertEquals(repo.revision("thought", entry.id), repo.entryJson(repo.dao.entry(entry.id)!!).getString("revision"))
        assertEquals(1, repo.dao.recovery().size)
        assertEquals(3L, call("syncReceipts").getJSONObject("receipts").getLong(identity().getString("deviceId")))
    }
    @Test fun aggregateLargeLibraryExportsInByteBoundedCausalPages() {
        val text = "Medium sized offline thought\n" + "x".repeat(900 * 1024)
        repeat(32) { repo.dao.insertEntry(EntryRow(uid(), text, 1, 1)) }
        val group = enroll(); val after = JSONObject(); var count = 0; var pages = 0
        do {
            val page = call("syncExport", JSONObject().put("groupId", group).put("after", after).put("limit", 32)); pages++
            assertTrue(page.toString().toByteArray(Charsets.UTF_8).size <= Backup.MAX_BYTES - 64 * 1024)
            val envelopes = page.getJSONArray("envelopes"); assertTrue(envelopes.length() > 0)
            for (index in 0 until envelopes.length()) { val dot = envelopes.getJSONObject(index).getJSONObject("header").getJSONObject("revision").getJSONObject("dot"); val origin = dot.getString("origin"); val sequence = dot.getLong("sequence"); assertEquals(after.optLong(origin, 0) + 1, sequence); after.put(origin, sequence); count++ }
            if (!page.getBoolean("more")) break
            assertTrue("Causal pages must make progress", pages < 4)
        } while (true)
        assertEquals(32, count); assertTrue(pages > 1)
    }
    @Test fun migrationsOneThroughFourPreserveSavedDataAndRemoveOnlyTagNameUniqueness() {
        for (version in 1..4) {
            val name = "sync-migration-$version-${uid()}"
            migrations.createDatabase(name, version).apply { execSQL("INSERT INTO entries(id,text,createdAt,updatedAt,starred,tagIds,profileId) VALUES ('${uid()}','Preserved',1,1,0,'[]',NULL)"); close() }
            migrations.runMigrationsAndValidate(name, 5, true, MEDIA_MIGRATION, LOCATION_MIGRATION, CHECKLIST_MIGRATION, SYNC_MIGRATION).use { database ->
                database.query("SELECT text FROM entries").use { assertTrue(it.moveToFirst()); assertEquals("Preserved", it.getString(0)) }
                database.execSQL("INSERT INTO tags(id,name,normalizedName,type) VALUES ('${uid()}','Collision','collision','standard')")
                database.execSQL("INSERT INTO tags(id,name,normalizedName,type) VALUES ('${uid()}','Collision','collision','checklist')")
            }
            context.deleteDatabase(name)
        }
    }
    @Test fun restoringDeletedThoughtCreatesFreshIdAndKeepsRecoverableHistory() {
        val entry = repo.commitDraft(repo.draft("restore", null, null).copy(text = "Keep my history")); repo.delete(entry.id)
        val restored = repo.restore(entry)
        assertNotEquals(entry.id, restored.id); assertNull(repo.dao.entry(entry.id)); assertEquals(entry.text, repo.dao.entry(restored.id)?.text); assertTrue(repo.dao.recovery().isNotEmpty())
        val backup = JSONObject(Backup.export(repo, 5)); assertEquals(5, backup.getInt("version")); assertTrue(backup.getJSONArray("recovery").length() > 0); assertFalse(backup.has("identity"))
    }
    @Test fun staleSavedHeadRejectsEditAndDeleteWhileSaveAsNewRetainsWriting() {
        val entry = repo.commitDraft(repo.draft("stale", null, null).copy(text = "Original")); val base = repo.revision("thought", entry.id)
        repo.requireThoughtRevision(entry.id, base); repo.dao.updateEntry(entry.copy(text = "A newer saved revision"))
        try { repo.requireThoughtRevision(entry.id, base); fail("Stale edit or delete must fail before a mutation") } catch (error: IllegalArgumentException) { assertTrue(error.message!!.contains("changed")); assertTrue(error.message!!.contains("revision")) }
        assertEquals("A newer saved revision", repo.dao.entry(entry.id)?.text)
        val restored = repo.restore(entry.copy(text = "Unsent writing saved separately")); assertNotEquals(entry.id, restored.id); assertEquals("Unsent writing saved separately", repo.dao.entry(restored.id)?.text); assertEquals("A newer saved revision", repo.dao.entry(entry.id)?.text)
    }
    @Test fun removedAlternatePurgeProofCannotEraseSavedThoughtOrBody() {
        val entry = repo.commitDraft(repo.draft("purge", null, null).copy(text = "Survive a removed signer")); val group = enroll()
        val row = repo.rawDao.syncRevisions().single(); val original = SyncJournal.envelope(repo.rawDao, row, group)
        val header = JSONObject(original.getJSONObject("header").toString()).put("kind", "purge")
        val payload = JSONObject().put("revisionIds", JSONArray().put(row.id)).put("entityIds", JSONArray().put(entry.id))
        header.getJSONObject("revision").put("entityId", uid()).put("payloadHash", SyncCore.request(JSONObject().put("action", "hash").put("value", payload)).getString("hash"))
        val signature = call("syncSign", JSONObject().put("bytes", SyncCore.request(JSONObject().put("action", "headerBytes").put("header", header)).getString("bytes"))).getString("signature")
        val proof = JSONObject().put("header", header).put("signature", signature).put("payload", payload)
        val origin = identity().getString("deviceId"); val anchor = SyncCore.request(JSONObject().put("action", "hash").put("value", original.getJSONObject("header"))).getString("hash")
        val input = applyInput(group).put("purgeProofs", JSONArray().put(proof)).put("authorizedHistory", JSONObject().put(origin, 1)).put("authorizedAnchors", JSONObject().put(origin, JSONObject().put("through", 1).put("headerHash", anchor)))
        val rejected = JSONObject(platform.platformCall("syncApply", input.toString())); assertFalse(rejected.getBoolean("ok"))
        assertEquals(entry.text, repo.dao.entry(entry.id)?.text); assertNotNull(repo.rawDao.syncRevision(row.id)?.payload); assertNull(repo.rawDao.retired("thought", entry.id))
    }
    @Test fun revokedHistoryPagesWithoutBecomingVisibleUntilWitnessedAnchorIsComplete() {
        val group = enroll(); val peer = JSONObject(identity().toString()).put("deviceId", "removed-${uid()}"); val origin = peer.getString("deviceId"); val id = uid()
        var previous = ""; val envelopes = mutableListOf<JSONObject>()
        repeat(33) { index ->
            val sequence = index + 1L; val payload = EntryRow(id, "Remote version $sequence", 1, sequence, completed = false).json().put("attachments", JSONArray())
            val revision = JSONObject().put("entityId", id).put("dot", JSONObject().put("origin", origin).put("sequence", sequence)).put("context", JSONObject().put(origin, sequence - 1)).put("clock", JSONObject().put("wall", sequence).put("logical", 0)).put("deleted", false).put("payloadHash", SyncCore.request(JSONObject().put("action", "hash").put("value", payload)).getString("hash"))
            val header = JSONObject().put("protocol", 1).put("group", group).put("kind", "thought").put("previousHash", previous).put("revision", revision)
            val signature = call("syncSign", JSONObject().put("bytes", SyncCore.request(JSONObject().put("action", "headerBytes").put("header", header)).getString("bytes"))).getString("signature")
            envelopes.add(JSONObject().put("header", header).put("signature", signature).put("payload", payload)); previous = SyncCore.request(JSONObject().put("action", "hash").put("value", header)).getString("hash")
        }
        fun input(batch: List<JSONObject>) = applyInput(group, JSONArray(batch)).put("members", JSONArray().put(identity()).put(peer)).put("authorizedHistory", JSONObject().put(origin, 33)).put("authorizedAnchors", JSONObject().put(origin, JSONObject().put("through", 33).put("headerHash", previous)))
        val staged = call("syncApply", input(envelopes.take(32)))
        assertEquals(32L, staged.getJSONObject("stagedReceipts").getLong(origin)); assertEquals(0L, staged.getJSONObject("receipts").getLong(origin)); assertNull(repo.dao.entry(id))
        val accepted = call("syncApply", input(envelopes.takeLast(1)))
        assertEquals(33L, accepted.getJSONObject("receipts").getLong(origin)); assertEquals("Remote version 33", repo.dao.entry(id)?.text); assertEquals("$origin:33", repo.revision("thought", id)); assertEquals(32, repo.dao.recovery().size)
    }
    @Test fun unlinkedActivePurgeProofOnlyStagesAndHonestBodyCanHydrateIt() {
        val group = enroll(); val peer = JSONObject(identity().toString()).put("deviceId", "peer-${uid()}"); val origin = peer.getString("deviceId"); val id = uid()
        val payload = EntryRow(id, "An honest original", 1, 1).json().put("attachments", JSONArray())
        val original = signed(group, origin, 1, "thought", id, payload)
        val purge = signed(group, origin, 2, "purge", uid(), JSONObject().put("revisionIds", JSONArray().put("$origin:1")).put("entityIds", JSONArray().put(id)), "f".repeat(64))
        fun input(envelopes: JSONArray) = applyInput(group, envelopes).put("members", JSONArray().put(identity()).put(peer))
        val provisional = JSONObject(original.toString()).put("payload", JSONObject.NULL)
        val staged = call("syncApply", input(JSONArray().put(provisional)).put("purgeProofs", JSONArray().put(purge)))
        assertEquals(1L, staged.getJSONObject("stagedReceipts").getLong(origin)); assertEquals(0L, staged.getJSONObject("receipts").getLong(origin)); assertNull(repo.dao.entry(id)); assertNull(repo.rawDao.retired("thought", id))
        val hydrated = call("syncApply", input(JSONArray().put(original)))
        assertEquals(1L, hydrated.getJSONObject("receipts").getLong(origin)); assertEquals(payload.getString("text"), repo.dao.entry(id)?.text); assertNotNull(repo.rawDao.syncRevision("$origin:1")?.payload); assertNull(repo.rawDao.retired("thought", id))
    }
    @Test fun importedRecoveryArchiveIsSignedPortableAndDoesNotCreateLiveThought() {
        val group = enroll(); val peer = JSONObject(identity().toString()).put("deviceId", "desktop-${uid()}"); val origin = peer.getString("deviceId"); val originalId = uid()
        val inner = EntryRow(originalId, "Imported desktop Recovery", 1, 1).json().put("attachments", JSONArray())
        val archive = signed(group, origin, 1, "archiveThought", originalId, JSONObject().put("kind", "thought").put("entityId", originalId).put("payload", inner).put("createdAt", 42))
        call("syncApply", applyInput(group, JSONArray().put(archive)).put("members", JSONArray().put(identity()).put(peer)))
        assertNull(repo.dao.entry(originalId)); assertEquals("$origin:1", repo.dao.recovery().single().id); assertEquals(inner.getString("text"), JSONObject(repo.dao.recovery().single().payload).getString("text")); assertEquals(42L, repo.dao.recovery().single().createdAt)
    }
    @Test fun crossOriginPurgedBodyBootstrapsCausallyAndLaterPageCanPublishLiveSuccessor() {
        val group = enroll(); val source = JSONObject(identity().toString()).put("deviceId", "source-${uid()}"); val purger = JSONObject(identity().toString()).put("deviceId", "purger-${uid()}")
        val origin = source.getString("deviceId"); val purgeOrigin = purger.getString("deviceId"); val id = uid()
        val old = signed(group, origin, 1, "thought", id, EntryRow(id, "Erased old version", 1, 1).json().put("attachments", JSONArray()))
        val proof = signed(group, purgeOrigin, 1, "purge", uid(), JSONObject().put("revisionIds", JSONArray().put("$origin:1")).put("entityIds", JSONArray()), context = JSONObject().put(purgeOrigin, 0).put(origin, 1))
        fun input(rows: JSONArray) = applyInput(group, rows).put("members", JSONArray().put(identity()).put(source).put(purger))
        val applied = call("syncApply", input(JSONArray().put(JSONObject(old.toString()).put("payload", JSONObject.NULL)).put(proof)).put("purgeProofs", JSONArray().put(proof)))
        assertEquals(1L, applied.getJSONObject("receipts").getLong(origin)); assertEquals(1L, applied.getJSONObject("receipts").getLong(purgeOrigin)); assertNull(repo.dao.entry(id)); assertNull(repo.rawDao.syncRevision("$origin:1")?.payload)
        val previous = SyncCore.request(JSONObject().put("action", "hash").put("value", old.getJSONObject("header"))).getString("hash")
        val next = signed(group, origin, 2, "thought", id, EntryRow(id, "Live successor from a later page", 1, 2).json().put("attachments", JSONArray()), previous)
        call("syncApply", input(JSONArray().put(next))); assertEquals("Live successor from a later page", repo.dao.entry(id)?.text)
    }
    @Test fun retiredThoughtSuppressesLateArchivedCopyButPreservesTagArchiveWithSameUuid() {
        val group = enroll(); val peer = JSONObject(identity().toString()).put("deviceId", "archive-peer-${uid()}"); val origin = peer.getString("deviceId"); val id = uid()
        var previous = ""
        fun operation(sequence: Long, kind: String, entity: String, payload: JSONObject): JSONObject = signed(group, origin, sequence, kind, entity, payload, previous).also { previous = SyncCore.request(JSONObject().put("action", "hash").put("value", it.getJSONObject("header"))).getString("hash") }
        fun input(rows: JSONArray) = applyInput(group, rows).put("members", JSONArray().put(identity()).put(peer))
        val first = operation(1, "thought", id, EntryRow(id, "Retired source", 1, 1).json().put("attachments", JSONArray()))
        val purge = operation(2, "purge", uid(), JSONObject().put("revisionIds", JSONArray().put("$origin:1")).put("entityIds", JSONArray().put(id)))
        call("syncApply", input(JSONArray().put(first).put(purge))); assertNotNull(repo.rawDao.retired("thought", id))
        val thoughtArchive = operation(3, "archiveThought", id, JSONObject().put("kind", "thought").put("entityId", id).put("payload", EntryRow(id, "Late offline archive", 1, 1).json().put("attachments", JSONArray())).put("createdAt", 1))
        val tagArchive = operation(4, "archiveTag", id, JSONObject().put("kind", "tag").put("entityId", id).put("payload", JSONObject().put("id", id).put("name", "Same UUID category").put("type", "standard")).put("createdAt", 1))
        call("syncApply", input(JSONArray().put(thoughtArchive).put(tagArchive)))
        assertNull(repo.rawDao.syncRevision("$origin:3")?.payload); assertEquals("tag", repo.dao.recovery().single().kind); assertNotNull(repo.rawDao.syncRevision("$origin:4")?.payload)
        val exported = call("syncExport", JSONObject().put("groupId", group).put("after", JSONObject()).put("limit", 32)); assertEquals(4, exported.getJSONArray("envelopes").length()); assertTrue(exported.getJSONArray("purgeProofs").length() > 0)
    }
    @Test fun signedPurgeCannotEraseControlHistory() {
        val group = enroll(); val peer = JSONObject(identity().toString()).put("deviceId", "control-${uid()}"); val origin = peer.getString("deviceId")
        val tag = JSONObject().put("id", uid()).put("name", "Control target").put("type", "standard")
        val first = signed(group, origin, 1, "tag", tag.getString("id"), tag)
        val previous = SyncCore.request(JSONObject().put("action", "hash").put("value", first.getJSONObject("header"))).getString("hash")
        val second = signed(group, origin, 2, "purge", uid(), JSONObject().put("revisionIds", JSONArray().put("$origin:1")).put("entityIds", JSONArray()), previous)
        val secondHash = SyncCore.request(JSONObject().put("action", "hash").put("value", second.getJSONObject("header"))).getString("hash")
        fun input(rows: JSONArray) = applyInput(group, rows).put("members", JSONArray().put(identity()).put(peer))
        call("syncApply", input(JSONArray().put(first).put(second)))
        val third = signed(group, origin, 3, "purge", uid(), JSONObject().put("revisionIds", JSONArray().put("$origin:2")).put("entityIds", JSONArray()), secondHash)
        assertFalse(JSONObject(platform.platformCall("syncApply", input(JSONArray().put(third)).toString())).getBoolean("ok")); assertNotNull(repo.rawDao.syncRevision("$origin:2")?.payload); assertNull(repo.rawDao.syncRevision("$origin:3"))
    }
    @Test fun purgedOriginalRetainedByPrivateDraftAndPinsIsNotAuthorizedForSync() {
        val bytes = "Private draft retention".toByteArray(); val checksum = SyncIdentity.hex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes))
        val media = MediaRow(uid(), "image", "image/heic", "draft-original.heic", bytes.size.toLong(), 1, 1, null, checksum)
        repo.rawDao.insertMedia(media); MediaFiles(isolated, repo).file(media.id).writeBytes(bytes)
        val saved = repo.commitDraft(repo.draft("shared-media", null, null).copy(text = "Previously shared", mediaIds = jsonIds(listOf(media.id)))); enroll()
        assertEquals(SyncIdentity.hex(bytes), call("syncReadMedia", JSONObject().put("id", media.id).put("offset", 0)).getString("bytes"))
        repo.saveDraft(repo.draft("private-draft", null, null).copy(mediaIds = jsonIds(listOf(media.id)))); repo.mediaPins.add(media.id)
        repo.delete(saved.id); repo.dao.recovery().map { it.id }.forEach { platform.clearRecovery(repo, it) }; MediaFiles(isolated, repo).cleanup()
        assertTrue(MediaFiles(isolated, repo).file(media.id).isFile); assertTrue(media.id in repo.references()); assertEquals(0, call("syncMissingMedia").getInt("totalCount"))
        assertFalse(JSONObject(platform.platformCall("syncReadMedia", JSONObject().put("id", media.id).put("offset", 0).toString())).getBoolean("ok"))
        assertFalse(JSONObject(platform.platformCall("syncWriteMedia", JSONObject().put("id", media.id).put("offset", 0).put("checksum", checksum).put("size", media.byteSize).put("bytes", SyncIdentity.hex(bytes)).put("metadata", media.json()).toString())).getBoolean("ok"))
    }
    @Test fun remotePermanentPurgeScrubsFileBackedRoomPagesAndWal() {
        val name = "purge-pages-${uid()}.db"
        val fileDb = Room.databaseBuilder(context, MuseamoDatabase::class.java, name).setJournalMode(androidx.room.RoomDatabase.JournalMode.WRITE_AHEAD_LOGGING).build()
        try {
            val fileRepo = Repository(fileDb); val filePlatform = SyncPlatform(isolated, fileRepo)
            fun fileCall(method: String, input: JSONObject = JSONObject()): JSONObject { val result = JSONObject(filePlatform.platformCall(method, input.toString())); assertTrue(result.optString("error"), result.getBoolean("ok")); return result.getJSONObject("result") }
            val marker = "SYNTHETIC-PURGE-PLAINTEXT-${uid()}-END"
            val saved = fileRepo.commitDraft(fileRepo.draft("scrub-pages", null, null).copy(text = marker)); val group = uid(); fileCall("syncEnroll", JSONObject().put("groupId", group))
            val local = fileCall("syncIdentity"); val peer = JSONObject(local.toString()).put("deviceId", "scrub-peer-${uid()}"); val origin = peer.getString("deviceId"); val localOrigin = local.getString("deviceId")
            val proof = signed(group, origin, 1, "purge", uid(), JSONObject().put("revisionIds", JSONArray().put("$localOrigin:1")).put("entityIds", JSONArray().put(saved.id)), context = JSONObject().put(origin, 0).put(localOrigin, 1))
            fileCall("syncApply", JSONObject().put("groupId", group).put("members", JSONArray().put(local).put(peer)).put("authorizedHistory", JSONObject()).put("envelopes", JSONArray().put(proof)).put("purgeProofs", JSONArray().put(proof)))
            assertNull(fileRepo.dao.entry(saved.id)); assertNull(fileRepo.rawDao.syncRevision("$localOrigin:1")?.payload); assertNull(fileRepo.rawDao.syncMetadata("purge.storage.pending"))
            val main = context.getDatabasePath(name); val wal = File(main.parentFile, "$name-wal")
            listOf(main, wal).filter { it.isFile }.forEach { assertFalse("Cleared text remains in ${it.name}", it.readBytes().toString(Charsets.ISO_8859_1).contains(marker)) }
        } finally { fileDb.close(); context.deleteDatabase(name) }
    }
    @Test fun localDuplicateValidationUsesPinnedNormalizationEvenForLegacyStoredNames() {
        repo.rawDao.putTag(TagRow(uid(), "Cafe\u0301", "cafe\u0301", "standard"))
        try { repo.saveTag(null, "Café"); fail("Canonically equivalent legacy category must be reused") } catch (_: IllegalArgumentException) {}
        assertEquals("οσ", normalizeTag("ΟΣ"))
        repo.rawDao.putTag(TagRow(uid(), "ΟΣ", "ος", "standard"))
        try { repo.saveTag(null, "ΟΣ"); fail("Legacy Java final-sigma normalization must not permit a duplicate") } catch (_: IllegalArgumentException) {}
        val reopened = Repository(db); assertEquals(normalizeTag("Café"), reopened.dao.tags().single { it.name.startsWith("Cafe") }.normalizedName); assertEquals("οσ", reopened.dao.tags().single { it.name == "ΟΣ" }.normalizedName)
    }
    @Test fun windowsSignedArchiveFixtureAppliesToRoomAndPreservesUnsupportedOriginal() {
        val fixture = JSONObject(InstrumentationRegistry.getInstrumentation().context.assets.open("windows-archive.json").bufferedReader().use { it.readText() })
        val group = fixture.getString("groupId"); call("syncEnroll", JSONObject().put("groupId", group))
        call("syncApply", applyInput(group, fixture.getJSONArray("envelopes")).put("members", JSONArray().put(identity()).put(fixture.getJSONObject("identity"))).put("purgeProofs", fixture.getJSONArray("purgeProofs")))
        assertEquals(1, repo.dao.entries().size); assertEquals(1, repo.dao.recovery().size); assertEquals(1, call("syncMissingMedia").getInt("totalCount"))
        val original = fixture.getJSONArray("originals").getJSONObject(0); val id = original.getString("id"); val row = repo.dao.media(id)!!
        val complete = call("syncWriteMedia", JSONObject().put("id", id).put("offset", 0).put("size", row.byteSize).put("checksum", row.checksum).put("bytes", original.getString("bytes")).put("metadata", row.json()))
        assertTrue(complete.getBoolean("complete")); assertTrue(MediaFiles(isolated, repo).intact(row)); assertEquals(0, call("syncMissingMedia").getInt("totalCount"))
        val export = call("syncExport", JSONObject().put("groupId", group).put("after", JSONObject()).put("limit", 32)); assertEquals(3, export.getJSONArray("envelopes").length())
    }
    @Test fun emitsSyntheticSignedAndroidExportForReciprocalWindowsGoldenGate() {
        val tag = repo.saveTag(null, "Android Café 😀", "checklist")
        val entry = repo.commitDraft(repo.draft("reciprocal", null, null).copy(text = "Signed Android thought\nline two", tagIds = jsonIds(listOf(tag.id))))
        repo.dao.updateEntry(entry.copy(completed = true)); val group = enroll()
        val publicIdentity = JSONObject(identity().toString()).apply { remove("noisePrivate") }
        val fixture = call("syncExport", JSONObject().put("groupId", group).put("after", JSONObject()).put("limit", 32)).put("identity", publicIdentity).put("groupId", group).put("originals", JSONArray())
        val metadata = android.content.ContentValues().apply { put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, "museamo-android-golden-export.json"); put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "application/json"); put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS) }
        val uri = requireNotNull(context.contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, metadata))
        requireNotNull(context.contentResolver.openOutputStream(uri)).use { it.write(fixture.toString(2).toByteArray()) }
        assertEquals(3, fixture.getJSONArray("envelopes").length()); assertFalse(fixture.getJSONObject("identity").has("noisePrivate"))
    }
    @Test fun outOfRangePortableTimestampsAreRejectedAtomically() {
        val entry = repo.commitDraft(repo.draft("date", null, null).copy(text = "Safe date")); val before = Backup.export(repo)
        val invalid = JSONObject(before).also { it.getJSONArray("entries").getJSONObject(0).put("createdAt", 8_000_000_000_000_000_000L) }
        try { Backup.import(repo, invalid.toString()); fail("Invalid JavaScript Date must fail before publication") } catch (_: IllegalArgumentException) {}
        assertEquals(entry, repo.dao.entries().single()); assertEquals(1, repo.dao.syncRevisions().size)
    }
    @Test fun signedOutOfRangeHybridClockCannotPoisonFutureCaptureOrRecoveryDates() {
        val group = enroll(); val peer = JSONObject(identity().toString()).put("deviceId", "clock-${uid()}"); val origin = peer.getString("deviceId"); val id = uid()
        val envelope = signed(group, origin, 1, "thought", id, EntryRow(id, "Valid body with hostile clock", 1, 1).json().put("attachments", JSONArray()))
        val header = envelope.getJSONObject("header"); header.getJSONObject("revision").getJSONObject("clock").put("wall", Backup.MAX_TIMESTAMP + 1L)
        envelope.put("signature", call("syncSign", JSONObject().put("bytes", SyncCore.request(JSONObject().put("action", "headerBytes").put("header", header)).getString("bytes"))).getString("signature"))
        assertFalse(JSONObject(platform.platformCall("syncApply", applyInput(group, JSONArray().put(envelope)).put("members", JSONArray().put(identity()).put(peer)).toString())).getBoolean("ok"))
        assertNull(repo.dao.entry(id)); assertNull(repo.rawDao.syncMetadata("clock.wall")); assertTrue(repo.dao.recovery().isEmpty())
        val local = repo.commitDraft(repo.draft("after-hostile-clock", null, null).copy(text = "Capture still works")); assertNotNull(repo.dao.entry(local.id))
    }
    @Test fun enrollmentAliasesPreserveSignedTagIdentityRecoveryAndLocalWidgetDefaults() {
        val localId = "88888888-8888-4888-8888-888888888888"; val peerId = "44444444-4444-4444-8444-444444444444"
        val tag = repo.saveTag(localId, "Groceries", "checklist"); val profile = ProfileRow(uid(), "Kitchen", "fixed", jsonIds(listOf(tag.id)), tag.id); repo.saveProfile(profile)
        val draft = repo.draft("alias", profile, null).copy(text = "Milk"); val thought = repo.commitDraft(draft); repo.draft("widget-draft", profile, null)
        val group = enroll(); val peer = JSONObject(identity().toString()).put("deviceId", "peer-${uid()}"); val remote = JSONObject().put("id", peerId).put("name", "groceries").put("type", "checklist")
        call("syncApply", applyInput(group, JSONArray().put(signed(group, peer.getString("deviceId"), 1, "tag", peerId, remote))).put("members", JSONArray().put(identity()).put(peer)))
        val coalesce = JSONObject().put("enrollmentId", "first-merge").put("localTags", JSONArray().put(tag.json())).put("peerTags", JSONArray().put(remote))
        call("syncCoalesceTags", coalesce); call("syncCoalesceTags", coalesce)
        assertEquals(peerId, repo.dao.tags().single().id); assertEquals(listOf(peerId), ids(repo.dao.entry(thought.id)!!.tagIds)); assertEquals(listOf(peerId), ids(repo.dao.profile(profile.id)!!.tagIds)); assertEquals(peerId, repo.dao.profile(profile.id)?.selectedTagId)
        assertEquals(listOf(peerId), ids(repo.dao.draft("widget-draft")!!.tagIds)); assertEquals(1, repo.rawDao.syncRevisions().count { it.kind == "tagAlias" }); assertEquals(1, repo.rawDao.syncRevisions().count { it.kind == "thought" })
        repo.dao.recovery().filter { it.kind == "tag" }.forEach { assertEquals(it.entityId, JSONObject(it.payload).getString("id")) }
        val backup = Backup.export(repo, 5); val restoredDb = Room.inMemoryDatabaseBuilder(context, MuseamoDatabase::class.java).build()
        try { val restored = Repository(restoredDb); Backup.import(restored, backup, withMedia = true); assertEquals(1, restored.dao.entries().size); assertTrue(restored.dao.recovery().isNotEmpty()) } finally { restoredDb.close() }
        val localHeader = repo.rawDao.syncRevisions().first { it.kind == "tag" && it.origin == identity().getString("deviceId") }; assertEquals(localId, SyncJournal.revision(localHeader).getString("entityId")); assertEquals(localId, JSONObject(localHeader.payload!!).getString("id"))
        repo.edit(thought.id, "Milk updated", listOf(peerId))
        val historical = repo.dao.recovery().first { it.kind == "thought" && it.entityId == thought.id }; assertEquals(listOf(localId), ids(JSONObject(historical.payload).getJSONArray("tagIds").toString()))
        val restoredThought = repo.restore(Backup.entry(JSONObject(historical.payload))); assertEquals(listOf(peerId), ids(restoredThought.tagIds)); assertEquals(listOf(localId), ids(JSONObject(repo.rawDao.recoveryItem(historical.id)!!.payload).getJSONArray("tagIds").toString()))
        val portable = JSONObject(Backup.export(repo, 5)); val portableHistory = portable.getJSONArray("recovery").let { a -> (0 until a.length()).map { a.getJSONObject(it) }.first { it.getString("id") == historical.id } }
        assertEquals(listOf(peerId), ids(portableHistory.getJSONObject("payload").getJSONArray("tagIds").toString())); assertEquals(thought.id, portableHistory.getJSONObject("payload").getString("id")); assertEquals(thought.id, portableHistory.getString("entityId"))
        val roundtripDb = Room.inMemoryDatabaseBuilder(context, MuseamoDatabase::class.java).build()
        try { val imported = Repository(roundtripDb); Backup.import(imported, portable.toString(), withMedia = true); val item = imported.dao.recovery().first { JSONObject(it.payload).optString("text") == "Milk" }; val copy = imported.restore(Backup.entry(JSONObject(item.payload))); assertEquals(listOf(peerId), ids(copy.tagIds)) } finally { roundtripDb.close() }
    }
    @Test fun laterSameNameRenameCollisionRetainsDistinctTagIds() {
        val first = repo.saveTag(null, "First"); val group = enroll(); val peer = JSONObject(identity().toString()).put("deviceId", "peer-${uid()}"); val secondId = uid()
        val sameName = JSONObject().put("id", secondId).put("name", first.name).put("type", first.type)
        call("syncApply", applyInput(group, JSONArray().put(signed(group, peer.getString("deviceId"), 1, "tag", secondId, sameName))).put("members", JSONArray().put(identity()).put(peer)))
        assertEquals(setOf(first.id, secondId), repo.dao.tags().map { it.id }.toSet()); assertTrue(repo.rawDao.syncMetadataPrefix("tagalias:%").isEmpty())
        val existingSnapshot = JSONArray(repo.dao.tags().map { it.json() }); val incomingId = uid(); val incoming = JSONObject().put("id", incomingId).put("name", first.name).put("type", first.type)
        val priorHeader = repo.rawDao.originRevision(peer.getString("deviceId"), 1)!!.let { JSONObject(it.header).getJSONObject("header") }; val previous = SyncCore.request(JSONObject().put("action", "hash").put("value", priorHeader)).getString("hash")
        call("syncApply", applyInput(group, JSONArray().put(signed(group, peer.getString("deviceId"), 2, "tag", incomingId, incoming, previous))).put("members", JSONArray().put(identity()).put(peer)))
        call("syncCoalesceTags", JSONObject().put("enrollmentId", "later-newcomer").put("localTags", existingSnapshot).put("peerTags", JSONArray().put(incoming)))
        assertEquals(setOf(first.id, secondId, incomingId), repo.dao.tags().map { it.id }.toSet()); assertTrue(repo.rawDao.syncMetadataPrefix("tagalias:%").isEmpty())
        try { repo.saveTag(null, first.name); fail("A third locally created duplicate remains invalid") } catch (_: IllegalArgumentException) {}
    }
    @Test fun jniCoordinatorAttachesCallbackThreadsWithoutBlockingRepositoryWriter() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        Store.executor.execute { entered.countDown(); release.await(3, TimeUnit.SECONDS) }; assertTrue(entered.await(1, TimeUnit.SECONDS))
        val worker = Executors.newSingleThreadExecutor()
        try { val started = worker.submit<JSONObject> { SyncCore.start(platform) }; Thread.sleep(150); release.countDown(); val state = started.get(8, TimeUnit.SECONDS); assertTrue(state.getBoolean("enabled")); assertEquals(identity().getString("deviceId"), state.getString("deviceId")) }
        finally { release.countDown(); worker.shutdownNow(); SyncCore.stop() }
    }
    @Test fun strictParserRejectsDuplicateBackupKeys() {
        try { SyncCore.request(JSONObject().put("action", "parseJson").put("text", "{\"version\":1,\"version\":5}")); fail("Duplicate backup keys must be rejected") } catch (_: IllegalStateException) {}
    }
}
