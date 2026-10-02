package com.prdoring.museamo

import android.content.Context
import androidx.room.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

fun uid(): String = UUID.randomUUID().toString()
fun ids(json: String): List<String> = JSONArray(json).let { a -> (0 until a.length()).map { a.getString(it) } }
fun jsonIds(values: List<String>): String = JSONArray(values.distinct()).toString()

@Entity(tableName = "entries", indices = [Index(value = ["createdAt", "id"])])
data class EntryRow(@PrimaryKey val id: String, val text: String, val createdAt: Long, val updatedAt: Long, val starred: Boolean = false, val tagIds: String = "[]", val profileId: String? = null, @ColumnInfo(defaultValue = "'[]'") val mediaIds: String = "[]", val location: String? = null, @ColumnInfo(defaultValue = "''") val locationSearch: String = PostLocation.search(location), @ColumnInfo(defaultValue = "0") val completed: Boolean = false)
@Entity(tableName = "tags", indices = [Index(value = ["normalizedName"])])
data class TagRow(@PrimaryKey val id: String, val name: String, val normalizedName: String = normalizeTag(name), @ColumnInfo(defaultValue = "'standard'") val type: String = "standard")
@Entity(tableName = "profiles")
data class ProfileRow(@PrimaryKey val id: String, val label: String, val mode: String, val tagIds: String = "[]", val selectedTagId: String? = null)
@Entity(tableName = "drafts")
data class DraftRow(@PrimaryKey val profileKey: String, val entryId: String, val text: String, val tagIds: String, val profileId: String?, @ColumnInfo(defaultValue = "'[]'") val mediaIds: String = "[]", val location: String? = null, @ColumnInfo(defaultValue = "0") val locationAttempted: Boolean = false)
data class CaptureDraftOpening(val draft: DraftRow, val captureLocation: Boolean)
@Entity(tableName = "bindings")
data class BindingRow(@PrimaryKey val widgetId: Int, val profileId: String)

@Entity(tableName = "media")
data class MediaRow(@PrimaryKey val id: String, val kind: String, val mimeType: String, val filename: String, val byteSize: Long, val width: Int, val height: Int, val duration: Long?, val checksum: String)

