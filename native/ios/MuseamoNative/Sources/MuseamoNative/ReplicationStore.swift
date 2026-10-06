import Foundation

extension LibraryStore {
    public func hasNetworkEnrollment() throws -> Bool { try metadata("group") != nil }
    func metadata(_ key: String) throws -> String? { try db.run("SELECT value FROM metadata WHERE key = ?", [key]).first?["value"] as? String }
    func setMetadata(_ key: String, _ value: String) throws { try db.run("INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]) }
    func metadataObject(_ key: String) throws -> [String: Any] { try metadata(key).map { try decode($0) } ?? [:] }
    public func configureSync(identity: @escaping () throws -> [String: Any], sign: @escaping (Data) throws -> String) { identityReader = identity; signer = sign }
    func nativeIdentity() throws -> [String: Any] {
        if let identityReader { return try identityReader() }
        let device = try metadata("device") ?? uid()
        try setMetadata("device", device)
        let identity = SyncIdentity(installation: device)
        let value = try identity.identity(create: metadata("identity.created") == nil && metadata("group") == nil, name: "iPhone")
        try setMetadata("identity.created", "1")
        return value
    }
    func signBytes(_ data: Data) throws -> String {
        if let signer { return try signer(data) }
        guard let device = try metadata("device") else { throw LibraryError("Device identity is unavailable.") }
        return try SyncIdentity(installation: device).sign(data)
    }
    func operation(_ origin: String, _ sequence: Int64) throws -> [String: Any]? {
        try db.run("SELECT envelope FROM sync_ops WHERE origin=? AND sequence=?", [origin, sequence]).first.map { try decode($0["envelope"]) }
    }
    func operations(_ condition: String = "verified=1", _ values: [Any] = []) throws -> [[String: Any]] {
        try db.run("SELECT envelope FROM sync_ops WHERE \(condition) ORDER BY sequence,origin", values).map { try decode($0["envelope"]) }
    }
    func revision(_ envelope: [String: Any]) throws -> [String: Any] { try object(object(envelope, "header"), "revision") }
    func dot(_ envelope: [String: Any]) throws -> [String: Any] { try object(revision(envelope), "dot") }
    func revisionID(_ envelope: [String: Any]) throws -> String { let value = try dot(envelope); return "\(try string(value, "origin")):\(try timestamp(value, "sequence"))" }
    func receipts(staged: Bool = false) throws -> [String: Int64] {
        var result: [String: Int64] = [:]
        for row in try db.run("SELECT origin,sequence FROM sync_ops WHERE \(staged ? "verified>0" : "verified=1") ORDER BY origin,sequence") {
            let origin = row["origin"] as! String, sequence = row["sequence"] as! Int64
            if sequence == (result[origin] ?? 0) + 1 { result[origin] = sequence }
        }
        return result
    }
    func isPurged(_ id: String) throws -> Bool { try !db.run("SELECT revision_id FROM purged WHERE revision_id=?", [id]).isEmpty }
    func isRetired(_ kind: String, _ id: String) throws -> Bool { try !db.run("SELECT id FROM retired WHERE kind=? AND id=?", [kind, id]).isEmpty }
    func canonicalTag(_ id: String) throws -> String { try db.run("SELECT canonical_id FROM tag_aliases WHERE source_id=?", [id]).first?["canonical_id"] as? String ?? id }

    @discardableResult
    func recordLocal(_ kind: String, _ id: String, _ input: [String: Any], deleted: Bool = false) throws -> String? {
        guard !projecting, let group = try metadata("group") else { return nil }
        let identity = try nativeIdentity(), origin = try string(identity, "deviceId")
        let sequence = (try receipts()[origin] ?? 0) + 1
        var payload = input; payload.removeValue(forKey: "revision"); payload.removeValue(forKey: "sharing"); payload.removeValue(forKey: "count")
        if kind == "thought" { payload["profileId"] = null }
        let wall = max(milliseconds(), Int64(try metadata("clock.wall") ?? "0") ?? 0)
        let logical = wall == Int64(try metadata("clock.wall") ?? "0") ? (Int64(try metadata("clock.logical") ?? "0") ?? 0) + 1 : 0
        var context = try receipts(); context[origin] = sequence - 1
        let version: [String: Any] = ["entityId": id, "dot": ["origin": origin, "sequence": sequence], "context": context,
            "clock": ["wall": wall, "logical": logical], "deleted": deleted, "payloadHash": try SyncCore.hash(payload)]
        let prior = try operation(origin, sequence - 1)
        let header: [String: Any] = ["protocol": 1, "group": group, "kind": kind, "previousHash": try prior.map { try SyncCore.hash(object($0, "header")) } ?? "", "revision": version]
        let bytes = try string(SyncCore.evaluate(["action": "headerBytes", "header": header]), "bytes")
        let envelope: [String: Any] = ["header": header, "signature": try signBytes(SyncCore.bytes(bytes)), "payload": payload]
        _ = try SyncCore.evaluate(["action": "validateOperation", "envelope": envelope])
        try db.run("INSERT INTO sync_ops VALUES(?,?,?,?,?,1)", [origin, sequence, kind, id, try encode(envelope)])
        try setMetadata("clock.wall", String(wall)); try setMetadata("clock.logical", String(logical))
        let token = "\(origin):\(sequence)"; try setMetadata("head:\(kind):\(id)", token)
        if kind == "tagAlias" { try rebuildAliases() }
        if kind == "purge" { try applyPurges() }
        return token
    }
    func enroll(_ group: String) throws {
        if let existing = try metadata("group") { guard existing == group else { throw LibraryError("This installation already belongs to another library.") }; return }
        _ = try nativeIdentity()
        try db.transaction {
            try setMetadata("group", group)
            for tag in try tags() { try recordLocal("tag", string(tag, "id"), tag) }
            for row in try db.run("SELECT payload FROM entries") { let value = try decode(row["payload"]); try recordLocal("thought", string(value, "id"), value) }
            for row in try db.run("SELECT * FROM recovery") {
                let kind = row["kind"] as! String, entity = row["entity_id"] as! String
                let archived: [String: Any] = ["kind": kind, "entityId": entity, "payload": try decode(row["payload"]), "createdAt": row["created_at"]!]
                let token = try recordLocal(kind == "tag" ? "archiveTag" : "archiveThought", entity, archived)!
                try db.run("UPDATE recovery SET id=? WHERE id=?", [token, row["id"]!])
            }
            try setMetadata("enrolled.v2", group)
        }
    }

    /// Called only by the trusted runtime, on the same queue as library mutations.
    public func nativeCall(_ method: String, _ input: [String: Any] = [:]) throws -> [String: Any] {
        switch method {
        case "syncIdentity": return try nativeIdentity()
        case "syncSign": return ["signature": try signBytes(SyncCore.bytes(string(input, "bytes")))]
        case "syncLoad": return ["state": try metadata("coordinator").map { try decode($0) } ?? null as Any]
        case "syncSave": try setMetadata("coordinator", encode(object(input, "state"))); return [:]
        case "syncEnroll": try enroll(string(input, "groupId")); return [:]
        case "syncSummary":
            let media = try referencedMedia(local: false)
            return ["thoughts": try db.run("SELECT id FROM entries").count, "tags": try tags().count, "attachments": media.count,
                "attachmentBytes": media.values.reduce(Int64(0)) { $0 + (($1["byteSize"] as? NSNumber)?.int64Value ?? 0) }]
        case "syncEnrollmentTags": return ["tags": try tags().filter { try sharingMetadata(string($0, "id")) == nil }]
        case "syncCoalesceTags": try coalesceTags(input); return [:]
        case "syncExport": return try exportChanges(input)
        case "syncApply": return try applyChanges(input)
        case "syncReceipts": return ["receipts": try receipts(), "stagedReceipts": try receipts(staged: true)]
        case "syncHeader": return ["hash": try operation(string(input, "origin"), timestamp(input, "sequence")).map { try SyncCore.hash(object($0, "header")) } ?? null as Any]
        case "syncSharingRequired": return ["required": try sharingBindings().values.contains { ($0["detached"] as? Bool) != true }]
        case "shareLoad", "sharePending", "shareSeed", "shareCommit": return try sharingCall(method, input)
        case "syncMissingMedia", "shareMissingMedia": return try missingMedia(input, shared: method.hasPrefix("share"))
        case "syncReadMedia", "shareReadMedia": return try readMedia(input, shared: method.hasPrefix("share"))
        case "syncWriteMedia", "shareWriteMedia": return try writeMedia(input, shared: method.hasPrefix("share"))
        default: throw LibraryError("Unknown native sync operation.")
        }
    }

    func exportChanges(_ input: [String: Any]) throws -> [String: Any] {
        guard try metadata("group") == string(input, "groupId") else { throw LibraryError("Wrong linked library.") }
        let after = input["after"] as? [String: Int64] ?? [:], limit = try integer(input, "limit", default: 32, minimum: 1, maximum: 32)
        let proofs = try operations("verified=1 AND kind='purge'")
        var result: [[String: Any]] = [], included: [String: [String: Any]] = [:], bytes = 64 * 1024, more = false
        for value in try operations() {
            let position = try dot(value)
            if try timestamp(position, "sequence") <= (after[string(position, "origin")] ?? 0) { continue }
            if result.count == limit { more = true; break }
            var required: [String: Any]?
            if value["payload"] is NSNull {
                let token = try revisionID(value), entity = try string(revision(value), "entityId")
                required = try proofs.first { proof in
                    let payload = try object(proof, "payload")
                    return (payload["revisionIds"] as? [String] ?? []).contains(token) || (payload["entityIds"] as? [String] ?? []).contains(entity)
                }
                guard required != nil else { throw LibraryError("Cleared history lacks an applied erasure proof.") }
            }
            let extra = try JSONSerialization.data(withJSONObject: value).count + (try required.map { included[try revisionID($0)] == nil ? JSONSerialization.data(withJSONObject: $0).count : 0 } ?? 0)
            if bytes + extra > 25 * 1024 * 1024 { guard !result.isEmpty else { throw LibraryError("Saved version exceeds the sync capacity.") }; more = true; break }
            if let required { included[try revisionID(required)] = required }
            bytes += extra; result.append(value)
        }
        return ["envelopes": result, "purgeProofs": Array(included.values), "more": more]
    }

    func applyChanges(_ input: [String: Any]) throws -> [String: Any] {
        let group = try string(input, "groupId")
        guard try metadata("group") == group else { throw LibraryError("Wrong linked library.") }
        let members = input["members"] as? [[String: Any]] ?? [], envelopes = input["envelopes"] as? [[String: Any]] ?? []
        guard envelopes.count <= 32 else { throw LibraryError("Too many changes in one batch.") }
        var keys: [String: String] = [:]
        for member in members {
            let id = try string(member, "deviceId"), key = try string(member, "signingPublic")
            guard keys[id] == nil else { throw LibraryError("Duplicate device membership.") }; keys[id] = key
        }
        let history = input["authorizedHistory"] as? [String: Int64] ?? [:]
        return try db.transaction {
            try setMetadata("authorizedHistory", encode(input["authorizedHistory"] as? [String: Any] ?? [:]))
            try setMetadata("authorizedAnchors", encode(input["authorizedAnchors"] as? [String: Any] ?? [:]))
            let proofs = input["purgeProofs"] as? [[String: Any]] ?? []
            guard proofs.count <= 32 else { throw LibraryError("Too many erasure proofs.") }
            for proof in proofs {
                let header = try object(proof, "header"), position = try dot(proof), origin = try string(position, "origin"), sequence = try timestamp(position, "sequence")
                guard header["kind"] as? String == "purge", let key = keys[origin], sequence <= (history[origin] ?? Int64.max) else { throw LibraryError("Unauthorized erasure proof.") }
                _ = try SyncCore.evaluate(["action": "verifyEnvelope", "envelope": proof, "group": group, "key": key, "purged": false])
                _ = try SyncCore.evaluate(["action": "validateOperation", "envelope": proof])
                let token = try revisionID(proof)
                if let previous = try metadata("proof:\(token)") { guard try SyncCore.hash(decode(previous)) == SyncCore.hash(proof) else { throw LibraryError("Conflicting erasure proof.") } }
                try setMetadata("proof:\(token)", encode(proof))
            }
            let allProofs = try db.run("SELECT value FROM metadata WHERE key LIKE 'proof:%'").map { try decode($0["value"]) }
            let provisional = Set(allProofs.flatMap { ($0["payload"] as? [String: Any])?["revisionIds"] as? [String] ?? [] })
            let retiring = Set(allProofs.flatMap { ($0["payload"] as? [String: Any])?["entityIds"] as? [String] ?? [] })
            for envelope in envelopes {
                let position = try dot(envelope), origin = try string(position, "origin"), sequence = try timestamp(position, "sequence")
                let version = try revision(envelope), entity = try string(version, "entityId"), header = try object(envelope, "header"), kind = try string(header, "kind")
                guard let key = keys[origin], sequence <= (history[origin] ?? Int64.max), (version["context"] as? [String: Int64] ?? [:]).keys.allSatisfy({ keys[$0] != nil }) else { throw LibraryError("Unauthorized signed history.") }
                let erased = try isPurged(revisionID(envelope)) || provisional.contains(revisionID(envelope)) || (["thought", "archiveThought"].contains(kind) && (isRetired("thought", entity) || retiring.contains(entity)))
                _ = try SyncCore.evaluate(["action": "verifyEnvelope", "envelope": envelope, "group": group, "key": key, "purged": erased])
                _ = try SyncCore.evaluate(["action": "validateOperation", "envelope": envelope])
                if let old = try operation(origin, sequence) {
                    guard try SyncCore.hash(object(old, "header")) == SyncCore.hash(header) else { throw LibraryError("Conflicting signed history; sync must be quarantined.") }
                    if old["payload"] is NSNull, !(envelope["payload"] is NSNull), try !isPurged(revisionID(envelope)), try !isRetired("thought", entity) {
                        try db.run("UPDATE sync_ops SET envelope=? WHERE origin=? AND sequence=?", [try encode(envelope), origin, sequence])
                    }
                    continue
                }
                try db.run("INSERT INTO sync_ops VALUES(?,?,?,?,?,0)", [origin, sequence, kind, entity, try encode(envelope)])
            }
            var changed = true
            while changed {
                changed = false; let staged = try receipts(staged: true)
                for value in try operations("verified=0") {
                    let position = try dot(value), origin = try string(position, "origin"), sequence = try timestamp(position, "sequence"), prefix = staged[origin] ?? 0
                    guard sequence == prefix + 1 else { continue }
                    let prior = try operation(origin, prefix), header = try object(value, "header")
                    guard try string(header, "previousHash", allowEmpty: true) == (prior.map { try SyncCore.hash(object($0, "header")) } ?? "") else { throw LibraryError("Signed history chain does not match.") }
                    let context = try object(revision(value), "context") as NSDictionary
                    if let prior {
                        for (key, amount) in try object(revision(prior), "context") { guard ((context[key] as? NSNumber)?.int64Value ?? 0) >= ((amount as? NSNumber)?.int64Value ?? 0) else { throw LibraryError("Signed change drops causal dependencies.") } }
                    }
                    try db.run("UPDATE sync_ops SET verified=2 WHERE origin=? AND sequence=?", [origin, sequence]); changed = true
                }
            }
            changed = true
            while changed {
                changed = false; try applyPurges(); let applied = try receipts()
                for value in try operations("verified=2") {
                    let position = try dot(value), origin = try string(position, "origin"), sequence = try timestamp(position, "sequence"), version = try revision(value), entity = try string(version, "entityId")
                    guard sequence == (applied[origin] ?? 0) + 1, (version["context"] as? [String: Int64] ?? [:]).allSatisfy({ (applied[$0.key] ?? 0) >= $0.value }), try anchorReady(origin), sequence <= (history[origin] ?? Int64.max) else { continue }
                    if value["payload"] is NSNull, try !isPurged(revisionID(value)), try !isRetired("thought", entity) { continue }
                    try db.run("UPDATE sync_ops SET verified=1 WHERE origin=? AND sequence=?", [origin, sequence])
                    try project(try string(object(value, "header"), "kind"), entity)
                    let clock = try object(version, "clock"), wall = try timestamp(clock, "wall")
                    if wall >= (Int64(try metadata("clock.wall") ?? "0") ?? 0) { try setMetadata("clock.wall", String(wall)); try setMetadata("clock.logical", String(try timestamp(clock, "logical") + 1)) }
                    changed = true
                }
            }
            try applyPurges()
            let applied = try receipts()
            for row in try db.run("SELECT value FROM metadata WHERE key LIKE 'erased:%'") { let position = try decode(row["value"]); guard (applied[try string(position, "origin")] ?? 0) >= (try timestamp(position, "sequence")) else { throw LibraryError("Erasure awaits complete applied causal history.") } }
            return ["receipts": applied, "stagedReceipts": try receipts(staged: true)]
        }
    }
}
