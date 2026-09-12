package com.prdoring.museamo

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

object Backup {
    const val MAX_BYTES = 25 * 1024 * 1024
    fun export(repo: Repository): String {
        var output = ""
        repo.db.runInTransaction {
            output = JSONObject().put("format", "museamo").put("version", 1).put("exportedAt", System.currentTimeMillis())
                .put("tags", JSONArray(repo.dao.tags().map { it.json() }))
                .put("profiles", JSONArray(repo.dao.profiles().map { it.json() }))
                .put("entries", JSONArray(repo.dao.entries().map { it.json() })).toString(2)
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
        require(v is Number && v.toDouble() == v.toLong().toDouble() && v.toLong() in 0..253402300799999L) { "Invalid timestamp." }
        return v.toLong()
    }
    fun entry(o: JSONObject): EntryRow {
        val text = str(o, "text"); require(text.isNotBlank()) { "An entry has no text." }
        val star = o.get("starred"); require(star is Boolean) { "Invalid starred state." }
        return EntryRow(id(o, "id"), text, time(o, "createdAt"), time(o, "updatedAt"), star, jsonIds(tagIds(o)), nullableId(o, "profileId"))
    }
    fun profile(o: JSONObject): ProfileRow {
        val label = str(o, "label"); require(label.isNotBlank() && label.length <= 80) { "Invalid profile label." }
        val mode = str(o, "mode"); require(mode in listOf("fixed", "picker")) { "Invalid widget mode." }
        return ProfileRow(id(o, "id"), label, mode, jsonIds(tagIds(o)), nullableId(o, "selectedTagId"))
    }
    private fun objects(o: JSONObject, key: String): List<JSONObject> = o.getJSONArray(key).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
    fun import(repo: Repository, text: String) {
        require(text.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) { "Backup is larger than 25 MB." }
        val root = JSONObject(text)
        require(root.get("format") == "museamo" && root.get("version") == 1) { "Unsupported backup. Choose a Museamo version 1 JSON export." }
        val tags = objects(root, "tags").map { o -> val name = str(o, "name"); require(name == name.trim() && name.isNotEmpty() && name.length <= 80) { "Invalid tag name." }; TagRow(id(o, "id"), name) }
        val profiles = objects(root, "profiles").map { profile(it) }
        val entries = objects(root, "entries").map { entry(it) }
        require(tags.map { it.id }.distinct().size == tags.size && profiles.map { it.id }.distinct().size == profiles.size && entries.map { it.id }.distinct().size == entries.size) { "Backup contains duplicate IDs." }
        require(tags.map { it.normalizedName }.distinct().size == tags.size) { "Backup contains duplicate tag names." }
        val tagSet = tags.map { it.id }.toSet(); val profileSet = profiles.map { it.id }.toSet()
        require(profiles.all { p -> ids(p.tagIds).all { it in tagSet } && (p.selectedTagId == null || p.selectedTagId in tagSet) } && entries.all { e -> ids(e.tagIds).all { it in tagSet } && (e.profileId == null || e.profileId in profileSet) }) { "Backup contains missing tag or profile references." }
        repo.db.runInTransaction {
            val tagMap = mutableMapOf<String, String>()
            tags.forEach { incoming ->
                val sameName = repo.dao.tags().find { it.normalizedName == incoming.normalizedName }
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
                if (existing == null) repo.dao.insertEntry(mapped)
                else if (existing != mapped && repo.dao.entries().none { it.copy(id = mapped.id) == mapped }) repo.dao.insertEntry(mapped.copy(id = uid()))
            }
        }
    }
}