@Dao
interface StoreDao {
    @Query("SELECT * FROM sync_metadata WHERE `key` = :key") fun syncMetadata(key: String): SyncMetadataRow?
    @Query("SELECT * FROM sync_metadata WHERE `key` LIKE :prefix") fun syncMetadataPrefix(prefix: String): List<SyncMetadataRow>
    @Upsert fun putSyncMetadata(row: SyncMetadataRow)
    @Query("DELETE FROM sync_metadata WHERE `key` = :key") fun deleteSyncMetadata(key: String)
    @Query("SELECT * FROM sync_revisions ORDER BY sequence") fun syncRevisions(): List<SyncRevisionRow>
    @Query("SELECT id,kind,entityId,origin,sequence,header,CASE WHEN payload IS NULL THEN 0 ELSE 1 END AS hasPayload FROM sync_revisions") fun syncHeaders(): List<SyncHeaderRow>
    @Query("SELECT * FROM sync_revisions WHERE id = :id") fun syncRevision(id: String): SyncRevisionRow?
    @Query("SELECT * FROM sync_revisions WHERE origin = :origin AND sequence = :sequence") fun originRevision(origin: String, sequence: Long): SyncRevisionRow?
    @Query("UPDATE sync_revisions SET header = :header WHERE id = :id") fun updateRevisionHeader(id: String, header: String)
    @Query("SELECT * FROM sync_revisions WHERE kind = :kind AND entityId = :id ORDER BY sequence DESC") fun entityRevisions(kind: String, id: String): List<SyncRevisionRow>
    @Insert fun insertSyncRevision(row: SyncRevisionRow)
    @Query("UPDATE sync_revisions SET payload = NULL WHERE id = :id") fun clearRevisionPayload(id: String)
    @Query("UPDATE sync_revisions SET payload = :payload WHERE id = :id AND payload IS NULL") fun hydrateRevisionPayload(id: String, payload: String)
    @Query("SELECT * FROM recovery ORDER BY createdAt DESC, id") fun recovery(): List<RecoveryRow>
    @Query("SELECT * FROM recovery WHERE id = :id") fun recoveryItem(id: String): RecoveryRow?
    @Insert(onConflict = OnConflictStrategy.IGNORE) fun putRecovery(row: RecoveryRow)
    @Query("DELETE FROM recovery WHERE id = :id") fun clearRecovery(id: String)
    @Query("SELECT * FROM sync_retired WHERE kind = :kind AND id = :id") fun retired(kind: String, id: String): RetiredRow?
    @Upsert fun putRetired(row: RetiredRow)
    @Query("SELECT * FROM media") fun media(): List<MediaRow>
    @Query("SELECT * FROM media WHERE id = :id") fun media(id: String): MediaRow?
    @Insert fun insertMedia(row: MediaRow)
    @Query("DELETE FROM media WHERE id = :id") fun deleteMedia(id: String)
    @Query("SELECT * FROM entries WHERE (:starred = 0 OR starred = 1) AND (:tag = '' OR instr(tagIds, :tag) > 0) AND (:search = '' OR instr(lower(text || ' ' || locationSearch), lower(:search)) > 0) AND (:located = 0 OR location IS NOT NULL) AND (:checklistOnly = 0 OR EXISTS (SELECT 1 FROM tags WHERE tags.type = 'checklist' AND instr(entries.tagIds, '\"' || tags.id || '\"') > 0)) ORDER BY createdAt DESC, id DESC LIMIT :limit OFFSET :offset")
    fun query(search: String, starred: Boolean, tag: String, limit: Int, offset: Int, located: Boolean = false, checklistOnly: Boolean = false): List<EntryRow>
    @Query("SELECT * FROM entries WHERE (:starred = 0 OR starred = 1) AND (:tag = '' OR instr(tagIds, :tag) > 0) AND (:search = '' OR instr(lower(text || ' ' || locationSearch), lower(:search)) > 0) AND (:beforeTime IS NULL OR createdAt < :beforeTime OR (createdAt = :beforeTime AND id < :beforeId)) AND (:located = 0 OR location IS NOT NULL) AND (:checklistOnly = 0 OR EXISTS (SELECT 1 FROM tags WHERE tags.type = 'checklist' AND instr(entries.tagIds, '\"' || tags.id || '\"') > 0)) ORDER BY createdAt DESC, id DESC LIMIT :limit")
    fun page(search: String, starred: Boolean, tag: String, limit: Int, beforeTime: Long?, beforeId: String, located: Boolean = false, checklistOnly: Boolean = false): List<EntryRow>
    @Query("SELECT * FROM entries WHERE (:starred = 0 OR starred = 1) AND instr(tagIds, :tag) > 0 AND (:search = '' OR instr(lower(text || ' ' || locationSearch), lower(:search)) > 0) AND (:located = 0 OR location IS NOT NULL) AND (:beforeTime IS NULL OR completed > :beforeCompleted OR (completed = :beforeCompleted AND (createdAt < :beforeTime OR (createdAt = :beforeTime AND id < :beforeId)))) ORDER BY completed ASC, createdAt DESC, id DESC LIMIT :limit OFFSET :offset")
    fun checklistPage(search: String, starred: Boolean, tag: String, limit: Int, beforeTime: Long?, beforeId: String, beforeCompleted: Boolean, located: Boolean = false, offset: Int = 0): List<EntryRow>
    @Query("SELECT COUNT(*) FROM entries WHERE instr(tagIds, :quotedTag) > 0") fun tagCount(quotedTag: String): Int
    @Query("SELECT * FROM entries ORDER BY createdAt DESC, id DESC") fun entries(): List<EntryRow>
    @Query("SELECT * FROM entries WHERE id = :id") fun entry(id: String): EntryRow?
    @Insert(onConflict = OnConflictStrategy.IGNORE) fun insertEntry(row: EntryRow): Long
    @Update fun updateEntry(row: EntryRow)
    @Query("DELETE FROM entries WHERE id = :id") fun deleteEntry(id: String)
    @Query("SELECT * FROM tags ORDER BY normalizedName, id") fun tags(): List<TagRow>
    @Query("SELECT * FROM tags WHERE id = :id") fun tag(id: String): TagRow?
    @Upsert fun putTag(row: TagRow)
    @Query("DELETE FROM tags WHERE id = :id") fun deleteTag(id: String)
    @Query("SELECT * FROM profiles ORDER BY label, id") fun profiles(): List<ProfileRow>
    @Query("SELECT * FROM profiles WHERE id = :id") fun profile(id: String): ProfileRow?
    @Upsert fun putProfile(row: ProfileRow)
    @Query("SELECT * FROM drafts WHERE profileKey = :key") fun draft(key: String): DraftRow?
    @Query("SELECT * FROM drafts") fun drafts(): List<DraftRow>
    @Upsert fun putDraft(row: DraftRow)
    @Query("DELETE FROM drafts WHERE profileKey = :key") fun deleteDraft(key: String)
    @Query("SELECT * FROM bindings WHERE widgetId = :id") fun binding(id: Int): BindingRow?
    @Query("SELECT * FROM bindings") fun bindings(): List<BindingRow>
    @Upsert fun putBinding(row: BindingRow)
    @Query("DELETE FROM bindings WHERE widgetId = :id") fun deleteBinding(id: Int)
}

