package com.prdoring.museamo

import android.content.Context
import android.location.Address
import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.Locale

class LocationStorageTest {
    @get:Rule val migration = MigrationTestHelper(InstrumentationRegistry.getInstrumentation(), MuseamoDatabase::class.java)
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private lateinit var db: MuseamoDatabase
    private lateinit var repo: Repository
    private fun location() = PostLocation.parse(JSONObject().put("latitude", 0).put("longitude", 0).put("capturedAt", 1).put("accuracy", 100).put("token", uid()))!!
    @Before fun setup() { db = Room.inMemoryDatabaseBuilder(context, MuseamoDatabase::class.java).build(); repo = Repository(db) }
    @After fun cleanup() { db.close() }
    @Test fun migratesBothPreviousSchemasWithoutLosingDrafts() {
        for (version in listOf(1, 2)) {
            val name = "location-migration-${uid()}"
            migration.createDatabase(name, version).use {
                it.execSQL("INSERT INTO entries (id,text,createdAt,updatedAt,starred,tagIds,profileId) VALUES ('old','Keep me',1,1,0,'[]',NULL)")
                it.execSQL("INSERT INTO drafts (profileKey,entryId,text,tagIds,profileId) VALUES ('widget','draft','Still writing','[]',NULL)")
            }
            migration.runMigrationsAndValidate(name, 3, true, MEDIA_MIGRATION, LOCATION_MIGRATION).use { migrated ->
                migrated.query("SELECT text, location FROM entries").use { assertTrue(it.moveToFirst()); assertEquals("Keep me", it.getString(0)); assertTrue(it.isNull(1)) }
                migrated.query("SELECT text, location, locationAttempted FROM drafts").use { assertTrue(it.moveToFirst()); assertEquals("Still writing", it.getString(0)); assertTrue(it.isNull(1)); assertEquals(0, it.getInt(2)) }
            }
            context.deleteDatabase(name)
        }
    }
    @Test fun namingCascadeRetainsCoordinatesAndDoesNotTreatHouseNumberAsVenue() {
        val raw = location()
        assertEquals("Saved location", PostLocation.label(PostLocation.enrich(raw, null)))
        val address = Address(Locale.US).apply { locality = "Town"; adminArea = "Region" }
        assertEquals("Town, Region", PostLocation.label(PostLocation.enrich(raw, address)))
        address.thoroughfare = "Main Street"; address.featureName = "10"; address.setAddressLine(0, "10 Main Street")
        assertEquals("10 Main Street", PostLocation.label(PostLocation.enrich(raw, address)))
        address.featureName = "Museum"
        val enriched = PostLocation.enrich(raw, address)
        assertEquals("Museum", PostLocation.label(enriched))
        assertEquals(0.0, JSONObject(enriched).getDouble("latitude"), 0.0)
        assertEquals("My place", PostLocation.label(JSONObject(enriched).put("userLabel", "My place").toString()))
    }
    @Test fun draftUndoAndLateNamingRespectRemovalAndManualEdits() {
        val raw = location(); val enriched = JSONObject(raw).put("locality", "Town").toString()
        val draft = repo.draft("widget", null, null).copy(text = "Lunch", location = raw, locationAttempted = true)
        repo.saveDraft(draft); assertEquals(draft, repo.draft("widget", null, null))
        val entry = repo.commitDraft(draft)
        assertTrue(repo.enrichLocation(entry.id, raw, enriched))
        repo.edit(entry.id, "Edited", emptyList())
        assertEquals(enriched, repo.dao.entry(entry.id)!!.location)
        val saved = repo.dao.entry(entry.id)!!
        repo.delete(entry.id); assertFalse(repo.enrichLocation(entry.id, enriched, raw)); repo.restore(saved)
        assertEquals(enriched, repo.dao.entry(entry.id)!!.location)
        val manual = JSONObject(enriched).put("userLabel", "My place").toString()
        repo.edit(entry.id, "Edited", emptyList(), location = manual, updateLocation = true)
        assertFalse(repo.enrichLocation(entry.id, enriched, raw))
        repo.edit(entry.id, "Edited", emptyList(), location = null, updateLocation = true)
        assertFalse(repo.enrichLocation(entry.id, enriched, raw)); assertNull(repo.dao.entry(entry.id)!!.location)
    }
    @Test fun archiveV3RoundTripAndLegacyImports() {
        val entry = repo.commitDraft(repo.draft("app", null, null).copy(text = "A place", location = location()))
        val archive = ByteArrayOutputStream().also { MediaBackup.export(context, repo, it) }.toByteArray()
        repo.dao.deleteEntry(entry.id)
        repeat(2) { MediaBackup.import(context, repo, ByteArrayInputStream(archive)) }
        assertEquals(listOf(entry), repo.dao.entries())
        val legacy = JSONObject(Backup.export(repo)).put("entries", org.json.JSONArray().put(entry.copy(id = uid()).json()))
        Backup.import(repo, legacy.toString())
        assertEquals(1, repo.dao.entries().count { it.location == null })
        val v2 = JSONObject(legacy.toString()).put("version", 2)
        v2.getJSONArray("entries").getJSONObject(0).put("id", uid())
        Backup.import(repo, v2.toString(), withMedia = true)
        assertEquals(2, repo.dao.entries().count { it.location == null })
    }
    @Test fun rejectsInvalidCoordinatesAndTypes() {
        for (value in listOf(JSONObject(location()).put("latitude", 91), JSONObject(location()).put("longitude", -181), JSONObject(location()).put("latitude", "0"), JSONObject(location()).put("accuracy", -1))) {
            try { PostLocation.parse(value); fail("Invalid location accepted") } catch (_: IllegalArgumentException) {}
        }
    }
    @Test fun locatedQueryCombinesFiltersAndCursor() {
        val tag = repo.saveTag(null, "Food")
        repeat(5) { i -> repo.dao.insertEntry(EntryRow(uid(), "Lunch", i.toLong(), i.toLong(), starred = true, tagIds = jsonIds(listOf(tag.id)), location = if (i % 2 == 0) JSONObject(location()).put("locality", "Town").toString() else null)) }
        val first = repo.dao.page("Town", true, "\"${tag.id}\"", 2, null, "", true)
        assertEquals(2, first.size)
        val second = repo.dao.page("Town", true, "\"${tag.id}\"", 2, first.last().createdAt, first.last().id, true)
        assertEquals(1, second.size)
    }
}
