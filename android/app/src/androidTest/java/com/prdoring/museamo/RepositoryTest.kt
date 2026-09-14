package com.prdoring.museamo

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RepositoryTest {
    private lateinit var db: MuseamoDatabase
    private lateinit var repo: Repository
    @Before fun setup() { db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), MuseamoDatabase::class.java).build(); repo = Repository(db) }
    @After fun close() { db.close() }
    @Test fun draftsAreIndependentAndKeepTheirTagsWhenPickerChanges() {
        val words = repo.saveTag(null, "Words"); val thoughts = repo.saveTag(null, "Thoughts")
        val first = ProfileRow(uid(), "Words", "picker", selectedTagId = words.id)
        val second = ProfileRow(uid(), "General", "fixed")
        repo.saveProfile(first); repo.saveProfile(second)
        val draft = repo.draft(first.id, first, null).copy(text = "Apricity")
        repo.saveDraft(draft)
        repo.saveProfile(first.copy(selectedTagId = thoughts.id))
        assertEquals(listOf(words.id), ids(repo.draft(first.id, repo.dao.profile(first.id), null).tagIds))
        assertEquals("", repo.draft(second.id, second, null).text)
        assertEquals(emptyList<String>(), ids(repo.draft(second.id, second, null).tagIds))
        repo.commitDraft(draft)
        assertEquals(listOf(thoughts.id), ids(repo.draft(first.id, repo.dao.profile(first.id), null).tagIds))
    }
    @Test fun duplicateSendAndLateDraftWriteCannotResurrectCommittedDraft() {
        val draft = repo.draft("general", null, null).copy(text = "A passing thought")
        repo.saveDraft(draft)
        val first = repo.commitDraft(draft); val second = repo.commitDraft(draft)
        repo.saveDraft(draft)
        assertEquals(first.id, second.id); assertEquals(1, repo.dao.entries().size); assertNull(repo.dao.draft("general"))
    }
    @Test fun failedSaveRetainsDraft() {
        val draft = repo.draft("general", null, null).copy(text = " ")
        repo.saveDraft(draft)
        try { repo.commitDraft(draft); fail("Expected blank validation") } catch (_: IllegalArgumentException) {}
        assertNotNull(repo.dao.draft("general")); assertEquals(0, repo.dao.entries().size)
    }
    @Test fun sendingHashtagsReusesExistingTagsAndCreatesNewOnesOnce() {
        val existing = repo.saveTag(null, "Words")
        val draft = repo.draft("hashtags", null, null).copy(text = "A thought #words #fresh #FRESH", tagIds = jsonIds(listOf(existing.id)))
        val entry = repo.commitDraft(draft)
        repo.commitDraft(draft)
        assertEquals(2, repo.dao.tags().size)
        assertEquals(2, ids(entry.tagIds).size)
        assertTrue(existing.id in ids(entry.tagIds))
        assertEquals(draft.text, entry.text)
        assertNull(repo.dao.draft("hashtags"))
    }
    @Test fun tagDeletionCleansEntriesProfilesDraftsAndPickerWithoutDeletingThought() {
        val tag = repo.saveTag(null, "Original")
        val p = ProfileRow(uid(), "Widget", "picker", jsonIds(listOf(tag.id)), tag.id); repo.saveProfile(p)
        val draft = repo.draft(p.id, p, null).copy(text = "Keep me")
        repo.commitDraft(draft); repo.draft(p.id, p, null)
        repo.saveTag(tag.id, "Renamed")
        assertEquals(listOf(tag.id), ids(repo.dao.entries().single().tagIds))
        repo.removeTag(tag.id)
        assertEquals("Keep me", repo.dao.entries().single().text)
        assertEquals("[]", repo.dao.entries().single().tagIds)
        assertNull(repo.dao.profile(p.id)!!.selectedTagId)
        assertEquals("[]", repo.dao.draft(p.id)!!.tagIds)
    }
    @Test fun backupRoundTripSkipsIdenticalAndPreservesConflictsWithoutBindingsOrDrafts() {
        val tag = repo.saveTag(null, "Words")
        val p = ProfileRow(uid(), "Words widget", "fixed", jsonIds(listOf(tag.id))); repo.saveProfile(p)
        repo.saveProfile(p.copy(id = uid())) // Equal defaults still represent independent widget profiles.
        repo.dao.putBinding(BindingRow(42, p.id))
        val entry = repo.commitDraft(repo.draft(p.id, p, null).copy(text = "Original"))
        repo.dao.updateEntry(entry.copy(starred = true))
        repo.draft(p.id, p, null)
        val backup = Backup.export(repo)
        assertFalse(JSONObject(backup).has("drafts")); assertFalse(JSONObject(backup).has("bindings"))
        Backup.import(repo, backup); assertEquals(1, repo.dao.entries().size)
        repo.edit(entry.id, "Local edit", listOf(tag.id))
        Backup.import(repo, backup); Backup.import(repo, backup)
        assertEquals(setOf("Original", "Local edit"), repo.dao.entries().map { it.text }.toSet())
        assertEquals(2, repo.dao.entries().size)
        val freshDb = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), MuseamoDatabase::class.java).build()
        try { val fresh = Repository(freshDb); Backup.import(fresh, backup); assertEquals(2, fresh.dao.profiles().size); assertTrue(fresh.dao.entries().single().starred); assertTrue(fresh.dao.bindings().isEmpty()); assertTrue(fresh.dao.drafts().isEmpty()) } finally { freshDb.close() }
    }
    @Test fun invalidImportLeavesEverythingUnchanged() {
        repo.commitDraft(repo.draft("app", null, null).copy(text = "Safe"))
        val before = Backup.export(repo)
        val invalid = JSONObject(before)
        invalid.getJSONArray("entries").getJSONObject(0).put("tagIds", JSONArray(listOf(uid())))
        try { Backup.import(repo, invalid.toString()); fail("Expected dangling reference error") } catch (_: IllegalArgumentException) {}
        assertEquals("Safe", repo.dao.entries().single().text); assertTrue(repo.dao.tags().isEmpty())
    }
    @Test fun queryCombinesFiltersAndPagination() {
        val words = repo.saveTag(null, "Words")
        repeat(4) { i -> repo.dao.insertEntry(EntryRow(uid(), "word $i", i.toLong(), i.toLong(), i % 2 == 0, jsonIds(listOf(words.id)))) }
        assertEquals(listOf("word 2", "word 0"), repo.dao.query("WORD", true, "\"${words.id}\"", 10, 0).map { it.text })
        assertEquals(listOf("word 2", "word 1"), repo.dao.query("", false, "", 2, 1).map { it.text })
    }
    @Test fun diskDatabaseSurvivesCloseAndReopen() {
        val context = ApplicationProvider.getApplicationContext<Context>(); val name = "test-${uid()}.db"
        val disk = Room.databaseBuilder(context, MuseamoDatabase::class.java, name).build()
        try { Repository(disk).commitDraft(Repository(disk).draft("app", null, null).copy(text = "Durable")) } finally { disk.close() }
        val reopened = Room.databaseBuilder(context, MuseamoDatabase::class.java, name).build()
        try { assertEquals("Durable", reopened.dao().entries().single().text) } finally { reopened.close(); context.deleteDatabase(name) }
    }
    @Test fun cursorPaginationDoesNotRepeatAfterNewSave() {
        val time = System.currentTimeMillis()
        listOf("a", "b", "c").forEach { repo.dao.insertEntry(EntryRow(it, it, time, time)) }
        val first = repo.dao.page("", false, "", 2, null, "")
        repo.dao.insertEntry(EntryRow("new", "new", time + 1, time + 1))
        val next = repo.dao.page("", false, "", 2, first.last().createdAt, first.last().id)
        assertEquals(listOf("c", "b"), first.map { it.id })
        assertEquals(listOf("a"), next.map { it.id })
    }
    @Test fun formattingSurvivesDraftSaveEditAndBackup() {
        val markdown = "    indented text\n\n**Word**\n_noun_\n\n- A definition\n- Another meaning\n\n> A quote"
        val draft = repo.draft("formatting", null, null).copy(text = markdown)
        repo.saveDraft(draft)
        assertEquals(markdown, repo.dao.draft("formatting")!!.text)
        val entry = repo.commitDraft(draft)
        assertEquals(markdown, entry.text)
        val changed = "$markdown\n\n[Source](<https://example.com/definition>)"
        repo.edit(entry.id, changed, emptyList())
        val backup = Backup.export(repo)
        repo.dao.deleteEntry(entry.id)
        Backup.import(repo, backup)
        assertEquals(changed, repo.dao.entry(entry.id)!!.text)
    }
    @Test fun editingDoesNotRecreateRenamedInlineTag() {
        val tag = repo.saveTag(null, "Cool words")
        val entry = repo.commitDraft(repo.draft("rename-inline", null, null).copy(text = "Hello #\"Cool words\""))
        repo.saveTag(tag.id, "Vocabulary")
        repo.edit(entry.id, entry.text + " revised", listOf(tag.id))
        assertEquals(1, repo.dao.tags().size)
        assertEquals(listOf(tag.id), ids(repo.dao.entry(entry.id)!!.tagIds))
    }
}
