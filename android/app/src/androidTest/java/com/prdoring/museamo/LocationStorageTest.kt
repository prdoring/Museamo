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
        assertEquals("Town, Region", PostLocation.label(PostLocation.enrich(raw, address)))
        address.featureName = "Museum"
        val enriched = PostLocation.enrich(raw, address)
        assertEquals("Museum, Town, Region", PostLocation.label(enriched))
        assertEquals(0.0, JSONObject(enriched).getDouble("latitude"), 0.0)
        assertEquals("My place, Town, Region", PostLocation.label(JSONObject(enriched).put("userLabel", "My place").toString()))
    }
    @Test fun shortLabelsRetainTheFullAddressAndStructuredPlaceFields() {
        val address = Address(Locale.US).apply {
            featureName = "Trader Joe's"; locality = "Portland"; adminArea = "Oregon"; countryName = "United States"; countryCode = "US"
            subThoroughfare = "123"; thoroughfare = "Main Street"; postalCode = "97205"
            setAddressLine(0, "123 Main Street, Portland, OR 97205, USA")
        }
        val full = address.getAddressLine(0)
        val enriched = PostLocation.parse(JSONObject(PostLocation.enrich(location(), address)))!!
        assertEquals("Trader Joe's, Portland OR", PostLocation.label(enriched))
        assertEquals(full, JSONObject(enriched).getString("address"))
        assertEquals("Portland", JSONObject(enriched).getString("city"))
        assertEquals("Oregon", JSONObject(enriched).getString("region"))
        assertEquals("US", JSONObject(enriched).getString("countryCode"))
        assertTrue(PostLocation.search(enriched).contains(full))
        address.featureName = full
        assertEquals("Portland OR", PostLocation.label(PostLocation.enrich(location(), address)))
        address.featureName = "123 Main Street"
        assertEquals("Portland OR", PostLocation.label(PostLocation.enrich(location(), address)))
        address.featureName = "Museum"; address.locality = "Antwerp"; address.adminArea = "Flanders"; address.countryCode = "BE"; address.countryName = "Belgium"
        address.setAddressLine(0, "123 Museumstraat, 2000 Antwerp, Belgium")
        val international = PostLocation.parse(JSONObject(PostLocation.enrich(location(), address)))!!
        assertEquals("Museum, Antwerp, Belgium", PostLocation.label(international))
        assertEquals(address.getAddressLine(0), JSONObject(international).getString("address"))
        val entry = repo.commitDraft(repo.draft("app", null, null).copy(text = "Keep this memory", location = international))
        val expected = repo.dao.entry(entry.id)!!
        val archive = ByteArrayOutputStream().also { MediaBackup.export(context, repo, it) }.toByteArray()
        val freshDb = Room.inMemoryDatabaseBuilder(context, MuseamoDatabase::class.java).build()
        try {
            val fresh = Repository(freshDb)
            repeat(2) { MediaBackup.import(context, fresh, ByteArrayInputStream(archive)) }
            assertEquals(listOf(expected), fresh.dao.entries())
            fresh.edit(entry.id, "Edited memory", emptyList())
            assertEquals(international, fresh.dao.entry(entry.id)!!.location)
            val saved = fresh.dao.entry(entry.id)!!
            fresh.delete(saved.id); val restored = fresh.restore(saved)
            assertEquals(saved.copy(id = restored.id), fresh.dao.entry(restored.id))
            assertEquals(listOf(restored), fresh.dao.page("Museumstraat", false, "", 50, null, ""))
        } finally { freshDb.close() }
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
        repo.delete(entry.id); assertFalse(repo.enrichLocation(entry.id, enriched, raw)); val restored = repo.restore(saved)
        assertEquals(enriched, repo.dao.entry(restored.id)!!.location)
        val manual = JSONObject(enriched).put("userLabel", "My place").toString()
        repo.edit(restored.id, "Edited", emptyList(), location = manual, updateLocation = true)
        assertFalse(repo.enrichLocation(restored.id, enriched, raw))
        repo.edit(restored.id, "Edited", emptyList(), location = null, updateLocation = true)
        assertFalse(repo.enrichLocation(restored.id, enriched, raw)); assertNull(repo.dao.entry(restored.id)!!.location)
    }
    @Test fun blankCaptureOpeningClearsOldLocationAndRetriesWithoutChangingGenericDraftAccess() {
        val tag = repo.saveTag(null, "Location opening")
        val profile = ProfileRow(uid(), "Location opening", "fixed", jsonIds(listOf(tag.id))).also { repo.saveProfile(it) }
        val raw = JSONObject(location()).put("capturedAt", 1790274033367L).put("locality", "Denver").toString()
        val old = repo.draft(profile.id, profile, null).copy(text = "  \n", location = raw, locationAttempted = true)
        repo.saveDraft(old)
        assertEquals("Ordinary draft reads must preserve stored metadata", old, repo.draft(profile.id, profile, null))
        val opening = repo.prepareCaptureDraft(profile.id, profile, null, resuming = false)
        assertTrue("A blank new compose must try the current fix", opening.captureLocation)
        assertEquals(old.copy(location = null, locationAttempted = false), opening.draft)
        assertEquals(opening.draft, repo.dao.draft(profile.id))
        val fresh = repo.prepareCaptureDraft("new", null, tag.id, resuming = false)
        assertTrue(fresh.captureLocation)
        assertEquals(jsonIds(listOf(tag.id)), fresh.draft.tagIds)
        assertNull(fresh.draft.location)
    }
    @Test fun unfinishedTextAndAttachmentDraftsKeepTheirOriginalLocationAndSkipChoice() {
        val media = MediaRow(uid(), "image", "image/heic", "original.heic", 3, 0, 0, null, "0".repeat(64)).also { repo.dao.insertMedia(it) }
        val raw = JSONObject(location()).put("userLabel", "Chosen place").toString()
        val drafts = listOf(
            repo.draft("text", null, null).copy(text = "Still writing", location = raw, locationAttempted = true),
            repo.draft("attachment", null, null).copy(mediaIds = jsonIds(listOf(media.id)), location = raw, locationAttempted = true),
            repo.draft("skipped", null, null).copy(text = "No location for this post", locationAttempted = true),
            repo.draft("not-attempted", null, null).copy(text = "Imported unfinished draft")
        )
        drafts.forEach { saved ->
            repo.saveDraft(saved)
            val opening = repo.prepareCaptureDraft(saved.profileKey, null, null, resuming = false)
            assertEquals(saved, opening.draft)
            assertFalse("Opening real unfinished content must preserve location intent", opening.captureLocation)
        }
    }
    @Test fun resumingBlankCompositionPreservesCapturedLocationAndExplicitRemoval() {
        val raw = JSONObject(location()).put("userLabel", "Current composition place").toString()
        val captured = repo.draft("resume", null, null).copy(location = raw, locationAttempted = true)
        repo.saveDraft(captured)
        val resumed = repo.prepareCaptureDraft("resume", null, null, resuming = true)
        assertEquals(captured, resumed.draft)
        assertFalse(resumed.captureLocation)
        val removed = captured.copy(location = null)
        repo.saveDraft(removed)
        val skipped = repo.prepareCaptureDraft("resume", null, null, resuming = true)
        assertEquals(removed, skipped.draft)
        assertFalse(skipped.captureLocation)
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
        for (value in listOf(JSONObject(location()).put("latitude", 91), JSONObject(location()).put("longitude", -181), JSONObject(location()).put("latitude", "0"), JSONObject(location()).put("accuracy", -1), JSONObject(location()).put("country", 7), JSONObject(location()).put("city", "x".repeat(501)))) {
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
