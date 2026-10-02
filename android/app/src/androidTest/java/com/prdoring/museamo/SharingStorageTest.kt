package com.prdoring.museamo

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*

class SharingStorageTest {
    @get:Rule val migrations = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), MuseamoDatabase::class.java)
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private lateinit var db: MuseamoDatabase
    private lateinit var repo: Repository
    @Before fun setup() { db = Room.inMemoryDatabaseBuilder(context, MuseamoDatabase::class.java).build(); repo = Repository(db); repo.rawDao.putSyncMetadata(SyncMetadataRow("group", "personal-group")) }
    @After fun cleanup() { db.close() }
    private fun share(tag: TagRow, scope: String = uid()) {
        val state = ShareStorage.registry(repo.rawDao)
        val control = JSONObject().put("id", scope).put("body", JSONObject().put("kind", "open").put("participant", "personal-group").put("data", JSONObject().put("participant", "personal-group").put("tag", tag.json())))
        state.getJSONObject("scopes").put(scope, JSONObject().put("id", scope).put("controls", JSONArray().put(control)).put("proofs", JSONObject()).put("records", JSONArray()))
        state.getJSONObject("bindings").put(scope, JSONObject().put("tagId", tag.id).put("grant", scope).put("detached", false).put("entries", JSONObject()))
        repo.rawDao.putSharingState(ShareStateRow("registry", state.toString()))
    }
    @Test fun nativeInvitationQrRoundTripsAndScannerStaysPortrait() {
        val content = "museamo-share:" + "0123456789abcdef".repeat(120)
        val bitmap = com.journeyapps.barcodescanner.BarcodeEncoder().encodeBitmap(content, com.google.zxing.BarcodeFormat.QR_CODE, 720, 720)
        val pixels = IntArray(bitmap.width * bitmap.height); bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        val luminance = com.google.zxing.RGBLuminanceSource(bitmap.width, bitmap.height, pixels)
        val decoded = com.google.zxing.MultiFormatReader().decode(com.google.zxing.BinaryBitmap(com.google.zxing.common.HybridBinarizer(luminance)))
        assertEquals(content, decoded.text)
        val info = context.packageManager.getActivityInfo(android.content.ComponentName(context, ShareScannerActivity::class.java), 0)
        assertEquals(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, info.screenOrientation)
    }
    @Test fun schemaSixPreservesPrivateSignedHistory() {
        val name = "sharing-migration-" + uid()
        migrations.createDatabase(name, 5).use { old ->
            old.execSQL("INSERT INTO tags(id,name,normalizedName,type) VALUES('tag','Movies','movies','checklist')")
            old.execSQL("INSERT INTO sync_metadata VALUES('coordinator','signed membership')")
            old.execSQL("INSERT INTO sync_revisions VALUES('signed:1','thought','item','signed',1,'original signed header','private original payload')")
        }
        migrations.runMigrationsAndValidate(name, 6, true, SHARING_MIGRATION).use { upgraded ->
            upgraded.query("SELECT header,payload FROM sync_revisions").use { row -> assertTrue(row.moveToFirst()); assertEquals("original signed header", row.getString(0)); assertEquals("private original payload", row.getString(1)) }
            upgraded.query("SELECT COUNT(*) FROM sharing_pending").use { row -> assertTrue(row.moveToFirst()); assertEquals(0, row.getInt(0)) }
            upgraded.query("SELECT type FROM tags").use { row -> assertTrue(row.moveToFirst()); assertEquals("checklist", row.getString(0)) }
        }
        context.deleteDatabase(name)
    }
    @Test fun twoSharedHashtagsRollbackTheSaveAndKeepTheDraft() {
        val a=repo.saveTag(null,"Movies");val b=repo.saveTag(null,"Books");share(a);share(b)
        val draft=repo.draft("test",null,null).copy(text="Still writing",tagIds=jsonIds(listOf(a.id,b.id)))
        repo.saveDraft(draft)
        try {repo.commitDraft(draft);fail("Expected one-scope enforcement")} catch (error:IllegalArgumentException) {assertTrue(error.message!!.contains("only one shared"))}
        assertEquals("Still writing",repo.dao.draft("test")!!.text);assertTrue(repo.dao.entries().isEmpty());assertTrue(repo.rawDao.sharingPending().isEmpty())
    }
    @Test fun sharedAndPrivateNamesRequireExplicitInlineSelection() {
        val shared=repo.saveTag(null,"Movies","checklist");share(shared);val privateTag=repo.saveTag(null,"Movies")
        assertNotEquals(shared.id,privateTag.id);assertTrue(repo.dao.tag(shared.id)!!.shared);assertTrue(repo.dao.tag(privateTag.id)!!.ambiguous)
        val draft=repo.draft("inline",null,null).copy(text="Watch #Movies")
        try {repo.commitDraft(draft);fail("Expected explicit choice")} catch (_:IllegalArgumentException) {}
        val row=repo.commitDraft(draft.copy(tagIds=jsonIds(listOf(shared.id))))
        assertEquals(listOf(shared.id),ids(row.tagIds));val pending=JSONObject(repo.rawDao.sharingPending().single().payload).getJSONObject("payload")
        assertFalse(pending.has("starred"));assertFalse(pending.has("tagIds"));assertFalse(pending.has("profileId"))
    }
    @Test fun assigningAnExistingUnchangedThoughtQueuesASharedRevision() {
        val tag=repo.saveTag(null,"Movies");val row=repo.commitDraft(repo.draft("existing",null,null).copy(text="Arrival"));share(tag)
        repo.edit(row.id,"Arrival",listOf(tag.id))
        val pending=JSONObject(repo.rawDao.sharingPending().single().payload);assertEquals(row.id,pending.getString("entityId"));assertFalse(pending.getBoolean("deleted"));assertEquals("Arrival",pending.getJSONObject("payload").getString("text"))
    }
    @Test fun removingSharedTagImmediatelyKeepsOnlyAFreshPrivateCopy() {
        val tag=repo.saveTag(null,"Movies");val scope=uid();share(tag,scope);val row=repo.commitDraft(repo.draft("detach",null,null).copy(text="Arrival",tagIds=jsonIds(listOf(tag.id))))
        val state=ShareStorage.registry(repo.rawDao);state.getJSONObject("bindings").getJSONObject(scope).getJSONObject("entries").put(row.id,row.id);repo.rawDao.putSharingState(ShareStateRow("registry",state.toString()))
        repo.edit(row.id,"Arrival",emptyList())
        assertNull(repo.dao.entry(row.id));val copy=repo.dao.entries().single();assertNotEquals(row.id,copy.id);assertEquals("Arrival",copy.text);assertTrue(ids(copy.tagIds).isEmpty());assertTrue(repo.rawDao.sharingPending().map { JSONObject(it.payload) }.any { it.optBoolean("deleted") })
    }
    @Test fun portableSnapshotsUseFreshPrivateIdentitiesAndNeverRestoreAccess() {
        val tag=repo.saveTag(null,"Movies");val scope=uid();share(tag,scope);val row=repo.commitDraft(repo.draft("snapshot",null,null).copy(text="Arrival",tagIds=jsonIds(listOf(tag.id))))
        val state=ShareStorage.registry(repo.rawDao);state.getJSONObject("bindings").getJSONObject(scope).getJSONObject("entries").put(row.id,row.id);repo.rawDao.putSharingState(ShareStateRow("registry",state.toString()))
        val snapshot=JSONObject(Backup.export(repo,5));val exported=snapshot.getJSONArray("entries").getJSONObject(0)
        assertNotEquals(row.id,exported.getString("id"));assertNotEquals(tag.id,snapshot.getJSONArray("tags").getJSONObject(0).getString("id"));assertFalse(snapshot.has("scopes"));assertFalse(snapshot.has("bindings"))
        val otherDb=Room.inMemoryDatabaseBuilder(context,MuseamoDatabase::class.java).build()
        try {val other=Repository(otherDb);Backup.import(other,snapshot.toString(),true);assertTrue(ShareStorage.registry(other.rawDao).getJSONObject("bindings").length()==0);assertFalse(other.dao.tags().single().shared)} finally {otherDb.close()}
    }
}
