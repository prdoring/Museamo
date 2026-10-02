package com.prdoring.museamo

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

object Backup {
    const val MAX_BYTES = 25 * 1024 * 1024
    const val MAX_TIMESTAMP = 8_640_000_000_000_000L
    fun export(repo: Repository, version: Int = 1): String {
        require(version in listOf(1, 4, 5))
        var output = ""
        repo.db.runInTransaction {
            output = JSONObject().put("format", "museamo").put("version", version).put("exportedAt", System.currentTimeMillis())
                .put("tags", JSONArray(repo.dao.tags().map { it.json().apply { if (version < 4) remove("type") } }))
                .put("profiles", JSONArray(repo.dao.profiles().map { it.json() }))
                .put("entries", JSONArray(repo.dao.entries().map { row -> row.json().apply { if (version < 4) remove("completed"); if (version >= 5) repo.entryJson(row).optJSONObject("provenance")?.let { put("provenance", it) } } })).also {
                    if (version >= 5) it.put("recovery", JSONArray(repo.dao.recovery().map { row ->
                        val payload = JSONObject(row.payload)
                        if (row.kind == "thought") payload.put("tagIds", JSONArray(TagAliases.map(repo.rawDao, ids(payload.getJSONArray("tagIds").toString()))))
                        JSONObject().put("id", row.id).put("kind", row.kind).put("entityId", row.entityId).put("createdAt", row.createdAt).put("payload", payload)
                    }))
                }.toString(2)
        }
        return output
    }
    private fun str(o: JSONObject, key: String): String { val value = o.get(key); require(value is String) { "$key must be text." }; return value }
    private fun id(o: JSONObject, key: String): String = str(o, key).also { require(UUID.fromString(it).toString() == it) { "Invalid $key." } }
    private fun nullableId(o: JSONObject, key: String): String? = if (o.isNull(key)) null else id(o, key)
    private fun tagIds(o: JSONObject): List<String> {
        val a = o.getJSONArray("tagIds")
        val result = (0 until a.length()).map { i -> val v = a.get(i); require(v is String); require(UUID.fromString(v).toString() == v); v }
        require(result.distinct().size == result.size) { "Duplicate tag references." }
        return result
    }
    private fun time(o: JSONObject, key: String): Long {
        val v = o.get(key)
        require(v is Number && v.toDouble().isFinite() && v.toDouble() == v.toLong().toDouble() && v.toLong() in 0..MAX_TIMESTAMP) { "Invalid timestamp." }
        return v.toLong()
    }
    fun entry(o: JSONObject, requireCompletion: Boolean = false): EntryRow {
        o.optJSONObject("provenance")?.let { p -> val label = str(p, "label"); require(label.isNotBlank() && label.length <= 80); if (!p.isNull("profileId")) id(p, "profileId") }
        val text = str(o, "text")
        val attachments = if (o.has("attachmentIds")) o.getJSONArray("attachmentIds") else o.optJSONArray("attachments")?.let { a -> JSONArray((0 until a.length()).map { a.getJSONObject(it).getString("id") }) } ?: JSONArray()
        val media = (0 until attachments.length()).map { i -> attachments.getString(i).also { require(UUID.fromString(it).toString() == it) { "Invalid attachment ID." } } }
        require(media.size <= 10 && media.distinct().size == media.size) { "Invalid attachments." }
        require(text.isNotBlank() || media.isNotEmpty()) { "An entry has no text or attachments." }
        val star = o.get("starred"); require(star is Boolean) { "Invalid starred state." }
        val completed = if (o.has("completed") || requireCompletion) o.get("completed") else false
        require(completed is Boolean) { "Invalid completed state." }
        return EntryRow(id(o, "id"), text, time(o, "createdAt"), time(o, "updatedAt"), star, jsonIds(tagIds(o)), nullableId(o, "profileId"), jsonIds(media), PostLocation.parse(o.opt("location")), completed = completed)
    }
    fun profile(o: JSONObject): ProfileRow {
        val label = str(o, "label"); require(label.isNotBlank() && label.length <= 80) { "Invalid profile label." }
        val mode = str(o, "mode"); require(mode in listOf("fixed", "picker")) { "Invalid widget mode." }
        return ProfileRow(id(o, "id"), label, mode, jsonIds(tagIds(o)), nullableId(o, "selectedTagId"))
    }
    private fun objects(o: JSONObject, key: String): List<JSONObject> = o.getJSONArray(key).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
    fun import(repo: Repository, text: String, withMedia: Boolean = false) {
        require(text.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) { "Backup is larger than 25 MB." }
        val root = if (SyncCore.available()) SyncCore.request(JSONObject().put("action", "parseJson").put("text", text)) else JSONObject(text)
        require(root.get("format") == "museamo" && root.get("version") in (if (withMedia) listOf(2, 3, 4, 5) else listOf(1))) { "Unsupported backup. Choose a Museamo ZIP backup or version 1 JSON export." }
        val version = root.getInt("version")
        val tags = objects(root, "tags").map { o ->
            val name = str(o, "name"); require(name == name.trim() && name.isNotEmpty() && name.length <= 80) { "Invalid tag name." }
            val type = if (version >= 4) str(o, "type") else "standard"
            require(type in listOf("standard", "checklist")) { "Unknown category type." }
            TagRow(id(o, "id"), name, normalizedName = normalizeTag(name), type = type)
        }
        val profiles = objects(root, "profiles").map { profile(it) }
        val entryObjects = objects(root, "entries")
        val entries = entryObjects.map { entry(JSONObject(it.toString()).apply { if (version < 3) remove("location"); if (version < 4) remove("completed") }, requireCompletion = version >= 4) }
        val recovery = if (version >= 5) objects(root, "recovery").map { o ->
            val kind = str(o, "kind"); require(kind in setOf("thought", "tag")) { "Unknown Recovery item kind." }
            val entityId = id(o, "entityId"); val payload = o.getJSONObject("payload")
            require(str(payload, "id") == entityId) { "Recovery item does not match its original ID." }
            if (kind == "thought") entry(payload, requireCompletion = true)
            else { val name = str(payload, "name"); require(name.isNotBlank() && name.length <= 80 && str(payload, "type") in setOf("standard", "checklist")) { "Invalid Recovery category." } }
            RecoveryRow(str(o, "id").also { require(it.isNotBlank() && it.length <= 256) }, kind, entityId, payload.toString(), time(o, "createdAt"))
        } else emptyList()
        require(entries.all { e -> ids(e.mediaIds).all { withMedia && repo.dao.media(it) != null } }) { "Backup contains missing media. Import the complete archive." }
        require(recovery.all { item -> SyncJournal.mediaIds(JSONObject(item.payload)).all { withMedia && repo.dao.media(it) != null } }) { "Recovery contains missing media. Import the complete archive." }
        require(tags.map { it.id }.distinct().size == tags.size && profiles.map { it.id }.distinct().size == profiles.size && entries.map { it.id }.distinct().size == entries.size) { "Backup contains duplicate IDs." }
        if (version < 5) require(tags.map { it.normalizedName }.distinct().size == tags.size) { "Backup contains duplicate tag names." }
        require(recovery.map { it.id }.distinct().size == recovery.size) { "Backup contains duplicate Recovery IDs." }
        val tagSet = tags.map { it.id }.toSet(); val profileSet = profiles.map { it.id }.toSet()
        require(profiles.all { p -> ids(p.tagIds).all { it in tagSet } && (p.selectedTagId == null || p.selectedTagId in tagSet) } && entries.all { e -> ids(e.tagIds).all { it in tagSet } && (e.profileId == null || e.profileId in profileSet) }) { "Backup contains missing tag or profile references." }
        repo.db.runInTransaction {
            val tagMap = mutableMapOf<String, String>()
            tags.forEach { incoming ->
                val sameName = repo.dao.tags().find { it.normalizedName == incoming.normalizedName && it.type == incoming.type }
                val existing = repo.dao.tag(incoming.id)
                val target = sameName ?: incoming.copy(id = if (existing == null) incoming.id else uid()).also { repo.dao.putTag(it) }
                tagMap[incoming.id] = target.id
            }
            val profileMap = mutableMapOf<String, String>()
            profiles.forEach { incoming ->
                val mapped = incoming.copy(tagIds = jsonIds(ids(incoming.tagIds).map { tagMap.getValue(it) }), selectedTagId = incoming.selectedTagId?.let { tagMap.getValue(it) })
                val existing = repo.dao.profile(mapped.id)
                // Re-importing a conflicting backup should reuse its preserved copy.
                val target = when {
                    existing == null -> mapped.also { repo.dao.putProfile(it) }
                    existing == mapped -> existing
                    else -> repo.dao.profiles().find { it.copy(id = mapped.id) == mapped }
                        ?: mapped.copy(id = uid()).also { repo.dao.putProfile(it) }
                }
                profileMap[incoming.id] = target.id
            }
            entries.forEach { incoming ->
                val mapped = incoming.copy(tagIds = jsonIds(ids(incoming.tagIds).map { tagMap.getValue(it) }), profileId = incoming.profileId?.let { profileMap.getValue(it) })
                val existing = repo.dao.entry(mapped.id)
                val target = if (existing == null) { if (repo.dao.retired("thought", mapped.id) == null) mapped else mapped.copy(id = uid()) } else if (existing != mapped && repo.dao.entries().none { it.copy(id = mapped.id) == mapped }) mapped.copy(id = uid()) else null
                if (target != null) {
                    entryObjects.first { it.getString("id") == incoming.id }.optJSONObject("provenance")?.let { repo.rawDao.putSyncMetadata(SyncMetadataRow("provenance:thought:${target.id}", it.toString())) }
                    repo.dao.insertEntry(target)
                }
            }
            recovery.forEach { incoming ->
                val payload = JSONObject(incoming.payload)
                val originalId = if (incoming.kind == "thought" && repo.rawDao.retired("thought", incoming.entityId) != null) uid().also { payload.put("id", it) } else incoming.entityId
                if (incoming.kind == "thought") {
                    payload.put("tagIds", JSONArray(ids(payload.getJSONArray("tagIds").toString()).map { tagMap[it] ?: it }))
                    payload.put("profileId", JSONObject.NULL)
                }
                // Portable exports contain content only. Imported Recovery becomes ordinary local
                // history, with no device identity, signatures or replication acknowledgements.
                val stable = SyncCore.request(JSONObject().put("action", "hash").put("value", payload)).getString("hash")
                if (repo.dao.recovery().none { item -> SyncCore.request(JSONObject().put("action", "hash").put("value", JSONObject(item.payload))).getString("hash") == stable }) {
                    val archive = JSONObject().put("kind", incoming.kind).put("entityId", originalId).put("payload", payload).put("createdAt", incoming.createdAt)
                    val revisionId = SyncJournal.record(repo.rawDao, if (incoming.kind == "thought") "archiveThought" else "archiveTag", originalId, archive, false)
                    repo.dao.putRecovery(incoming.copy(id = revisionId, entityId = originalId, payload = payload.toString()))
                }
            }
        }
    }
}
