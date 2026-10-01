package com.prdoring.museamo

import android.content.Context
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

class ChecklistStorageTest {
    @get:Rule val migration = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), MuseamoDatabase::class.java)
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private lateinit var db: MuseamoDatabase
    private lateinit var repo: Repository
    @Before fun setup() { db = Room.inMemoryDatabaseBuilder(context, MuseamoDatabase::class.java).build(); repo = Repository(db) }
    @After fun cleanup() { db.close() }
    private fun post(vararg tags: TagRow) = repo.commitDraft(repo.draft(uid(), null, null).copy(text = "**Buy peaches**", tagIds = jsonIds(tags.map { it.id })))
    private fun rejected(action: () -> Unit) { try { action(); fail("Expected rejection") } catch (_: IllegalArgumentException) {} }
    private fun archive(root: JSONObject): ByteArray = ByteArrayOutputStream().also { output ->
        ZipOutputStream(output).use { zip -> zip.putNextEntry(ZipEntry("manifest.json")); zip.write(root.toString().toByteArray()); zip.closeEntry() }
    }.toByteArray()
    private fun manifest(): JSONObject = JSONObject(Backup.export(repo, 4)).put("media", org.json.JSONArray())

    @Test fun allPreviousSchemasMigrateWithStandardAndUncheckedDefaults() {
        for (version in 1..3) {
            val name = "checklist-migration-${uid()}"
            val oldLocation = JSONObject().put("latitude", 45.5).put("longitude", -122.6).put("capturedAt", 1).put("token", uid()).put("name", "Trader Joe's").put("address", "123 Main Street, Portland, OR 97205, USA").put("locality", "Portland, Oregon").toString()
            migration.createDatabase(name, version).use {
                it.execSQL("INSERT INTO tags (id,name,normalizedName) VALUES ('tag','Tasks','tasks')")
                it.execSQL("INSERT INTO profiles (id,label,mode,tagIds,selectedTagId) VALUES ('profile','Capture','picker','[]','tag')")
                it.execSQL("INSERT INTO bindings (widgetId,profileId) VALUES (55,'profile')")
                it.execSQL("INSERT INTO entries (id,text,createdAt,updatedAt,starred,tagIds,profileId) VALUES ('entry','Keep me',1,2,1,'[\"tag\"]','profile')")
                it.execSQL("INSERT INTO drafts (profileKey,entryId,text,tagIds,profileId) VALUES ('profile','draft','Still writing','[\"tag\"]','profile')")
                if (version >= 2) {
                    it.execSQL("INSERT INTO media (id,kind,mimeType,filename,byteSize,width,height,duration,checksum) VALUES ('photo','image','image/png','memory.png',100,20,30,NULL,'original-checksum')")
                    it.execSQL("UPDATE entries SET mediaIds = '[\"photo\"]'")
                    it.execSQL("UPDATE drafts SET mediaIds = '[\"photo\"]'")
                }
                if (version >= 3) {
                    it.execSQL("UPDATE entries SET location = ?, locationSearch = ?", arrayOf(oldLocation, "Original search index"))
                    it.execSQL("UPDATE drafts SET location = ?, locationAttempted = 1", arrayOf(oldLocation))
                }
            }
            migration.runMigrationsAndValidate(name, 4, true, MEDIA_MIGRATION, LOCATION_MIGRATION, CHECKLIST_MIGRATION).use {
                it.query("SELECT name,type FROM tags").use { row -> assertTrue(row.moveToFirst()); assertEquals("Tasks", row.getString(0)); assertEquals("standard", row.getString(1)) }
                it.query("SELECT text,starred,completed,tagIds,updatedAt FROM entries").use { row -> assertTrue(row.moveToFirst()); assertEquals("Keep me", row.getString(0)); assertEquals(1, row.getInt(1)); assertEquals(0, row.getInt(2)); assertEquals("[\"tag\"]", row.getString(3)); assertEquals(2, row.getLong(4)) }
                it.query("SELECT text,profileId FROM drafts").use { row -> assertTrue(row.moveToFirst()); assertEquals("Still writing", row.getString(0)); assertEquals("profile", row.getString(1)) }
                it.query("SELECT selectedTagId FROM profiles").use { row -> assertTrue(row.moveToFirst()); assertEquals("tag", row.getString(0)) }
                it.query("SELECT widgetId FROM bindings").use { row -> assertTrue(row.moveToFirst()); assertEquals(55, row.getInt(0)) }
                if (version >= 2) {
                    it.query("SELECT mediaIds FROM entries").use { row -> assertTrue(row.moveToFirst()); assertEquals("[\"photo\"]", row.getString(0)) }
                    it.query("SELECT mediaIds FROM drafts").use { row -> assertTrue(row.moveToFirst()); assertEquals("[\"photo\"]", row.getString(0)) }
                    it.query("SELECT filename,byteSize,checksum FROM media").use { row -> assertTrue(row.moveToFirst()); assertEquals("memory.png", row.getString(0)); assertEquals(100, row.getInt(1)); assertEquals("original-checksum", row.getString(2)) }
                }
                if (version >= 3) {
                    it.query("SELECT location,locationSearch FROM entries").use { row -> assertTrue(row.moveToFirst()); assertEquals(oldLocation, row.getString(0)); assertEquals("Original search index", row.getString(1)) }
                    it.query("SELECT location,locationAttempted FROM drafts").use { row -> assertTrue(row.moveToFirst()); assertEquals(oldLocation, row.getString(0)); assertEquals(1, row.getInt(1)) }
                }
            }
            context.deleteDatabase(name)
        }
    }
    @Test fun existingItemsShareStateAndRetainItThroughRetaggingAndUndo() {
        val tasks = repo.saveTag(null, "Tasks")
        val second = repo.saveTag(null, "Weekend", "checklist")
        val entry = post(tasks)
        rejected { repo.setCompleted(entry.id, true) }
        repo.saveTag(tasks.id, tasks.name, "checklist")
        repo.saveTag(tasks.id, "Renamed")
        assertEquals("checklist", repo.dao.tag(tasks.id)!!.type)
        repo.edit(entry.id, entry.text, listOf(tasks.id, second.id))
        val before = repo.dao.entry(entry.id)!!
        repo.setCompleted(entry.id, true)
        assertEquals(before.copy(completed = true), repo.dao.entry(entry.id))
        repo.removeTag(tasks.id)
        assertTrue(repo.dao.entry(entry.id)!!.completed)
        repo.saveTag(second.id, second.name, "standard")
        rejected { repo.setCompleted(entry.id, false) }
        repo.edit(entry.id, "Edited", emptyList())
        assertTrue(repo.dao.entry(entry.id)!!.completed)
        repo.saveTag(second.id, second.name, "checklist")
        repo.edit(entry.id, "Edited", listOf(second.id))
        val saved = repo.dao.entry(entry.id)!!
        repo.delete(entry.id); repo.restore(saved)
        assertEquals(saved, repo.dao.entry(entry.id))
        repo.setCompleted(entry.id, false)
        assertFalse(repo.dao.entry(entry.id)!!.completed)
        rejected { repo.saveTag(second.id, second.name, "invalid") }
    }
    @Test fun bothGroupsPageAcrossEqualTimesAndRefreshAfterBoundaryToggle() {
        val tag = repo.saveTag(null, "Tasks", "checklist")
        val token = "\"${tag.id}\""
        val rows = (0 until 137).map { i -> EntryRow(uid(), if (i % 3 == 0) "Read" else "Peaches", (i / 3).toLong(), 1, starred = i % 5 == 0, tagIds = jsonIds(listOf(tag.id)), completed = i % 2 == 0).also { repo.dao.insertEntry(it) } }
        val comparator = compareBy<EntryRow> { it.completed }.thenByDescending { it.createdAt }.thenByDescending { it.id }
        val all = mutableListOf<EntryRow>()
        var last: EntryRow? = null
        do {
            val page = repo.dao.checklistPage("", false, token, 50, last?.createdAt, last?.id ?: "", last?.completed ?: false)
            all.addAll(page); last = page.lastOrNull()
        } while (last != null && all.size < 200)
        assertEquals(rows.sortedWith(comparator), all)
        assertEquals(137, all.map { it.id }.distinct().size)
        assertEquals(all.filter { it.starred && it.text == "Peaches" }, repo.dao.checklistPage("PEACHES", true, token, 200, null, "", false))
        assertEquals(rows.sortedWith(compareByDescending<EntryRow> { it.createdAt }.thenByDescending { it.id }), repo.dao.page("", false, token, 200, null, ""))
        val boundary = all[99]
        repo.setCompleted(boundary.id, !boundary.completed)
        val refreshed = repo.dao.checklistPage("", false, token, 100, null, "", false)
        val cursor = refreshed.last()
        val rest = repo.dao.checklistPage("", false, token, 50, cursor.createdAt, cursor.id, cursor.completed)
        assertEquals(rows.map { if (it.id == boundary.id) it.copy(completed = !it.completed) else it }.sortedWith(comparator), refreshed + rest)
    }
    @Test fun completionAndCategoryTypeSurviveReopen() {
        val name = "checklist-reopen-${uid()}"
        val disk = Room.databaseBuilder(context, MuseamoDatabase::class.java, name).build()
        val diskRepo = Repository(disk)
        val tag = diskRepo.saveTag(null, "Tasks", "checklist")
        val entry = diskRepo.commitDraft(diskRepo.draft("app", null, tag.id).copy(text = "Task"))
        diskRepo.setCompleted(entry.id, true); disk.close()
        val reopened = Room.databaseBuilder(context, MuseamoDatabase::class.java, name).build()
        try { assertTrue(reopened.dao().entry(entry.id)!!.completed); assertEquals("checklist", reopened.dao().tag(tag.id)!!.type) }
        finally { reopened.close(); context.deleteDatabase(name) }
    }
    @Test fun streamFilterSelectsEveryChecklistTagBeforePaginationWithoutDuplicates() {
        val first = repo.saveTag(null, "Errands", "checklist")
        val second = repo.saveTag(null, "Groceries", "checklist")
        val notes = repo.saveTag(null, "Notes")
        val combinations = listOf(listOf(notes.id), listOf(first.id), listOf(second.id), listOf(first.id, second.id, notes.id))
        val rows = (0 until 137).map { i -> EntryRow(uid(), if (i % 3 == 0) "Read" else "Peaches", (i / 3).toLong(), 1, starred = i % 5 == 0, completed = i % 2 == 0, tagIds = jsonIds(combinations[i % 4])).also { repo.dao.insertEntry(it) } }
        val expected = rows.filter { first.id in ids(it.tagIds) || second.id in ids(it.tagIds) }.sortedWith(compareByDescending<EntryRow> { it.createdAt }.thenByDescending { it.id })
        val all = mutableListOf<EntryRow>()
        var last: EntryRow? = null
        do {
            val page = repo.dao.page("", false, "", 50, last?.createdAt, last?.id ?: "", checklistOnly = true)
            all.addAll(page); last = page.lastOrNull()
        } while (last != null && all.size < 200)
        assertEquals(expected, all)
        assertEquals(expected.size, all.map { it.id }.distinct().size)
        assertTrue(all.any { it.completed })
        assertEquals(expected.filter { it.starred && it.text == "Peaches" && second.id in ids(it.tagIds) }, repo.dao.page("PEACHES", true, "\"${second.id}\"", 200, null, "", checklistOnly = true))
        assertEquals(expected.drop(50).take(50), repo.dao.query("", false, "", 50, 50, checklistOnly = true))
        repo.saveTag(first.id, first.name, "standard")
        assertEquals(expected.filter { second.id in ids(it.tagIds) }, repo.dao.page("", false, "", 200, null, "", checklistOnly = true))
        repo.removeTag(second.id)
        assertTrue(repo.dao.page("", false, "", 50, null, "", checklistOnly = true).isEmpty())
        assertEquals(137, repo.dao.page("", false, "", 200, null, "").size)
    }
    @Test fun zipV4RoundTripsAndLegacyImportsDefaultWithoutChangingLocalTypes() {
        val tag = repo.saveTag(null, "Tasks", "checklist")
        val entry = post(tag); repo.setCompleted(entry.id, true)
        val output = ByteArrayOutputStream().also { MediaBackup.export(context, repo, it) }.toByteArray()
        ZipInputStream(ByteArrayInputStream(output)).use { zip -> zip.nextEntry; assertEquals(4, JSONObject(zip.readBytes().toString(Charsets.UTF_8)).getInt("version")) }
        val freshDb = Room.inMemoryDatabaseBuilder(context, MuseamoDatabase::class.java).build()
        try {
            val fresh = Repository(freshDb)
            repeat(2) { MediaBackup.import(context, fresh, ByteArrayInputStream(output)) }
            assertEquals(repo.dao.tags(), fresh.dao.tags()); assertEquals(repo.dao.entries(), fresh.dao.entries())
            fresh.saveTag(tag.id, tag.name, "standard")
            MediaBackup.import(context, fresh, ByteArrayInputStream(output))
            assertEquals("standard", fresh.dao.tag(tag.id)!!.type)
            assertTrue(fresh.dao.entry(entry.id)!!.completed)
            for (version in 1..3) {
                val legacy = manifest().put("version", version)
                legacy.getJSONArray("tags").getJSONObject(0).put("id", uid()).put("name", "Legacy $version")
                val legacyTag = legacy.getJSONArray("tags").getJSONObject(0).getString("id")
                legacy.getJSONArray("entries").getJSONObject(0).put("id", uid()).put("tagIds", org.json.JSONArray().put(legacyTag))
                if (version == 1) Backup.import(fresh, legacy.toString()) else MediaBackup.import(context, fresh, ByteArrayInputStream(archive(legacy)))
                assertEquals("standard", fresh.dao.tag(legacyTag)!!.type)
                assertFalse(fresh.dao.entries().single { legacyTag in ids(it.tagIds) }.completed)
            }
        } finally { freshDb.close() }
    }
    @Test fun invalidV4MetadataFailsBeforeAnyDatabaseChanges() {
        val tag = repo.saveTag(null, "Tasks", "checklist"); val entry = post(tag)
        val cases = listOf<(JSONObject) -> Unit>(
            { it.getJSONArray("tags").getJSONObject(0).put("type", "future") },
            { it.getJSONArray("tags").getJSONObject(0).remove("type") },
            { it.getJSONArray("entries").getJSONObject(0).put("completed", "true") },
            { it.getJSONArray("entries").getJSONObject(0).remove("completed") }
        )
        cases.forEach { change ->
            val root = manifest(); change(root)
            try { MediaBackup.import(context, repo, ByteArrayInputStream(archive(root))); fail("Expected invalid metadata") } catch (_: Exception) {}
            assertEquals(listOf(tag), repo.dao.tags()); assertEquals(listOf(entry), repo.dao.entries())
        }
    }
}