@Database(entities = [EntryRow::class, TagRow::class, ProfileRow::class, DraftRow::class, BindingRow::class, MediaRow::class, SyncMetadataRow::class, SyncRevisionRow::class, RecoveryRow::class, RetiredRow::class], version = 5, exportSchema = true)
abstract class MuseamoDatabase : RoomDatabase() { abstract fun dao(): StoreDao }

class Repository(val db: MuseamoDatabase) {
    val rawDao = db.dao()
    val dao: StoreDao = RecordingDao(db, rawDao)
    init { PurgeStorage.configure(this); db.runInTransaction { rawDao.tags().forEach { row -> val normalized = normalizeTag(row.name); if (normalized != row.normalizedName) rawDao.putTag(row.copy(normalizedName = normalized)) } } }
    val mediaPins = mutableSetOf<String>()
    val deletedPins = mutableMapOf<String, List<String>>()
    fun validateMedia(values: List<String>): String {
        require(values.size <= 10 && values.distinct().size == values.size) { "Choose up to 10 different attachments." }
        require(values.all { dao.media(it) != null }) { "An attachment is missing. Select it again." }
        return jsonIds(values)
    }
    fun revision(kind: String, id: String): String? = dao.syncMetadata("head:$kind:$id")?.value ?: dao.entityRevisions(kind, id).firstOrNull()?.id
    fun requireThoughtRevision(id: String, base: String?) {
        require(base == null || base == revision("thought", id)) { "This thought changed. Your writing is preserved; reload the current revision or save as a new thought." }
    }
    fun entryJson(row: EntryRow): JSONObject = row.json().put("revision", revision("thought", row.id) ?: JSONObject.NULL).put("attachments", JSONArray(ids(row.mediaIds).map { requireNotNull(dao.media(it)).json() })).also { json -> revision("thought", row.id)?.let { id -> dao.syncRevision(id)?.payload?.let { JSONObject(it).optJSONObject("provenance")?.let { provenance -> json.put("provenance", provenance) } } } }
    fun draftJson(row: DraftRow): JSONObject = row.json().put("attachments", JSONArray(ids(row.mediaIds).map { requireNotNull(dao.media(it)).json() }))
    fun delete(id: String) { dao.entry(id)?.let { deletedPins[id] = ids(it.mediaIds) }; dao.deleteEntry(id) }
    fun references(): Set<String> = (dao.entries().flatMap { ids(it.mediaIds) } + dao.drafts().flatMap { ids(it.mediaIds) } + mediaPins + deletedPins.values.flatten() + dao.recovery().flatMap { SyncJournal.mediaIds(JSONObject(it.payload)) } + dao.syncRevisions().mapNotNull { it.payload }.flatMap { SyncJournal.mediaIds(JSONObject(it)) }).toSet()
    fun validTags(tags: List<String>): List<String> = TagAliases.map(rawDao, tags).filter { dao.tag(it) != null }
    fun saveTag(id: String?, rawName: String, type: String? = null): TagRow {
        val actualId = id?.let { TagAliases.canonical(rawDao, it) }
        val name = rawName.trim()
        require(name.isNotEmpty() && name.length <= 80) { "Use a tag name between 1 and 80 characters." }
        val normalized = normalizeTag(name)
        require(dao.tags().none { normalizeTag(it.name) == normalized && it.id != actualId }) { "A tag with this name already exists." }
        val categoryType = type ?: actualId?.let { dao.tag(it)?.type } ?: "standard"
        require(categoryType in listOf("standard", "checklist")) { "Unknown category type." }
        return TagRow(actualId ?: uid(), name, normalized, categoryType).also { dao.putTag(it) }
    }
    fun setCompleted(id: String, completed: Boolean) {
        val row = requireNotNull(dao.entry(id)) { "This thought no longer exists." }
        require(ids(row.tagIds).any { dao.tag(it)?.type == "checklist" }) { "This thought no longer belongs to a Checklist category." }
        dao.updateEntry(row.copy(completed = completed))
    }
    fun saveProfile(row: ProfileRow) {
        require(row.label.trim().isNotEmpty() && row.label.length <= 80) { "Give the widget a label (up to 80 characters)." }
        require(row.mode in listOf("fixed", "picker")) { "Unknown widget mode." }
        dao.putProfile(row.copy(label = row.label.trim(), tagIds = jsonIds(validTags(ids(row.tagIds))), selectedTagId = row.selectedTagId?.let { TagAliases.canonical(rawDao, it) }?.takeIf { dao.tag(it) != null }))
    }
    fun removeTag(originalId: String) = db.runInTransaction {
        val id = TagAliases.canonical(rawDao, originalId)
        dao.deleteTag(id)
        dao.entries().filter { id in ids(it.tagIds) }.forEach { rawDao.updateEntry(it.copy(tagIds = jsonIds(ids(it.tagIds) - id))) }
        dao.profiles().forEach { dao.putProfile(it.copy(tagIds = jsonIds(ids(it.tagIds) - id), selectedTagId = it.selectedTagId?.takeUnless { value -> value == id })) }
        dao.drafts().forEach { dao.putDraft(it.copy(tagIds = jsonIds(ids(it.tagIds) - id))) }
    }
    fun draft(key: String, profile: ProfileRow?, initialTag: String?): DraftRow {
        dao.draft(key)?.let { return it }
        val defaults = if (profile?.mode == "picker") listOfNotNull(profile.selectedTagId) else profile?.let { ids(it.tagIds) } ?: listOfNotNull(initialTag)
        return DraftRow(key, uid(), "", jsonIds(validTags(defaults)), profile?.id).also { dao.putDraft(it) }
    }
    /** A blank new compose needs a new fix; unfinished drafts and Activity recreation keep their choices. */
    fun prepareCaptureDraft(key: String, profile: ProfileRow?, initialTag: String?, resuming: Boolean): CaptureDraftOpening {
        val existing = dao.draft(key)
        val saved = existing ?: draft(key, profile, initialTag)
        val newBlankCompose = !resuming && saved.text.isBlank() && ids(saved.mediaIds).isEmpty()
        val prepared = if (newBlankCompose) saved.copy(location = null, locationAttempted = false).also { dao.putDraft(it) } else saved
        return CaptureDraftOpening(prepared, (existing == null || newBlankCompose) && !prepared.locationAttempted)
    }
    fun saveDraft(row: DraftRow) { validateMedia(ids(row.mediaIds)); if (dao.entry(row.entryId) == null) dao.putDraft(row.copy(tagIds = jsonIds(validTags(ids(row.tagIds))))) }
    fun inlineTags(text: String): List<String> = Hashtags.names(text).map { name -> (dao.tags().find { normalizeTag(it.name) == normalizeTag(name) } ?: saveTag(null, name)).id }
    fun commitDraft(row: DraftRow): EntryRow {
        require(row.text.isNotBlank() || ids(row.mediaIds).isNotEmpty()) { "Add text or an attachment." }; validateMedia(ids(row.mediaIds))
        var result: EntryRow? = null
        db.runInTransaction {
            result = dao.entry(row.entryId) ?: run {
                val hashtagIds = Hashtags.names(row.text).map { name ->
                    dao.tags().find { normalizeTag(it.name) == normalizeTag(name) } ?: saveTag(null, name)
                }.map { it.id }
                EntryRow(row.entryId, row.text, System.currentTimeMillis(), System.currentTimeMillis(), tagIds = jsonIds(validTags(ids(row.tagIds)) + hashtagIds), profileId = row.profileId?.takeIf { dao.profile(it) != null }, mediaIds = row.mediaIds, location = row.location).also { dao.insertEntry(it) }
            }
            if (dao.draft(row.profileKey)?.entryId == row.entryId) dao.deleteDraft(row.profileKey)
        }
        return result!!
    }
    fun edit(id: String, text: String, tags: List<String>, media: List<String>? = null, location: String? = null, updateLocation: Boolean = false) {
        val old = requireNotNull(dao.entry(id)) { "This thought no longer exists." }
        val mediaIds = validateMedia(media ?: ids(old.mediaIds))
        require(text.isNotBlank() || ids(mediaIds).isNotEmpty()) { "Add text or an attachment." }
        db.runInTransaction { dao.updateEntry(old.copy(locationSearch = if (updateLocation) PostLocation.search(location) else old.locationSearch, location = if (updateLocation) location else old.location, text = text, mediaIds = mediaIds, tagIds = jsonIds(validTags(tags) + Hashtags.names(text).filter { name -> Hashtags.names(old.text).none { normalizeTag(it) == normalizeTag(name) } || ids(old.tagIds).any { dao.tag(it)?.name?.let { oldName -> normalizeTag(oldName) == normalizeTag(name) } == true } }.map { name -> (dao.tags().find { normalizeTag(it.name) == normalizeTag(name) } ?: saveTag(null, name)).id }), updatedAt = System.currentTimeMillis())) }
    }
    fun enrichLocation(id: String, original: String, enriched: String): Boolean {
        val entry = dao.entry(id) ?: return false
        if (entry.location != original || enriched == original) return false
        dao.updateEntry(entry.copy(location = enriched, locationSearch = PostLocation.search(enriched)))
        return true
    }
    fun restore(row: EntryRow, suppliedProvenance: JSONObject? = null): EntryRow {
        validateMedia(ids(row.mediaIds))
        deletedPins.remove(row.id)
        var restored: EntryRow? = null
        db.runInTransaction {
            val next = row.copy(id = uid(), tagIds = jsonIds(validTags(ids(row.tagIds)) + inlineTags(row.text)), profileId = row.profileId?.takeIf { dao.profile(it) != null })
            val provenance = suppliedProvenance ?: revision("thought", row.id)?.let { id -> dao.syncRevision(id)?.payload?.let { JSONObject(it).optJSONObject("provenance") } }
            provenance?.let { rawDao.putSyncMetadata(SyncMetadataRow("provenance:thought:${next.id}", it.toString())) }
            dao.insertEntry(next); restored = next
        }
        return requireNotNull(restored)
    }
}

