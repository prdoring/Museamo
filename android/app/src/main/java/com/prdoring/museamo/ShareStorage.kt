package com.prdoring.museamo

import androidx.room.*
import org.json.JSONArray
import org.json.JSONObject

@Entity(tableName = "sharing_state") data class ShareStateRow(@PrimaryKey val key: String, val value: String)
@Entity(tableName = "sharing_pending") data class SharePendingRow(@PrimaryKey val id: String, val payload: String, val createdAt: Long)

/** All methods run on Store.executor and participate in the caller's Room transaction. */
object ShareStorage {
    fun registry(dao: StoreDao): JSONObject = dao.sharingState("registry")?.value?.let(::JSONObject) ?: JSONObject().put("scopes", JSONObject()).put("bindings", JSONObject())
    private fun objects(value: JSONObject): List<Pair<String, JSONObject>> = value.keys().asSequence().map { it to value.getJSONObject(it) }.toList()
    fun binding(dao: StoreDao, tagId: String): Pair<String, JSONObject>? = objects(registry(dao).getJSONObject("bindings")).find { !it.second.optBoolean("detached") && it.second.getString("tagId") == tagId }
    fun isShared(dao: StoreDao, tagId: String): Boolean = binding(dao, tagId) != null
    fun reservedId(dao: StoreDao, id: String): Boolean = objects(registry(dao).getJSONObject("bindings")).any { (_, b) -> b.getString("tagId") == id || b.getJSONObject("entries").keys().asSequence().any { b.getJSONObject("entries").getString(it) == id } }
    fun privateSnapshot(dao: StoreDao, root: JSONObject): JSONObject {
        val mapping = mutableMapOf<String, String>()
        objects(registry(dao).getJSONObject("bindings")).forEach { (_, b) -> mapping.getOrPut(b.getString("tagId")) { uid() }; b.getJSONObject("entries").keys().asSequence().forEach { key -> mapping.getOrPut(b.getJSONObject("entries").getString(key)) { uid() } } }
        fun remap(value: JSONObject) { value.remove("revision"); value.remove("sharing"); value.optString("id").let { mapping[it]?.let { next -> value.put("id", next) } }; value.optJSONArray("tagIds")?.let { a -> value.put("tagIds", JSONArray(ids(a.toString()).map { mapping[it] ?: it })) }; value.optString("selectedTagId").let { mapping[it]?.let { next -> value.put("selectedTagId", next) } } }
        for (key in listOf("tags", "entries", "profiles")) root.optJSONArray(key)?.let { a -> for (i in 0 until a.length()) remap(a.getJSONObject(i)) }
        root.optJSONArray("recovery")?.let { a -> for (i in 0 until a.length()) { val row = a.getJSONObject(i); remap(row.getJSONObject("payload")); mapping[row.getString("entityId")]?.let { row.put("entityId", it) }; if (row.getString("id").startsWith("shared:")) row.put("id", uid()) } }
        return root
    }
    private fun own(dao: StoreDao): String? = dao.syncMetadata("group")?.value
    fun active(scope: JSONObject, participant: String?): Boolean {
        if (participant == null) return false
        val controls = scope.getJSONArray("controls").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
        if (controls.any { it.getJSONObject("body").getString("kind") == "stop" }) return false
        val removed = controls.filter { it.getJSONObject("body").getString("kind") in setOf("remove", "leave") }.map { it.getJSONObject("body").getJSONObject("data").getString("grant") }.toSet()
        return controls.any { c -> val b = c.getJSONObject("body"); b.getString("kind") in setOf("open", "grant") && b.getJSONObject("data").getString("participant") == participant && c.getString("id") !in removed }
    }
    private fun deviceActive(dao: StoreDao, scope: JSONObject): Boolean {
        val device = dao.syncMetadata("device")?.value ?: return true
        val person = own(dao) ?: return false
        val proof = scope.optJSONObject("proofs")?.optJSONObject(person) ?: return false
        val personal = dao.syncMetadata("coordinator")?.value?.let(::JSONObject) ?: JSONObject()
        return runCatching { SyncCore.request(JSONObject().put("action", "sharingDeviceActive").put("proof", proof).put("personal", personal).put("device", device)).getBoolean("active") }.getOrDefault(false)
    }
    fun metadata(dao: StoreDao, tagId: String): JSONObject? {
        val (id, _) = binding(dao, tagId) ?: return null
        val scope = registry(dao).getJSONObject("scopes").getJSONObject(id)
        if (!active(scope, own(dao))) return null
        val controls = scope.getJSONArray("controls"); val creator = (0 until controls.length()).map { controls.getJSONObject(it).getJSONObject("body") }.first { it.getString("kind") == "open" }.getString("participant")
        return JSONObject().put("collectionId", id).put("role", if (creator == own(dao)) "owner" else "member").put("status", "waiting").put("lastSync", scope.opt("lastSync"))
    }
    fun tagJson(dao: StoreDao, tag: TagRow): JSONObject = tag.json().also { metadata(dao, tag.id)?.let { share -> it.put("sharing", share) } }
    fun personalProjection(dao: StoreDao, kind: String, id: String, incoming: JSONObject?): Boolean {
        val state = registry(dao); val bindings = objects(state.getJSONObject("bindings"))
        if (kind == "tag") return bindings.any { !it.second.optBoolean("detached") && it.second.getString("tagId") == id }
        if (kind != "thought") return false
        val bound = bindings.find { !it.second.optBoolean("detached") && it.second.getJSONObject("entries").keys().asSequence().any { key -> it.second.getJSONObject("entries").getString(key) == id } } ?: return false
        val old = dao.entry(id); val pending = dao.sharingPending().any { JSONObject(it.payload).optString("localId") == id }
        val saved = dao.sharingState("canonical:$id")?.value?.let(::JSONObject)
        if (saved?.optBoolean("deleted") == true && !pending) { dao.deleteEntry(id); return true }
        val canonical = if (pending) old?.json() else saved?.optJSONObject("payload") ?: old?.json()
        if (canonical == null) return true
        val body = JSONObject(canonical.toString()).put("id", id).put("starred", incoming?.optBoolean("starred") ?: old?.starred ?: false).put("profileId", old?.profileId ?: JSONObject.NULL)
        val personalTags = incoming?.optJSONArray("tagIds")?.let { ids(it.toString()) } ?: old?.let { ids(it.tagIds) } ?: emptyList()
        body.put("tagIds", JSONArray(personalTags.filter { tag -> bindings.none { !it.second.optBoolean("detached") && it.second.getString("tagId") == tag } } + bound.second.getString("tagId")))
        val row = Backup.entry(body, requireCompletion = true); if (old == null) dao.insertEntry(row) else dao.updateEntry(row); return true
    }
    fun validateTags(dao: StoreDao, tagIds: List<String>) { require(tagIds.distinct().count { isShared(dao, it) } <= 1) { "A thought can belong to only one shared hashtag. Your draft is kept." } }
    fun clearRecovery(dao: StoreDao, id: String): Boolean {
        if (!id.startsWith("shared:")) return false
        val scopeId = id.removePrefix("shared:").substringBefore(':'); val state = registry(dao); val scope = state.getJSONObject("scopes").getJSONObject(scopeId); val bind = state.getJSONObject("bindings").getJSONObject(scopeId)
        require(!bind.optBoolean("detached") && active(scope, own(dao)) && deviceActive(dao, scope)) { "You no longer belong to this shared hashtag." }
        val pending = JSONObject().put("id", uid()).put("scope", scopeId).put("grant", bind.getString("grant")).put("kind", "purge").put("revisionId", id.removePrefix("shared:$scopeId:"))
        dao.putSharingPending(SharePendingRow(pending.getString("id"), pending.toString(), System.currentTimeMillis())); dao.clearRecovery(id); return true
    }
    private fun payload(dao: StoreDao, row: EntryRow): JSONObject = row.json().apply {
        remove("starred"); remove("tagIds"); remove("profileId"); remove("attachmentIds")
        put("attachments", JSONArray(ids(row.mediaIds).map { requireNotNull(dao.media(it)).json() }))
    }
    fun removesSharedTag(dao: StoreDao, old: EntryRow, row: EntryRow): Boolean = objects(registry(dao).getJSONObject("bindings")).any { (_, b) -> !b.optBoolean("detached") && b.getJSONObject("entries").keys().asSequence().any { b.getJSONObject("entries").getString(it) == old.id } && b.getString("tagId") !in ids(row.tagIds) }
    fun recordThought(dao: StoreDao, old: EntryRow?, row: EntryRow, deleted: Boolean = false) {
        validateTags(dao, ids(row.tagIds))
        val state = registry(dao); val bindings = objects(state.getJSONObject("bindings"))
        val prior = bindings.find { !it.second.optBoolean("detached") && it.second.getJSONObject("entries").keys().asSequence().any { key -> it.second.getJSONObject("entries").getString(key) == row.id } }
        val selected = ids(row.tagIds).mapNotNull { id -> bindings.find { !it.second.optBoolean("detached") && it.second.getString("tagId") == id } }.firstOrNull()
        require(prior == null || selected == null || prior.first == selected.first) { "Remove the current shared hashtag and save its private copy before adding another shared hashtag. Your draft is kept." }
        val target = prior ?: selected ?: return
        val scope = state.getJSONObject("scopes").getJSONObject(target.first)
        require(active(scope, own(dao)) && deviceActive(dao, scope)) { "You no longer belong to this shared hashtag. Reload the list." }
        val removing = deleted || prior != null && selected?.first != prior.first
        val itemId = target.second.getJSONObject("entries").keys().asSequence().find { target.second.getJSONObject("entries").getString(it) == row.id } ?: row.id
        val body = payload(dao, row).put("id", itemId)
        val oldBody = old?.let { payload(dao, it).put("id", itemId) }
        if (!removing && prior != null && oldBody?.toString() == body.toString()) return
        val receipts = JSONObject(); val records = scope.getJSONArray("records")
        for (i in 0 until records.length()) { val dot = records.getJSONObject(i).getJSONObject("revision").getJSONObject("dot"); val origin = dot.getString("origin"); receipts.put(origin, maxOf(receipts.optLong(origin), dot.getLong("sequence"))) }
        val pending = JSONObject().put("id", uid()).put("scope", target.first).put("grant", target.second.getString("grant")).put("kind", "thought").put("entityId", itemId).put("localId", row.id).put("payload", body).put("deleted", removing).put("context", receipts)
        dao.putSharingPending(SharePendingRow(pending.getString("id"), pending.toString(), System.currentTimeMillis()))
        if (prior != null && selected?.first != prior.first && !deleted) {
            // A private copy has a new identity; delayed shared tombstones cannot erase it.
            val copy = row.copy(id = localId(target.first, own(dao)!!, "$itemId:detached:${pending.getString("id")}"), tagIds = jsonIds(ids(row.tagIds).filter { !isShared(dao, it) }))
            dao.insertEntry(copy); SyncJournal.record(dao, "thought", copy.id, copy.json().put("attachments", JSONArray(ids(copy.mediaIds).map { requireNotNull(dao.media(it)).json() })), false)
        }
    }
    fun recordTag(dao: StoreDao, old: TagRow?, row: TagRow) {
        if (old == null || old == row) return
        val (scopeId, _) = binding(dao, row.id) ?: return
        require(deviceActive(dao, registry(dao).getJSONObject("scopes").getJSONObject(scopeId))) { "This device no longer has shared access. Relink it on your phone." }
        require(metadata(dao, row.id)?.getString("role") == "owner") { "Only the creator can change this shared hashtag." }
        val pending = JSONObject().put("id", uid()).put("scope", scopeId).put("grant", binding(dao, row.id)!!.second.getString("grant")).put("kind", "metadata").put("payload", row.json())
        dao.putSharingPending(SharePendingRow(pending.getString("id"), pending.toString(), System.currentTimeMillis()))
    }
    fun localId(scope: String, participant: String, item: String): String = SyncCore.request(JSONObject().put("action", "sharingLocalId").put("scope", scope).put("participant", participant).put("item", item)).getString("id")
    fun seed(repo: Repository, tagId: String): JSONObject {
        val tag = requireNotNull(repo.rawDao.tag(tagId)) { "This hashtag no longer exists." }
        val entries = repo.rawDao.entries().filter { tagId in ids(it.tagIds) }
        require(entries.none { row -> ids(row.tagIds).any { isShared(repo.rawDao, it) } }) { "Some thoughts already belong to another shared list. Remove that shared hashtag first." }
        return JSONObject().put("tag", tag.json()).put("entries", JSONArray(entries.map { payload(repo.rawDao, it) }))
    }
    fun commit(repo: Repository, input: JSONObject) = repo.db.runInTransaction {
        input.optJSONObject("seed")?.let { before ->
            val current = seed(repo, before.getJSONObject("tag").getString("id"))
            fun digest(value: JSONObject): String { return SyncCore.request(JSONObject().put("action", "hash").put("value", value)).getString("hash") }
            require(digest(before) == digest(current)) { "This hashtag changed while sharing was starting. Retry to share its current items." }
        }
        val dao = repo.rawDao; val previous = registry(dao); val next = input.getJSONObject("registry"); val person = input.optString("participant")
        val ack = ids(input.getJSONArray("ack").toString()).toSet(); dao.sharingPending().filter { it.id in ack }.forEach { dao.deleteSharingPending(it.id) }
        val pendingIds = dao.sharingPending().map { JSONObject(it.payload).optString("localId") }.toSet()
        val projections = input.getJSONArray("projections")
        for (i in 0 until projections.length()) {
            val projection = projections.getJSONObject(i); val scopeId = projection.getString("collectionId"); val bind = next.getJSONObject("bindings").getJSONObject(scopeId); val scope = next.getJSONObject("scopes").getJSONObject(scopeId)
            val oldBinding = previous.getJSONObject("bindings").optJSONObject(scopeId)
            if (!active(scope, person)) bind.put("detached", true)
            if (bind.optBoolean("detached")) {
                if (oldBinding != null && !oldBinding.optBoolean("detached")) detach(repo, scopeId, person, oldBinding)
                continue
            }
            val t = projection.getJSONObject("tag"); val tag = TagRow(bind.getString("tagId"), t.getString("name"), normalizeTag(t.getString("name")), t.getString("type"))
            if (dao.tag(tag.id) != tag) { dao.putTag(tag); SyncJournal.record(dao, "tag", tag.id, tag.json(), false) }
            val items = projection.getJSONArray("items")
            for (j in 0 until items.length()) {
                val item = items.getJSONObject(j); val itemId = item.getString("itemId"); val entryId = bind.getJSONObject("entries").optString(itemId).ifBlank { localId(scopeId, person, "${tag.id}:$itemId").also { bind.getJSONObject("entries").put(itemId, it) } }
                dao.putSharingState(ShareStateRow("canonical:$entryId", item.toString()))
                if (entryId in pendingIds) continue
                val old = dao.entry(entryId)
                if (item.getBoolean("deleted")) { if (old != null) { dao.deleteEntry(entryId); SyncJournal.record(dao, "thought", entryId, old.json().put("attachments", JSONArray(ids(old.mediaIds).map { requireNotNull(dao.media(it)).json() })), true) }; continue }
                val p = item.getJSONObject("payload"); val attachments = p.getJSONArray("attachments")
                for (a in 0 until attachments.length()) { val m = MediaBackup.parseMedia(attachments.getJSONObject(a)); val stored = dao.media(m.id); require(stored == null || stored == m) { "Shared attachment identity conflicts." }; if (stored == null) dao.insertMedia(m) }
                val location = PostLocation.parse(p.opt("location"))
                val tags = (old?.let { ids(it.tagIds).filter { id -> id == tag.id || !isShared(dao, id) } } ?: emptyList()) + tag.id
                val row = EntryRow(entryId, p.getString("text"), p.getLong("createdAt"), p.getLong("updatedAt"), old?.starred ?: false, jsonIds(tags), old?.profileId, jsonIds((0 until attachments.length()).map { attachments.getJSONObject(it).getString("id") }), location, completed = p.getBoolean("completed"))
                if (row != old) { if (old == null) dao.insertEntry(row) else dao.updateEntry(row); SyncJournal.record(dao, "thought", row.id, row.json().put("attachments", attachments), false) }
                dao.putSharingState(ShareStateRow("revision:$entryId", item.getString("revision")))
            }
            val history = projection.getJSONArray("recovery")
            dao.recovery().filter { it.id.startsWith("shared:$scopeId:") }.forEach { dao.clearRecovery(it.id) }
            for (j in 0 until history.length()) { val item = history.getJSONObject(j); val local = bind.getJSONObject("entries").optString(item.getString("itemId")); if (local.isBlank()) continue; val p = JSONObject(item.getJSONObject("payload").toString()).put("id", local).put("starred", false).put("tagIds", JSONArray(listOf(tag.id))).put("profileId", JSONObject.NULL); dao.putRecovery(RecoveryRow(item.getString("id"), "thought", local, p.toString(), item.getLong("createdAt"))) }
        }
        dao.putSharingState(ShareStateRow("registry", next.toString()))
    }
    private fun detach(repo: Repository, scope: String, person: String, binding: JSONObject) {
        val dao = repo.rawDao; val tagId = binding.getString("tagId"); val tag = dao.tag(tagId) ?: return
        val privateTag = tag.copy(id = localId(scope, person, "$tagId:private")); dao.putTag(privateTag); SyncJournal.record(dao, "tag", privateTag.id, privateTag.json(), false)
        val entries = binding.getJSONObject("entries")
        entries.keys().asSequence().toList().forEach { item -> dao.entry(entries.getString(item))?.let { row ->
            val copy = row.copy(id = localId(scope, person, "${row.id}:private:$tagId"), tagIds = jsonIds((ids(row.tagIds) - tagId) + privateTag.id)); dao.insertEntry(copy); SyncJournal.record(dao, "thought", copy.id, copy.json().put("attachments", JSONArray(ids(copy.mediaIds).map { requireNotNull(dao.media(it)).json() })), false)
            dao.deleteEntry(row.id); SyncJournal.record(dao, "thought", row.id, row.json().put("attachments", JSONArray(ids(row.mediaIds).map { requireNotNull(dao.media(it)).json() })), true)
        } }
        dao.profiles().forEach { p -> dao.putProfile(p.copy(tagIds = jsonIds(ids(p.tagIds).map { if (it == tagId) privateTag.id else it }), selectedTagId = if (p.selectedTagId == tagId) privateTag.id else p.selectedTagId)) }
        dao.drafts().forEach { d -> dao.putDraft(d.copy(tagIds = jsonIds(ids(d.tagIds).map { if (it == tagId) privateTag.id else it }))) }
        dao.deleteTag(tagId); SyncJournal.record(dao, "tag", tagId, tag.json(), true)
        dao.recovery().filter { it.id.startsWith("shared:$scope:") }.forEach { dao.clearRecovery(it.id) }
    }
}
