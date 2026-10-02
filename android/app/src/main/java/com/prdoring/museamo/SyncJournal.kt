package com.prdoring.museamo

import androidx.room.*
import org.json.JSONObject
import org.json.JSONArray
import java.security.MessageDigest

@Entity(tableName = "sync_metadata")
data class SyncMetadataRow(@PrimaryKey val key: String, val value: String)
@Entity(tableName = "sync_revisions", indices = [Index(value = ["kind", "entityId"])])
data class SyncRevisionRow(@PrimaryKey val id: String, val kind: String, val entityId: String, val origin: String, val sequence: Long, val header: String, val payload: String?)
/** Header-only queries avoid materializing every private thought body for receipt checks. */
data class SyncHeaderRow(val id: String, val kind: String, val entityId: String, val origin: String, val sequence: Long, val header: String, val hasPayload: Boolean)
@Entity(tableName = "recovery")
data class RecoveryRow(@PrimaryKey val id: String, val kind: String, val entityId: String, val payload: String, val createdAt: Long)
@Entity(tableName = "sync_retired", primaryKeys = ["kind", "id"])
data class RetiredRow(val kind: String, val id: String)

/** Recorder wraps every DAO saved-data write, including imports and asynchronous enrichment. */
class RecordingDao(private val db: MuseamoDatabase, private val delegate: StoreDao) : StoreDao by delegate {
    override fun insertEntry(row: EntryRow): Long {
        var result = -1L
        db.runInTransaction {
            require(delegate.retired("thought", row.id) == null) { "This thought was permanently cleared. Save it as a new thought." }
            result = delegate.insertEntry(row)
            if (result != -1L) SyncJournal.record(delegate, "thought", row.id, payload(row), false)
        }
        return result
    }
    override fun updateEntry(row: EntryRow) = db.runInTransaction {
        val old = delegate.entry(row.id) ?: return@runInTransaction
        if (old == row) return@runInTransaction
        recover("thought", row.id, payload(old))
        delegate.updateEntry(row)
        SyncJournal.record(delegate, "thought", row.id, payload(row), false)
    }
    override fun deleteEntry(id: String) = db.runInTransaction {
        val old = delegate.entry(id) ?: return@runInTransaction
        recover("thought", id, payload(old))
        delegate.deleteEntry(id)
        SyncJournal.record(delegate, "thought", id, payload(old), true)
    }
    override fun putTag(row: TagRow) = db.runInTransaction {
        val old = delegate.tag(row.id)
        if (old == row) return@runInTransaction
        old?.let { recover("tag", row.id, it.json()) }
        delegate.putTag(row)
        SyncJournal.record(delegate, "tag", row.id, row.json(), false)
    }
    override fun deleteTag(id: String) = db.runInTransaction {
        val old = delegate.tag(id) ?: return@runInTransaction
        recover("tag", id, old.json())
        delegate.deleteTag(id)
        SyncJournal.record(delegate, "tag", id, old.json(), true)
    }
    private fun payload(row: EntryRow): JSONObject = row.json().put("attachments", JSONArray(ids(row.mediaIds).map { requireNotNull(delegate.media(it)).json() })).also {
        val prior = delegate.syncMetadata("head:thought:${row.id}")?.value?.let { id -> delegate.syncRevision(id)?.payload?.let { body -> JSONObject(body).optJSONObject("provenance") } }
            ?: delegate.syncMetadata("provenance:thought:${row.id}")?.value?.let { body -> JSONObject(body) }
        if (prior != null) it.put("provenance", prior)
        else row.profileId?.let { id -> delegate.profile(id)?.let { profile -> it.put("provenance", JSONObject().put("profileId", profile.id).put("label", profile.label)) } }
        it.put("profileId", JSONObject.NULL)
    }
    private fun recover(kind: String, id: String, payload: JSONObject) {
        val prior = delegate.syncMetadata("head:$kind:$id")?.value?.let { delegate.syncRevision(it) } ?: delegate.entityRevisions(kind, id).firstOrNull()
        delegate.putRecovery(RecoveryRow(prior?.id ?: "legacy:$kind:$id", kind, prior?.entityId ?: id, prior?.payload ?: payload.toString(), System.currentTimeMillis()))
    }
}