fun normalizeTag(name: String): String = if (SyncCore.available()) SyncCore.request(JSONObject().put("action", "normalizeTag").put("name", name)).getString("name") else java.text.Normalizer.normalize(name.trim(), java.text.Normalizer.Form.NFC).lowercase(java.util.Locale.ROOT)

val MEDIA_MIGRATION = object : androidx.room.migration.Migration(1, 2) {
    override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE entries ADD COLUMN mediaIds TEXT NOT NULL DEFAULT '[]'")
        db.execSQL("ALTER TABLE drafts ADD COLUMN mediaIds TEXT NOT NULL DEFAULT '[]'")
        db.execSQL("CREATE TABLE IF NOT EXISTS media (id TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL, mimeType TEXT NOT NULL, filename TEXT NOT NULL, byteSize INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, duration INTEGER, checksum TEXT NOT NULL)")
    }
}
val LOCATION_MIGRATION = object : androidx.room.migration.Migration(2, 3) {
    override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE entries ADD COLUMN location TEXT")
        db.execSQL("ALTER TABLE entries ADD COLUMN locationSearch TEXT NOT NULL DEFAULT ''")
        db.execSQL("ALTER TABLE drafts ADD COLUMN location TEXT")
        db.execSQL("ALTER TABLE drafts ADD COLUMN locationAttempted INTEGER NOT NULL DEFAULT 0")
    }
}
val CHECKLIST_MIGRATION = object : androidx.room.migration.Migration(3, 4) {
    override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE tags ADD COLUMN type TEXT NOT NULL DEFAULT 'standard'")
        db.execSQL("ALTER TABLE entries ADD COLUMN completed INTEGER NOT NULL DEFAULT 0")
    }
}
val SYNC_MIGRATION = object : androidx.room.migration.Migration(4, 5) {
    override fun migrate(db: androidx.sqlite.db.SupportSQLiteDatabase) {
        db.execSQL("DROP INDEX IF EXISTS index_tags_normalizedName")
        db.execSQL("CREATE INDEX index_tags_normalizedName ON tags(normalizedName)")
        db.execSQL("CREATE TABLE sync_metadata (`key` TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)")
        db.execSQL("CREATE TABLE sync_revisions (id TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL, entityId TEXT NOT NULL, origin TEXT NOT NULL, sequence INTEGER NOT NULL, header TEXT NOT NULL, payload TEXT)")
        db.execSQL("CREATE INDEX index_sync_revisions_kind_entityId ON sync_revisions(kind,entityId)")
        db.execSQL("CREATE TABLE recovery (id TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL, entityId TEXT NOT NULL, payload TEXT NOT NULL, createdAt INTEGER NOT NULL)")
        db.execSQL("CREATE TABLE sync_retired (kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(kind,id))")
    }
}
object Store {
    val executor = Executors.newSingleThreadExecutor()
    @Volatile private var repository: Repository? = null
    fun get(context: Context): Repository = repository ?: synchronized(this) {
        repository ?: Repository(Room.databaseBuilder(context.applicationContext, MuseamoDatabase::class.java, "museamo.db").addMigrations(MEDIA_MIGRATION, LOCATION_MIGRATION, CHECKLIST_MIGRATION, SYNC_MIGRATION).build()).also { SyncJournal.configure(SyncIdentity(context.applicationContext)); MediaFiles(context, it).apply { recoverInterruptedImports(); cleanup() }; repository = it }
    }
    fun changed(context: Context, localMutation: Boolean = true) {
        context.sendBroadcast(android.content.Intent("com.prdoring.museamo.DATA_CHANGED").setPackage(context.packageName))
        CaptureWidget.refresh(context)
        if (localMutation) SyncRuntime.localDataChanged()
    }
}

