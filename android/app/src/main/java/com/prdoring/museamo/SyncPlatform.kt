package com.prdoring.museamo

import android.content.Context
import androidx.annotation.Keep
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.Callable

/** JNI callback, deliberately absent from Capacitor. Every durable callback uses one Room writer. */
@Keep
class SyncPlatform(private val context: Context, private val testRepository: Repository? = null) {
    private val identity = SyncIdentity(context)
    @Keep fun platformCall(method: String, input: String): String = try {
        val value = JSONObject(input)
        val result = when (method) {
            "syncSign" -> JSONObject().put("signature", identity.sign(SyncIdentity.decode(value.getString("bytes"))))
            "syncBindSocket" -> { bindSocket(value.getInt("fd")); JSONObject() }
            else -> Store.executor.submit(Callable { dispatch(method, value, testRepository ?: Store.get(context)) }).get()
        }
        JSONObject().put("ok", true).put("result", result).toString()
    } catch (error: Exception) { JSONObject().put("ok", false).put("error", error.cause?.message ?: error.message ?: "Native sync operation failed").toString() }

    private fun dispatch(method: String, input: JSONObject, repo: Repository): JSONObject = when (method) {
        "syncSharingRequired" -> JSONObject().put("required", repo.rawDao.tags().any { ShareStorage.isShared(repo.rawDao, it.id) })
        "shareLoad" -> JSONObject().put("registry", repo.rawDao.sharingState("registry")?.value?.let(::JSONObject) ?: JSONObject.NULL)
        "sharePending" -> JSONObject().put("items", JSONArray(repo.rawDao.sharingPending().map { JSONObject(it.payload) }))
        "shareSeed" -> ShareStorage.seed(repo, input.getString("tagId"))
        "shareCommit" -> { ShareStorage.commit(repo, input); Store.changed(context, localMutation = false); JSONObject().put("registry", ShareStorage.registry(repo.rawDao)) }
        "shareMissingMedia" -> missingMedia(repo, 32, shareMedia(repo, input.getString("scope")))
        "shareReadMedia" -> { require(input.getString("id") in shareMedia(repo, input.getString("scope"))) { "Original is not in this shared list" }; readMedia(repo, input) }
        "shareWriteMedia" -> { require(input.getString("id") in shareMedia(repo, input.getString("scope"))) { "Original is not in this shared list" }; writeMedia(repo, input) }
        "syncIdentity" -> identity.identity(repo)
        "syncSign" -> JSONObject().put("signature", identity.sign(SyncIdentity.decode(input.getString("bytes"))))
        "syncLoad" -> JSONObject().put("state", repo.rawDao.syncMetadata("coordinator")?.value?.let { JSONObject(it) } ?: JSONObject.NULL)
        "syncSave" -> { repo.rawDao.putSyncMetadata(SyncMetadataRow("coordinator", input.getJSONObject("state").toString())); JSONObject() }
        "syncSummary" -> { val media = (repo.dao.entries().flatMap { ids(it.mediaIds) } + repo.dao.recovery().flatMap { SyncJournal.mediaIds(JSONObject(it.payload)) }).distinct().mapNotNull { repo.dao.media(it) }; JSONObject().put("thoughts", repo.dao.entries().size).put("tags", repo.dao.tags().size).put("attachments", media.size).put("attachmentBytes", media.sumOf { it.byteSize }) }
        "syncEnrollmentTags" -> JSONObject().put("tags", JSONArray(repo.rawDao.tags().filter { !ShareStorage.isShared(repo.rawDao, it.id) }.map { it.json() }))
        "syncCoalesceTags" -> { coalesceTags(repo, input); Store.changed(context, localMutation = false); JSONObject() }
        "syncEnroll" -> { enroll(repo, input.getString("groupId")); JSONObject() }
        "syncExport" -> export(repo, input)
        "syncApply" -> apply(repo, input)
        "syncReceipts" -> JSONObject().put("receipts", SyncJournal.receipts(repo.rawDao)).put("stagedReceipts", SyncJournal.receipts(repo.rawDao, staged = true))
        "syncHeader" -> { val row = requireNotNull(repo.rawDao.originRevision(input.getString("origin"), input.getLong("sequence"))) { "Missing durable origin header" }; JSONObject().put("hash", hash(JSONObject(row.header).getJSONObject("header"))) }
        "syncMissingMedia" -> missingMedia(repo, input.optInt("limit", 32).coerceIn(1, 32))
        "syncReadMedia" -> readMedia(repo, input)
        "syncWriteMedia" -> writeMedia(repo, input)
        else -> error("Unknown internal platform operation")
    }
    private fun hash(value: JSONObject): String = SyncCore.request(JSONObject().put("action", "hash").put("value", value)).getString("hash")
    private fun bindSocket(fd: Int) {
        require(fd >= 0)
        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
        val network = connectivity.allNetworks.firstOrNull { network -> val capabilities = connectivity.getNetworkCapabilities(network); capabilities != null && !capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN) && (capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) || capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET)) }
            ?: error("Connect to a local Wi-Fi network to link or sync devices")
        android.os.ParcelFileDescriptor.fromFd(fd).use { duplicate -> network.bindSocket(duplicate.fileDescriptor) }
    }
    private fun enroll(repo: Repository, group: String) = repo.db.runInTransaction {
        val dao = repo.rawDao; val current = dao.syncMetadata("group")?.value
        require(current == null || current == group) { "Merging existing sync groups is not supported. Export their libraries first." }
        SyncJournal.configure(identity); identity.identity(repo)
        // Older installations have saved rows but no replication journal. Baseline them once.
        dao.tags().filter { dao.entityRevisions("tag", it.id).isEmpty() }.forEach { SyncJournal.record(dao, "tag", it.id, it.json(), false) }
        dao.entries().filter { dao.entityRevisions("thought", it.id).isEmpty() }.forEach { row ->
            val payload = row.json().put("profileId", JSONObject.NULL).put("attachments", JSONArray(ids(row.mediaIds).map { requireNotNull(dao.media(it)).json() }))
            row.profileId?.let { dao.profile(it)?.let { p -> payload.put("provenance", JSONObject().put("profileId", p.id).put("label", p.label)) } }
            SyncJournal.record(dao, "thought", row.id, payload, false)
        }
        dao.recovery().filter { dao.syncRevision(it.id) == null }.forEach { item ->
            val archive = JSONObject().put("kind", item.kind).put("entityId", item.entityId).put("payload", JSONObject(item.payload)).put("createdAt", item.createdAt)
            val id = SyncJournal.record(dao, if (item.kind == "thought") "archiveThought" else "archiveTag", item.entityId, archive, false); dao.clearRecovery(item.id); dao.putRecovery(item.copy(id = id))
        }
        dao.syncRevisions().sortedWith(compareBy<SyncRevisionRow> { it.origin }.thenBy { it.sequence }).forEach { row ->
            if (!JSONObject(row.header).has("signature")) dao.updateRevisionHeader(row.id, SyncJournal.envelope(dao, row, group).apply { remove("payload") }.toString())
        }
        dao.putSyncMetadata(SyncMetadataRow("group", group))
    }
    private fun coalesceTags(repo: Repository, input: JSONObject) = repo.db.runInTransaction {
        val dao = repo.rawDao; val enrollment = input.getString("enrollmentId"); require(enrollment.length in 1..256)
        if (dao.syncMetadata("coalesced:$enrollment") != null) return@runInTransaction
        fun snapshot(key: String): List<JSONObject> = input.getJSONArray(key).let { a -> (0 until a.length()).map { a.getJSONObject(it) }.onEach { tag -> require(java.util.UUID.fromString(tag.getString("id")).toString() == tag.getString("id")); require(tag.getString("name").trim().isNotEmpty() && tag.getString("name").length <= 80 && tag.getString("type") in setOf("standard", "checklist")) } }
        fun effective(tags: List<JSONObject>) = tags.filter { !ShareStorage.isShared(dao, it.getString("id")) && !ShareStorage.isShared(dao, TagAliases.canonical(dao, it.getString("id"))) }.map { JSONObject(it.toString()).put("id", TagAliases.canonical(dao, it.getString("id"))) }
        val local = effective(snapshot("localTags")); val peer = effective(snapshot("peerTags")); val localIds = local.map { it.getString("id") }.toSet(); val peerIds = peer.map { it.getString("id") }.toSet()
        (local + peer).groupBy { normalizeTag(it.getString("name")) to it.getString("type") }.forEach { (key, tags) ->
            val ids = tags.map { it.getString("id") }.distinct().sorted()
            if (ids.size < 2 || ids.count { it in localIds } != 1 || ids.count { it in peerIds } != 1) return@forEach
            val payload = JSONObject().put("ids", JSONArray(ids)).put("normalizedName", key.first).put("type", key.second)
            SyncJournal.record(dao, "tagAlias", uid(), payload, false); TagAliases.apply(dao, payload)
        }
        projectAliasTags(repo); TagAliases.projectReferences(dao)
        dao.putSyncMetadata(SyncMetadataRow("coalesced:$enrollment", "1"))
    }
    private fun projectAliasTags(repo: Repository) {
        val dao = repo.rawDao; val ids = dao.syncRevisions().filter { it.kind == "tag" }.map { TagAliases.canonical(dao, it.entityId) }.distinct()
        dao.tags().filter { TagAliases.canonical(dao, it.id) != it.id }.forEach { dao.deleteTag(it.id) }
        ids.forEach { project(repo, "tag", it) }
    }
    private fun export(repo: Repository, input: JSONObject): JSONObject {
        val group = input.getString("groupId"); require(repo.rawDao.syncMetadata("group")?.value == group) { "Unknown sync group" }
        val after = JSONObject(input.getJSONObject("after").toString()); val limit = input.optInt("limit", 32).coerceIn(1, 32)
        val journal = repo.rawDao.syncHeaders()
        val remaining = journal.filter { it.sequence > after.optLong(it.origin, 0) }.sortedWith(compareBy<SyncHeaderRow> { it.sequence }.thenBy { it.origin }).toMutableList()
        val result = JSONArray(); val proofs = JSONArray(); val known = mutableSetOf<String>(); var batchBytes = 256
        val allProofs = journal.filter { it.kind == "purge" && it.hasPayload }.map { SyncJournal.envelope(repo.rawDao, requireNotNull(repo.rawDao.syncRevision(it.id)), group) } + repo.rawDao.syncMetadataPrefix("purgeproof:%").map { JSONObject(it.value) }
        fun proofFor(envelope: JSONObject): JSONObject? {
            if (!envelope.isNull("payload")) return null
            val revision = envelope.getJSONObject("header").getJSONObject("revision"); val dot = revision.getJSONObject("dot"); val id = "${dot.getString("origin")}:${dot.getLong("sequence")}"; val entity = revision.getString("entityId")
            val thought = envelope.getJSONObject("header").getString("kind") in setOf("thought", "archiveThought")
            return allProofs.firstOrNull { p -> val body = p.getJSONObject("payload"); id in ids(body.optJSONArray("revisionIds")?.toString() ?: "[]") || thought && entity in ids(body.optJSONArray("entityIds")?.toString() ?: "[]") } ?: error("Erased revision has no signed purge proof")
        }
        while (result.length() < limit) {
            val next = remaining.firstOrNull { row -> val revision = SyncJournal.revision(row); val causal = revision.getJSONObject("context"); row.sequence == after.optLong(row.origin, 0) + 1L && causal.keys().asSequence().all { causal.getLong(it) <= after.optLong(it, 0) } } ?: break
            val envelope = SyncJournal.envelope(repo.rawDao, requireNotNull(repo.rawDao.syncRevision(next.id)), group); val proof = proofFor(envelope); val proofHash = proof?.let { hash(it.getJSONObject("header")) }
            val bytes = envelope.toString().toByteArray(Charsets.UTF_8).size + 2 + if (proof != null && proofHash !in known) proof.toString().toByteArray(Charsets.UTF_8).size + 2 else 0
            if (batchBytes + bytes > Backup.MAX_BYTES - 64 * 1024) { require(result.length() > 0) { "A saved version exceeds the sync message capacity" }; break }
            batchBytes += bytes
            result.put(envelope); if (proof != null && known.add(requireNotNull(proofHash))) proofs.put(proof)
            after.put(next.origin, next.sequence); remaining.remove(next)
        }
        return JSONObject().put("envelopes", result).put("more", remaining.isNotEmpty()).put("purgeProofs", proofs)
    }
    private fun apply(repo: Repository, input: JSONObject): JSONObject {
        val dao = repo.rawDao; val group = input.getString("groupId"); require(dao.syncMetadata("group")?.value == group) { "Unknown sync group" }
        val members = input.getJSONArray("members").let { a -> (0 until a.length()).map { a.getJSONObject(it) }.associateBy { it.getString("deviceId") } }
        val authorized = input.getJSONObject("authorizedHistory")
        val incoming = input.getJSONArray("envelopes"); require(incoming.length() <= 32) { "Too many operations" }
        val affected = mutableSetOf<Pair<String, String>>()
        var aliasChanged = false
        repo.db.runInTransaction {
            val anchors = input.optJSONObject("authorizedAnchors") ?: JSONObject()
            val acceptedProofs = mutableMapOf<String, Long>()
            fun authorizeProof(proof: JSONObject) {
                if (!proofAuthorized(repo, proof, authorized, anchors)) return
                applyPurge(repo, proof.getJSONObject("payload"))
                val dot = proof.getJSONObject("header").getJSONObject("revision").getJSONObject("dot")
                val origin = dot.getString("origin")
                acceptedProofs[origin] = maxOf(acceptedProofs[origin] ?: 0L, dot.getLong("sequence"))
            }
            val provisionalIds = mutableSetOf<String>(); val provisionalEntities = mutableSetOf<String>()
            val proofs = input.optJSONArray("purgeProofs") ?: JSONArray(); require(proofs.length() <= 32)
            for (index in 0 until proofs.length()) {
                val proof = proofs.getJSONObject(index); val header = proof.getJSONObject("header"); val revision = header.getJSONObject("revision"); val dot = revision.getJSONObject("dot"); val origin = dot.getString("origin"); val sequence = dot.getLong("sequence")
                val member = requireNotNull(members[origin]); require(sequence > 0 && (!authorized.has(origin) || sequence <= authorized.getLong(origin)))
                require(header.getString("kind") == "purge")
                SyncCore.request(JSONObject().put("action", "verifyEnvelope").put("envelope", proof).put("group", group).put("key", member.getString("signingPublic")).put("purged", false))
                val payload = proof.getJSONObject("payload"); validatePayload(repo, "purge", revision.getString("entityId"), payload)
                dao.originRevision(origin, sequence)?.let { require(hash(JSONObject(it.header).getJSONObject("header")) == hash(header)) { "Purge proof equivocates with its durable signed dot" } }
                dao.putSyncMetadata(SyncMetadataRow("purgeproof:${hash(header)}", proof.toString()))
                provisionalIds.addAll(ids(payload.getJSONArray("revisionIds").toString())); provisionalEntities.addAll(ids(payload.getJSONArray("entityIds").toString()))
                authorizeProof(proof)
            }
            val receipt = SyncJournal.receipts(dao, staged = true)
            val initialApplied = SyncJournal.receipts(dao)
            initialApplied.keys().asSequence().forEach { origin -> if (dao.syncMetadata("applied:$origin") == null) dao.putSyncMetadata(SyncMetadataRow("applied:$origin", initialApplied.getLong(origin).toString())) }
            for (index in 0 until incoming.length()) {
                val envelope = incoming.getJSONObject(index); val header = envelope.getJSONObject("header"); val revision = header.getJSONObject("revision")
                val dot = revision.getJSONObject("dot"); val origin = dot.getString("origin"); val sequence = dot.getLong("sequence"); require(sequence > 0)
                val revisionId = "$origin:$sequence"; val member = requireNotNull(members[origin]) { "Untrusted revision origin" }
                if (dao.syncMetadata("applied:$origin") == null) dao.putSyncMetadata(SyncMetadataRow("applied:$origin", "0"))
                require(!authorized.has(origin) || sequence <= authorized.getLong(origin)) { "This device was removed before this revision" }
                val payload = envelope.optJSONObject("payload")
                val kind = header.getString("kind"); require(kind in setOf("thought", "tag", "purge", "archiveThought", "archiveTag", "tagAlias")) { "Unknown operation kind" }
                val entityId = revision.getString("entityId"); val existing = dao.syncRevision(revisionId)
                if (kind in setOf("purge", "tagAlias")) require(dao.syncMetadata("purged:$revisionId") == null && revisionId !in provisionalIds) { "A purge cannot erase signed control history" }
                SyncCore.request(JSONObject().put("action", "verifyEnvelope").put("envelope", envelope).put("group", group).put("key", member.getString("signingPublic")).put("purged", dao.syncMetadata("purged:$revisionId") != null || isRetired(dao, kind, entityId) || revisionId in provisionalIds || kind in setOf("thought", "archiveThought") && entityId in provisionalEntities))
                if (existing != null) {
                    require(hash(JSONObject(existing.header).getJSONObject("header")) == hash(header)) { "Conflicting signed origin sequence. This identity needs to be quarantined." }
                    if (existing.payload == null && payload != null && dao.syncMetadata("purged:$revisionId") == null && !isRetired(dao, kind, entityId)) { validatePayload(repo, kind, entityId, payload); dao.hydrateRevisionPayload(revisionId, payload.toString()) }
                    continue
                }
                require(sequence == receipt.optLong(origin, 0) + 1L) { "Missing earlier durable origin revision" }
                val causal = revision.getJSONObject("context")
                require(causal.optLong(origin, 0) == sequence - 1L && causal.keys().asSequence().all { key -> causal.getLong(key) >= 0 && causal.getLong(key) <= receipt.optLong(key, 0) }) { "Missing causal revision dependency" }
                val previousRow = if (sequence == 1L) null else requireNotNull(dao.originRevision(origin, sequence - 1L))
                previousRow?.let { previous -> val context = SyncJournal.revision(previous).getJSONObject("context"); require(context.keys().asSequence().all { key -> context.getLong(key) <= causal.optLong(key, 0) }) { "Origin causal context moved backwards" } }
                val previous = previousRow?.let { hash(JSONObject(it.header).getJSONObject("header")) } ?: ""
                require(header.getString("previousHash") == previous) { "Broken signed origin chain" }
                val storedPayload = if (dao.syncMetadata("purged:$revisionId") != null || isRetired(dao, kind, entityId)) null else payload
                storedPayload?.let { validatePayload(repo, kind, entityId, it) }
                val stored = JSONObject(envelope.toString()).apply { remove("payload") }
                dao.insertSyncRevision(SyncRevisionRow(revisionId, kind, entityId, origin, sequence, stored.toString(), storedPayload?.toString()))
                receipt.put(origin, sequence)
                val clock = revision.getJSONObject("clock"); require(clock.getLong("wall") in 0..Backup.MAX_TIMESTAMP && clock.getLong("logical") >= 0) { "Invalid hybrid clock" }
            }
            // Stored headers can be acknowledged for paging, but are withheld from projection and
            // revocation witnesses until their causal dependencies and removal anchor are proved.
            dao.syncMetadataPrefix("purgeproof:%").forEach { stored -> authorizeProof(JSONObject(stored.value)) }
            val applied = SyncJournal.receipts(dao)
            var advanced: Boolean
            do {
                advanced = false
                dao.syncMetadataPrefix("purgeproof:%").forEach { stored -> authorizeProof(JSONObject(stored.value)) }
                receipt.keys().asSequence().sorted().forEach { origin ->
                    val through = applied.optLong(origin, 0); if (through >= receipt.getLong(origin)) return@forEach
                    if (authorized.has(origin)) {
                        if (through >= authorized.getLong(origin)) return@forEach
                        val anchor = anchors.optJSONObject(origin) ?: return@forEach
                        val anchorThrough = anchor.getLong("through")
                        if (anchorThrough == 0L) return@forEach
                        val anchorRow = dao.originRevision(origin, anchorThrough) ?: return@forEach
                        require(hash(JSONObject(anchorRow.header).getJSONObject("header")) == anchor.getString("headerHash")) { "Removed origin history does not match its witnessed signed checkpoint" }
                    }
                    val row = requireNotNull(dao.originRevision(origin, through + 1L)); val revision = SyncJournal.revision(row); val causal = revision.getJSONObject("context")
                    if (!causal.keys().asSequence().all { key -> causal.getLong(key) <= applied.optLong(key, 0) }) return@forEach
                    if (row.payload == null && dao.syncMetadata("purged:${row.id}") == null && !isRetired(dao, row.kind, row.entityId)) return@forEach
                    applied.put(origin, through + 1L); dao.putSyncMetadata(SyncMetadataRow("applied:$origin", (through + 1L).toString())); advanced = true; affected.add(row.kind to row.entityId)
                    val clock = revision.getJSONObject("clock"); val wall = clock.getLong("wall"); val logical = clock.getLong("logical"); val oldWall = dao.syncMetadata("clock.wall")?.value?.toLong() ?: 0L; val oldLogical = dao.syncMetadata("clock.logical")?.value?.toLong() ?: 0L
                    if (wall > oldWall || wall == oldWall && logical > oldLogical) { dao.putSyncMetadata(SyncMetadataRow("clock.wall", wall.toString())); dao.putSyncMetadata(SyncMetadataRow("clock.logical", logical.toString())) }
                    if (row.kind == "purge" && row.payload != null) applyPurge(repo, JSONObject(row.payload))
                    if (row.kind in setOf("archiveThought", "archiveTag") && row.payload != null && dao.syncMetadata("purged:${row.id}") == null && !isRetired(dao, row.kind, row.entityId)) { val archive = JSONObject(row.payload); dao.putRecovery(RecoveryRow(row.id, archive.getString("kind"), archive.getString("entityId"), archive.getJSONObject("payload").toString(), archive.getLong("createdAt"))) }
                    if (row.kind == "tagAlias" && row.payload != null) { TagAliases.apply(dao, JSONObject(row.payload)); aliasChanged = true }
                }
            } while (advanced)
            acceptedProofs.forEach { (origin, sequence) -> require(applied.optLong(origin, 0) >= sequence) { "Purge proof did not reach the applied causal receipt" } }
            affected.filter { it.first in setOf("thought", "tag") }.forEach { (kind, id) -> project(repo, kind, if (kind == "tag") TagAliases.canonical(dao, id) else id) }
            if (aliasChanged) { projectAliasTags(repo); TagAliases.projectReferences(dao) }
        }
        MediaFiles(context, repo).cleanup()
        if (incoming.length() > 0 || (input.optJSONArray("purgeProofs")?.length() ?: 0) > 0) Store.changed(context, localMutation = false)
        return JSONObject().put("receipts", SyncJournal.receipts(dao)).put("stagedReceipts", SyncJournal.receipts(dao, staged = true))
    }
    private fun proofAuthorized(repo: Repository, proof: JSONObject, authorized: JSONObject, anchors: JSONObject): Boolean {
        val dao = repo.rawDao
        val rows = dao.syncHeaders()
        val headers = JSONArray(rows.map { row -> JSONObject(row.header) })
        return SyncCore.request(JSONObject().put("action", "purgeEligible").put("proof", proof).put("headers", headers)
            .put("bodyPresent", JSONArray(rows.filter { it.hasPayload }.map { it.id }))
            .put("applied", SyncJournal.receipts(dao)).put("authorizedHistory", authorized).put("authorizedAnchors", anchors)
            .put("purged", JSONArray(dao.syncMetadataPrefix("purged:%").map { it.key.removePrefix("purged:") }))
            .put("retired", JSONArray(rows.filter { isRetired(dao, it.kind, it.entityId) }.map { it.entityId }.distinct())))
            .getBoolean("eligible")
    }
    private fun validatePayload(repo: Repository, kind: String, id: String, payload: JSONObject) {
        if (kind == "tagAlias") { val ids = ids(payload.getJSONArray("ids").toString()); require(ids.size in 2..10000 && ids == ids.distinct().sorted()); ids.forEach { require(java.util.UUID.fromString(it).toString() == it) }; SyncCore.request(JSONObject().put("action", "tagAliases").put("records", JSONArray().put(payload))); return }
        if (kind == "purge") { val revisions = payload.getJSONArray("revisionIds"); val entities = payload.getJSONArray("entityIds"); require(revisions.length() + entities.length() > 0); ids(revisions.toString()).forEach { require(it.isNotBlank() && it.length <= 256) }; ids(entities.toString()).forEach { require(java.util.UUID.fromString(it).toString() == it) }; return }
        if (kind in setOf("archiveThought", "archiveTag")) { val archivedKind = payload.getString("kind"); val createdAt = payload.get("createdAt"); require(archivedKind == if (kind == "archiveThought") "thought" else "tag"); require(payload.getString("entityId") == id); require(createdAt is Number && createdAt.toDouble().isFinite() && createdAt.toDouble() == createdAt.toLong().toDouble() && createdAt.toLong() in 0..Backup.MAX_TIMESTAMP); validatePayload(repo, archivedKind, id, payload.getJSONObject("payload")); return }
        require(payload.getString("id") == id) { "Payload identity does not match its signed header" }
        if (kind == "tag") { val name = payload.getString("name"); require(name == name.trim() && name.isNotBlank() && name.length <= 80 && payload.getString("type") in setOf("standard", "checklist")) { "Invalid category payload" }; return }
        val row = Backup.entry(payload, requireCompletion = true); val attachments = payload.getJSONArray("attachments")
        val media = (0 until attachments.length()).map { MediaBackup.parseMedia(attachments.getJSONObject(it)) }
        require(media.map { it.id } == ids(row.mediaIds)) { "Attachment metadata does not match references" }
        media.forEach { incoming -> val existing = repo.rawDao.media(incoming.id); require(existing == null || existing == incoming) { "Conflicting immutable attachment identity" }; if (existing == null) repo.rawDao.insertMedia(incoming) }
    }
    private fun project(repo: Repository, kind: String, id: String) {
        val dao = repo.rawDao; val applied = SyncJournal.receipts(dao); val rows = (if (kind == "tag") dao.syncRevisions().filter { it.kind == "tag" && TagAliases.canonical(dao, it.entityId) == id } else dao.entityRevisions(kind, id)).filter { it.sequence <= applied.optLong(it.origin, 0) }
        val result = SyncCore.request(JSONObject().put("action", "winner").put("revisions", JSONArray(rows.map { row -> SyncJournal.revision(row).also { if (kind == "tag") it.put("entityId", id) } })).put("retired", dao.retired(kind, id) != null))
        val winner = result.optJSONObject("revision"); val headId = winner?.getJSONObject("dot")?.let { "${it.getString("origin")}:${it.getLong("sequence")}" }
        val incoming = if (winner?.optBoolean("deleted") == false) headId?.let { dao.syncRevision(it)?.payload?.let(::JSONObject) } else null
        if (ShareStorage.personalProjection(dao, kind, id, incoming)) { if (headId != null) dao.putSyncMetadata(SyncMetadataRow("head:$kind:$id", headId)); return }
        rows.filter { it.payload != null && (it.id != headId || winner?.optBoolean("deleted") == true) && dao.syncMetadata("purged:${it.id}") == null }.forEach { dao.putRecovery(RecoveryRow(it.id, kind, it.entityId, requireNotNull(it.payload), SyncJournal.revision(it).getJSONObject("clock").getLong("wall"))) }
        if (winner == null || winner.getBoolean("deleted")) { if (kind == "thought") dao.deleteEntry(id) else dao.deleteTag(id) }
        else {
            // An authorized erased old winner can precede its newer live successor on a later page.
            // Keep the present projection until an available signed winner arrives.
            val body = headId?.let { dao.syncRevision(it)?.payload }
            if (body == null) { if (headId != null) dao.putSyncMetadata(SyncMetadataRow("head:$kind:$id", headId)); return }
            val payload = JSONObject(body)
            if (kind == "thought") { val raw = Backup.entry(payload, requireCompletion = true); val row = raw.copy(profileId = null, tagIds = jsonIds(TagAliases.map(dao, ids(raw.tagIds)))); if (dao.entry(id) == null) dao.insertEntry(row) else dao.updateEntry(row) }
            else dao.putTag(TagRow(id, payload.getString("name"), normalizeTag(payload.getString("name")), payload.getString("type")))
        }
        if (headId != null) dao.putSyncMetadata(SyncMetadataRow("head:$kind:$id", headId))
    }
    private fun applyPurge(repo: Repository, payload: JSONObject) {
        val dao = repo.rawDao
        ids(payload.getJSONArray("revisionIds").toString()).forEach { id ->
            val target = dao.syncRevision(id)
            require(target == null || target.kind in setOf("thought", "tag", "archiveThought", "archiveTag")) { "A purge cannot erase signed membership or control history" }
        }
        PurgeStorage.pending(repo)
        payload.optJSONArray("revisionIds")?.let { a -> ids(a.toString()).forEach { id -> dao.clearRevisionPayload(id); dao.clearRecovery(id); dao.putSyncMetadata(SyncMetadataRow("purged:$id", "1")) } }
        payload.optJSONArray("entityIds")?.let { a -> ids(a.toString()).forEach { id -> dao.putRetired(RetiredRow("thought", id)); dao.deleteEntry(id); dao.deleteSyncMetadata("provenance:thought:$id"); dao.syncRevisions().filter { it.kind in setOf("thought", "archiveThought") && it.entityId == id }.forEach { row -> dao.clearRevisionPayload(row.id); dao.clearRecovery(row.id); dao.putSyncMetadata(SyncMetadataRow("purged:${row.id}", "1")) } } }
    }
    private fun isRetired(dao: StoreDao, kind: String, id: String): Boolean = kind in setOf("thought", "archiveThought") && dao.retired("thought", id) != null
    private fun staging(id: String): File { require(java.util.UUID.fromString(id).toString() == id); return File(context.filesDir, "sync-media").apply { mkdirs() }.let { File(it, "$id.part") } }
    // Local garbage-collection references also include private drafts and transient edit pins.
    // A linked peer is authorized only by the currently shared saved library and Recovery.
    private fun sharedMedia(repo: Repository): Set<String> = (repo.rawDao.entries().flatMap { ids(it.mediaIds) } + repo.rawDao.recovery().flatMap { SyncJournal.mediaIds(JSONObject(it.payload)) }).toSet()
    private fun shareMedia(repo: Repository, scopeId: String): Set<String> {
        val scope = ShareStorage.registry(repo.rawDao).getJSONObject("scopes").getJSONObject(scopeId)
        require(ShareStorage.active(scope, repo.rawDao.syncMetadata("group")?.value)) { "You no longer belong to this shared hashtag" }
        val records = scope.getJSONArray("records")
        return (0 until records.length()).flatMap { SyncJournal.mediaIds(records.getJSONObject(it).getJSONObject("payload")) }.toSet()
    }
    private fun missingMedia(repo: Repository, limit: Int, referenced: Set<String> = sharedMedia(repo)): JSONObject {
        val files = MediaFiles(context, repo)
        val missing = repo.rawDao.media().filter { it.id in referenced && !files.file(it.id).isFile }
        return JSONObject().put("totalCount", missing.size).put("items", JSONArray(missing.take(limit).map { row -> JSONObject().put("id", row.id).put("checksum", row.checksum).put("size", row.byteSize).put("offset", staging(row.id).length().coerceAtMost(row.byteSize)).put("metadata", row.json()) }))
    }
    private fun readMedia(repo: Repository, input: JSONObject): JSONObject {
        val id = input.getString("id"); val row = requireNotNull(repo.rawDao.media(id)); val offset = input.getLong("offset"); val max = input.optInt("maxBytes", 16384).coerceIn(1, 16384)
        require(offset in 0..row.byteSize && id in sharedMedia(repo)) { "Invalid original-media read" }
        val file = MediaFiles(context, repo).file(id); require(file.isFile && file.length() == row.byteSize) { "Original media is pending" }
        val buffer = ByteArray(minOf(max.toLong(), row.byteSize - offset).toInt())
        RandomAccessFile(file, "r").use { it.seek(offset); it.readFully(buffer) }
        return JSONObject().put("bytes", SyncIdentity.hex(buffer)).put("eof", offset + buffer.size == row.byteSize)
    }
    private fun writeMedia(repo: Repository, input: JSONObject): JSONObject {
        val id = input.getString("id"); val row = MediaBackup.parseMedia(input.getJSONObject("metadata")); require(row.id == id && row.checksum == input.getString("checksum") && row.byteSize == input.getLong("size"))
        require(repo.rawDao.media(id) == row && id in sharedMedia(repo)) { "Unreferenced or conflicting attachment" }
        val bytes = SyncIdentity.decode(input.getString("bytes")); require(bytes.size <= 16384)
        val files = MediaFiles(context, repo); val offset = input.getLong("offset"); val target = staging(id)
        if (files.file(id).isFile) { require(files.intact(row)) { "Stored attachment checksum does not match" }; return JSONObject().put("offset", row.byteSize).put("complete", true) }
        require(offset >= 0 && offset == target.length() && offset + bytes.size <= row.byteSize && target.parentFile!!.usableSpace > MediaFiles.RESERVE + bytes.size) { "Invalid or unavailable attachment transfer offset" }
        RandomAccessFile(target, "rw").use { it.seek(offset); it.write(bytes); it.fd.sync() }
        val through = offset + bytes.size
        if (through == row.byteSize) {
            val digest = java.security.MessageDigest.getInstance("SHA-256"); java.security.DigestInputStream(target.inputStream(), digest).use { stream -> val buffer = ByteArray(65536); while (stream.read(buffer) >= 0) {} }
            if (SyncIdentity.hex(digest.digest()) != row.checksum) { target.delete(); error("Transferred original checksum mismatch") }
            check(target.renameTo(files.file(id))) { "Could not publish completed attachment" }
            runCatching { files.inspect(id, row.kind, row.mimeType, row.filename, row.byteSize, row.checksum) }
            Store.changed(context, localMutation = false)
        }
        return JSONObject().put("offset", through).put("complete", through == row.byteSize)
    }

    fun clearRecovery(repo: Repository, id: String) = repo.db.runInTransaction {
        if (ShareStorage.clearRecovery(repo.rawDao, id)) return@runInTransaction
        val item = requireNotNull(repo.rawDao.recoveryItem(id)) { "Recovery item no longer exists" }
        val retired = item.kind == "thought" && repo.rawDao.entry(item.entityId) == null
        val revisions = if (retired) repo.rawDao.entityRevisions("thought", item.entityId).map { it.id } else listOf(item.id)
        val payload = JSONObject().put("revisionIds", JSONArray(revisions)).put("entityIds", JSONArray(if (retired) listOf(item.entityId) else emptyList<String>()))
        SyncJournal.record(repo.rawDao, "purge", uid(), payload, false); applyPurge(repo, payload)
        repo.rawDao.clearRecovery(id)
    }
}