object SyncJournal {
    @Volatile private var identity: SyncIdentity? = null
    fun configure(value: SyncIdentity) { identity = value }
    fun receipts(dao: StoreDao, staged: Boolean = false): JSONObject {
        val grouped = dao.syncHeaders().filter { JSONObject(it.header).has("signature") }.groupBy { it.origin }
        return JSONObject().also { result -> grouped.forEach { (origin, rows) -> var through = 0L; rows.sortedBy { it.sequence }.forEach { if (it.sequence == through + 1L) through = it.sequence }; if (!staged) dao.syncMetadata("applied:$origin")?.value?.toLong()?.let { through = minOf(through, it) }; result.put(origin, through) } }
    }
    fun revision(row: SyncRevisionRow): JSONObject = JSONObject(row.header).let { if (it.has("signature")) it.getJSONObject("header").getJSONObject("revision") else it }
    fun revision(row: SyncHeaderRow): JSONObject = JSONObject(row.header).let { if (it.has("signature")) it.getJSONObject("header").getJSONObject("revision") else it }
    fun envelope(dao: StoreDao, row: SyncRevisionRow, group: String): JSONObject {
        val existing = JSONObject(row.header)
        if (existing.has("signature")) { require(existing.getJSONObject("header").getString("group") == group); return existing.put("payload", row.payload?.let { JSONObject(it) } ?: JSONObject.NULL) }
        val signer = requireNotNull(identity) { "Device signer is unavailable" }
        signer.identity(dao)
        // Unsent capture history may have been recorded while a native library was unavailable.
        // Canonicalize it now before its first signature; previously signed headers never change.
        row.payload?.let { existing.put("payloadHash", SyncCore.request(JSONObject().put("action", "hash").put("value", JSONObject(it))).getString("hash")) }
        val previous = if (row.sequence == 1L) "" else requireNotNull(dao.originRevision(row.origin, row.sequence - 1L)).let { prior ->
            val header = JSONObject(prior.header); require(header.has("signature")) { "Previous revision has not been signed" }
            SyncCore.request(JSONObject().put("action", "hash").put("value", header.getJSONObject("header"))).getString("hash")
        }
        val header = JSONObject().put("protocol", 1).put("group", group).put("kind", row.kind).put("previousHash", previous).put("revision", existing)
        val bytes = SyncCore.request(JSONObject().put("action", "headerBytes").put("header", header)).getString("bytes")
        return JSONObject().put("header", header).put("signature", signer.sign(SyncIdentity.decode(bytes))).put("payload", row.payload?.let { JSONObject(it) } ?: JSONObject.NULL)
    }
    fun record(dao: StoreDao, kind: String, entityId: String, payload: JSONObject, deleted: Boolean): String {
        require(payload.toString().toByteArray(Charsets.UTF_8).size <= Backup.MAX_BYTES - 128 * 1024) { "This saved version is too large to sync. Shorten the text before saving." }
        val origin = dao.syncMetadata("device")?.value ?: uid().also { dao.putSyncMetadata(SyncMetadataRow("device", it)) }
        val sequence = Math.addExact(dao.syncMetadata("sequence")?.value?.toLong() ?: 0L, 1L)
        val oldWall = dao.syncMetadata("clock.wall")?.value?.toLong() ?: 0L
        val wall = maxOf(System.currentTimeMillis(), oldWall)
        val logical = if (wall == oldWall) Math.addExact(dao.syncMetadata("clock.logical")?.value?.toLong() ?: 0L, 1L) else 0L
        // Native canonicalization is shared. Until the bundled core loads, keep a local, unsent
        // revision; never stop capture or pretend a noncanonical digest is network-verified.
        val digest = if (SyncCore.available()) SyncCore.request(JSONObject().put("action", "hash").put("value", payload)).getString("hash")
            else MessageDigest.getInstance("SHA-256").digest(payload.toString().toByteArray()).joinToString("") { "%02x".format(it) }
        val context = receipts(dao).put(origin, sequence - 1)
        val header = JSONObject().put("entityId", entityId).put("dot", JSONObject().put("origin", origin).put("sequence", sequence))
            .put("context", context).put("clock", JSONObject().put("wall", wall).put("logical", logical))
            .put("deleted", deleted).put("payloadHash", digest)
        var row = SyncRevisionRow("$origin:$sequence", kind, entityId, origin, sequence, header.toString(), payload.toString())
        dao.syncMetadata("group")?.value?.let { group -> row = row.copy(header = envelope(dao, row, group).apply { remove("payload") }.toString()) }
        dao.insertSyncRevision(row)
        dao.putSyncMetadata(SyncMetadataRow("sequence", sequence.toString()))
        dao.putSyncMetadata(SyncMetadataRow("clock.wall", wall.toString()))
        dao.putSyncMetadata(SyncMetadataRow("clock.logical", logical.toString()))
        dao.putSyncMetadata(SyncMetadataRow("head:$kind:$entityId", "$origin:$sequence"))
        dao.putSyncMetadata(SyncMetadataRow("applied:$origin", sequence.toString()))
        return "$origin:$sequence"
    }
    fun mediaIds(payload: JSONObject): List<String> = payload.optJSONObject("payload")?.let { mediaIds(it) } ?: payload.optJSONArray("attachmentIds")?.let { ids(it.toString()) }
        ?: payload.optJSONArray("attachments")?.let { array -> (0 until array.length()).map { array.getJSONObject(it).getString("id") } } ?: emptyList()
}