fun EntryRow.json(): JSONObject = JSONObject().put("id", id).put("text", text).put("createdAt", createdAt).put("updatedAt", updatedAt).put("starred", starred).put("completed", completed).put("tagIds", JSONArray(tagIds)).put("profileId", profileId ?: JSONObject.NULL).put("attachmentIds", JSONArray(mediaIds)).put("location", location?.let { JSONObject(it) } ?: JSONObject.NULL)
fun TagRow.json(): JSONObject = JSONObject().put("id", id).put("name", name).put("type", type)
fun ProfileRow.json(): JSONObject = JSONObject().put("id", id).put("label", label).put("mode", mode).put("tagIds", JSONArray(tagIds)).put("selectedTagId", selectedTagId ?: JSONObject.NULL)
fun DraftRow.json(): JSONObject = JSONObject().put("locationAttempted", locationAttempted).put("profileKey", profileKey).put("entryId", entryId).put("text", text).put("tagIds", JSONArray(tagIds)).put("profileId", profileId ?: JSONObject.NULL).put("attachmentIds", JSONArray(mediaIds)).put("location", location?.let { JSONObject(it) } ?: JSONObject.NULL)

fun MediaRow.json(): JSONObject = JSONObject().put("id", id).put("kind", kind).put("mimeType", mimeType).put("filename", filename).put("byteSize", byteSize).put("width", width).put("height", height).put("duration", duration ?: JSONObject.NULL).put("checksum", checksum)
