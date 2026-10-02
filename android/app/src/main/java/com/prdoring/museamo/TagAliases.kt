package com.prdoring.museamo

import org.json.JSONObject
import org.json.JSONArray

/** Aliases only originate from explicit initial enrollment snapshots; renames never create them. */
object TagAliases {
    fun canonical(dao: StoreDao, id: String): String {
        var current = id; val seen = mutableSetOf<String>()
        while (seen.add(current)) { val next = dao.syncMetadata("tagalias:$current")?.value ?: return current; if (next == current) return current; current = next }
        error("Invalid category alias cycle")
    }
    fun apply(dao: StoreDao, payload: JSONObject): Set<String> {
        val ids = ids(payload.getJSONArray("ids").toString()); require(ids.size >= 2 && ids == ids.distinct().sorted()) { "Category alias IDs must be unique and sorted" }
        ids.forEach { require(java.util.UUID.fromString(it).toString() == it) }
        require(payload.getString("normalizedName").isNotBlank() && payload.getString("type") in setOf("standard", "checklist"))
        val digest = SyncCore.request(JSONObject().put("action", "hash").put("value", payload)).getString("hash")
        dao.putSyncMetadata(SyncMetadataRow("tagaliasRecord:$digest", payload.toString()))
        val records = JSONArray(dao.syncMetadataPrefix("tagaliasRecord:%").map { JSONObject(it.value) })
        val aliases = SyncCore.request(JSONObject().put("action", "tagAliases").put("records", records)).getJSONObject("aliases")
        val component = aliases.keys().asSequence().toSet()
        component.forEach { dao.putSyncMetadata(SyncMetadataRow("tagalias:$it", aliases.getString(it))) }
        return component
    }
    fun map(dao: StoreDao, values: List<String>): List<String> = values.map { canonical(dao, it) }.distinct()
    fun projectReferences(dao: StoreDao) {
        dao.entries().forEach { row -> val mapped = jsonIds(map(dao, ids(row.tagIds))); if (mapped != row.tagIds) dao.updateEntry(row.copy(tagIds = mapped)) }
        dao.drafts().forEach { row -> val mapped = jsonIds(map(dao, ids(row.tagIds))); if (mapped != row.tagIds) dao.putDraft(row.copy(tagIds = mapped)) }
        dao.profiles().forEach { row -> dao.putProfile(row.copy(tagIds = jsonIds(map(dao, ids(row.tagIds))), selectedTagId = row.selectedTagId?.let { canonical(dao, it) })) }
    }
}
