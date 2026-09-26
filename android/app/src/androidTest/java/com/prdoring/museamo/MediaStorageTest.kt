package com.prdoring.museamo

import android.content.Context
import android.content.ContextWrapper
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.*
import org.junit.Assert.*
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class MediaStorageTest {
    @get:Rule val migration = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), MuseamoDatabase::class.java)
    private lateinit var context: Context
    private lateinit var root: File
    private lateinit var db: MuseamoDatabase
    private lateinit var repo: Repository
    private lateinit var files: MediaFiles
    @Before fun setup() {
        val app = ApplicationProvider.getApplicationContext<Context>()
        root = File(app.cacheDir, "media-test-${uid()}").apply { mkdirs() }
        context = object : ContextWrapper(app) {
            override fun getFilesDir() = File(root, "files").apply { mkdirs() }
            override fun getCacheDir() = File(root, "cache").apply { mkdirs() }
        }
        db = Room.inMemoryDatabaseBuilder(context, MuseamoDatabase::class.java).build()
        repo = Repository(db); files = MediaFiles(context, repo)
    }
    @After fun cleanup() { db.close(); root.deleteRecursively() }
    private fun media(): MediaRow {
        val bytes = android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=", android.util.Base64.DEFAULT)
        val id = uid(); files.file(id).writeBytes(bytes)
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        return MediaRow(id, "image", "image/png", "photo.png", bytes.size.toLong(), 1, 1, null, digest).also { repo.dao.insertMedia(it) }
    }
    @Test fun migrationPreservesExistingEntriesAndDrafts() {
        val name = "media-migration-${uid()}"
        migration.createDatabase(name, 1).use {
            it.execSQL("INSERT INTO entries VALUES ('old', 'Keep me', 1, 1, 0, '[]', NULL)")
            it.execSQL("INSERT INTO drafts VALUES ('widget', 'draft', 'Still writing', '[]', NULL)")
        }
        migration.runMigrationsAndValidate(name, 2, true, MEDIA_MIGRATION).use { migrated ->
            migrated.query("SELECT text, mediaIds FROM entries").use { assertTrue(it.moveToFirst()); assertEquals("Keep me", it.getString(0)); assertEquals("[]", it.getString(1)) }
            migrated.query("SELECT text, mediaIds FROM drafts").use { assertTrue(it.moveToFirst()); assertEquals("Still writing", it.getString(0)); assertEquals("[]", it.getString(1)) }
        }
    }
    @Test fun mediaOnlyDraftSurvivesDuplicateSendAndUndo() {
        val image = media()
        val draft = repo.draft("widget", null, null).copy(mediaIds = jsonIds(listOf(image.id)))
        repo.saveDraft(draft)
        assertEquals(draft, repo.draft("widget", null, null))
        val entry = repo.commitDraft(draft)
        assertEquals(entry, repo.commitDraft(draft)); assertNull(repo.dao.draft("widget"))
        repo.delete(entry.id); files.cleanup(); assertTrue(files.file(image.id).exists())
        repo.restore(entry); repo.deletedPins.remove(entry.id); files.cleanup()
        assertEquals(entry, repo.dao.entry(entry.id)); assertTrue(files.file(image.id).exists())
        repo.delete(entry.id); repo.deletedPins.remove(entry.id); files.cleanup()
        assertNull(repo.dao.media(image.id)); assertFalse(files.file(image.id).exists())
    }
    @Test fun cancellationAndFailedEditPreserveSavedMedia() {
        val original = media(); val entry = repo.commitDraft(repo.draft("app", null, null).copy(mediaIds = jsonIds(listOf(original.id))))
        val pending = media(); repo.mediaPins.add(pending.id); files.cleanup()
        assertTrue(files.file(pending.id).exists())
        repo.mediaPins.remove(pending.id); files.cleanup()
        assertFalse(files.file(pending.id).exists()); assertTrue(files.file(original.id).exists())
        try { repo.edit(entry.id, "", emptyList(), emptyList()); fail() } catch (_: IllegalArgumentException) {}
        assertEquals(entry, repo.dao.entry(entry.id))
    }
    @Test fun archiveRoundTripIsIdempotentAndOldJsonStillImports() {
        val image = media()
        val entry = repo.commitDraft(repo.draft("app", null, null).copy(text = "A photo", mediaIds = jsonIds(listOf(image.id))))
        val archive = ByteArrayOutputStream().also { MediaBackup.export(context, repo, it) }.toByteArray()
        repo.dao.deleteEntry(entry.id); files.cleanup()
        repeat(2) { MediaBackup.import(context, repo, ByteArrayInputStream(archive)) }
        assertEquals(listOf(entry), repo.dao.entries()); assertEquals(1, repo.dao.media().size)
        assertEquals(image.byteSize, files.file(image.id).length())
        val legacy = org.json.JSONObject(Backup.export(repo)).put("entries", org.json.JSONArray().put(entry.copy(id = uid(), text = "Legacy", mediaIds = "[]").json()))
        MediaBackup.import(context, repo, ByteArrayInputStream(legacy.toString().toByteArray()))
        assertEquals(2, repo.dao.entries().size)
    }
    @Test fun corruptAndUnsafeArchivesMakeNoDatabaseChanges() {
        val image = media(); val entry = repo.commitDraft(repo.draft("app", null, null).copy(mediaIds = jsonIds(listOf(image.id))))
        val root = org.json.JSONObject(Backup.export(repo)).put("version", 2).put("media", org.json.JSONArray().put(image.json()))
        for (path in listOf("../escape", "media/${image.id}", "missing")) {
            val bytes = ByteArrayOutputStream().also { output -> ZipOutputStream(output).use { zip ->
                zip.putNextEntry(ZipEntry("manifest.json")); zip.write(root.toString().toByteArray()); zip.closeEntry()
                if (path != "missing") { zip.putNextEntry(ZipEntry(path)); zip.write(byteArrayOf(1, 2, 3)); zip.closeEntry() }
            } }.toByteArray()
            try { MediaBackup.import(context, repo, ByteArrayInputStream(bytes)); fail(path) } catch (_: Exception) {}
            assertEquals(listOf(entry), repo.dao.entries()); assertEquals(listOf(image), repo.dao.media())
        }
    }
    @Test fun conflictingMediaIdsAreRemappedWithoutDuplicatingRepeatedImports() {
        val image = media()
        val entry = repo.commitDraft(repo.draft("app", null, null).copy(mediaIds = jsonIds(listOf(image.id))))
        val archive = ByteArrayOutputStream().also { MediaBackup.export(context, repo, it) }.toByteArray()
        repo.dao.deleteMedia(image.id); repo.dao.insertMedia(image.copy(filename = "existing-renamed.png"))
        repeat(2) { MediaBackup.import(context, repo, ByteArrayInputStream(archive)) }
        assertEquals(2, repo.dao.media().size); assertEquals(2, repo.dao.entries().size)
        assertEquals(entry, repo.dao.entry(entry.id))
        assertNotEquals(entry.mediaIds, repo.dao.entries().first { it.id != entry.id }.mediaIds)
    }
    @Test fun streamingLimitRejectsOversizedAndEmptyFiles() {
        try { files.copyChecked(ByteArrayInputStream(ByteArray(11)), ByteArrayOutputStream(), 10); fail() } catch (_: IllegalArgumentException) {}
        try { files.copyChecked(ByteArrayInputStream(ByteArray(0)), ByteArrayOutputStream(), 10); fail() } catch (_: IllegalArgumentException) {}
    }
}
