import Foundation

extension LibraryStore {
    func anchorReady(_ origin: String) throws -> Bool {
        guard let anchor = try metadataObject("authorizedAnchors")[origin] as? [String: Any] else { return true }
        let through = try timestamp(anchor, "through")
        guard through > 0, (try receipts(staged: true)[origin] ?? 0) >= through, let value = try operation(origin, through) else { return false }
        guard try SyncCore.hash(object(value, "header")) == string(anchor, "headerHash") else { throw LibraryError("Removed-device history differs from the witnessed checkpoint.") }
        return true
    }
    func putProjectedTag(_ value: [String: Any]) throws {
        let id = try string(value, "id"), name = try string(value, "name"), type = try string(value, "type")
        try db.run("INSERT INTO tags(id,name,normalized_name,type) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,normalized_name=excluded.normalized_name,type=excluded.type", [id,name,Hashtags.normalized(name),type])
    }
    func rebuildAliases() throws {
        let records = try operations("verified=1 AND kind='tagAlias'").map { try object($0, "payload") }
        let aliases = try SyncCore.evaluate(["action":"tagAliases", "records":records])["aliases"] as? [String:String] ?? [:]
        try db.run("DELETE FROM tag_aliases")
        for (source, canonical) in aliases { try db.run("INSERT INTO tag_aliases VALUES(?,?)", [source,canonical]) }
        let tagsToProject = Set(try operations("verified=1 AND kind='tag'").map { try canonicalTag(string(revision($0), "entityId")) })
        // Rebuild associations via payloads after aliases have settled, without manufacturing edits.
        for (source, canonical) in aliases where source != canonical { try db.run("DELETE FROM tags WHERE id=?", [source]) }
        for tag in tagsToProject { try project("tag", tag) }
        for row in try db.run("SELECT payload FROM entries") {
            var value = try decode(row["payload"])
            value["tagIds"] = Array(Set(try strings(value,"tagIds").map(canonicalTag)))
            let wasProjecting = projecting; projecting = true; defer { projecting = wasProjecting }
            try putEntry(value)
        }
        for row in try db.run("SELECT payload FROM drafts") { var value = try decode(row["payload"]); value["tagIds"] = try validTags(Array(Set(strings(value,"tagIds").map(canonicalTag)))); try putDraft(value) }
    }
    func coalesceTags(_ input: [String:Any]) throws {
        let marker = "coalesced:\(try string(input,"enrollmentId"))"
        if try metadata(marker) != nil { return }
        let local = input["localTags"] as? [[String:Any]] ?? [], peer = input["peerTags"] as? [[String:Any]] ?? []
        func groups(_ values: [[String:Any]]) throws -> [String:[String]] {
            var result: [String:[String]] = [:]
            for value in values {
                let id = try string(value,"id"), normalized = Hashtags.normalized(try string(value,"name")), type = try string(value,"type")
                guard try sharingMetadata(id) == nil, let current = try tags().first(where: { $0["id"] as? String == (try canonicalTag(id)) }), Hashtags.normalized(current["name"] as! String) == normalized, current["type"] as? String == type else { continue }
                result[normalized + "\u{0}" + type, default: []].append(id)
            }
            return result
        }
        let lhs = try groups(local), rhs = try groups(peer)
        try db.transaction {
            for (key, ids) in lhs {
                guard ids.count == 1, let other = rhs[key], other.count == 1, ids[0] != other[0] else { continue }
                let parts = key.components(separatedBy: "\u{0}")
                try recordLocal("tagAlias", uid(), ["ids": Array(Set(ids+other)).sorted(), "normalizedName":parts[0], "type":parts[1]])
            }
            try setMetadata(marker,"1")
        }
    }
    func project(_ kind: String, _ source: String) throws {
        if kind == "purge" { try applyPurges(); return }
        if kind == "tagAlias" { try rebuildAliases(); return }
        if kind == "archiveThought" || kind == "archiveTag" {
            for value in try operations("verified=1 AND kind=? AND entity_id=?", [kind,source]) {
                let token = try revisionID(value)
                guard try !isPurged(token), try !isRetired("thought",source), let archive = value["payload"] as? [String:Any] else { continue }
                try db.run("INSERT OR IGNORE INTO recovery(id,entity_id,created_at,payload,kind) VALUES(?,?,?,?,?)", [token,source,archive["createdAt"]!,try encode(object(archive,"payload")),archive["kind"]!])
            }
            return
        }
        let entity = kind == "tag" ? try canonicalTag(source) : source
        let values = try operations("verified=1 AND kind=?",[kind]).filter { value in
            let id = try string(revision(value),"entityId"); return kind == "tag" ? try canonicalTag(id) == entity : id == entity
        }
        let versions = try values.map { value -> [String:Any] in var version = try revision(value); version["entityId"] = entity; return version }
        let selected = try SyncCore.evaluate(["action":"winner", "revisions":versions, "retired":isRetired(kind,entity)])["revision"] as? [String:Any]
        let selectedID = try selected.map { value -> String in let position = try object(value,"dot"); return "\(try string(position,"origin")):\(try timestamp(position,"sequence"))" }
        var incoming = try values.first { try revisionID($0) == selectedID }?["payload"] as? [String:Any]
        if selected?["deleted"] as? Bool == true { incoming = nil }
        if let shared = try personalSharingProjection(kind,entity,incoming) { incoming = shared.value }
        let wasProjecting = projecting; projecting = true; defer { projecting = wasProjecting }
        if var incoming {
            incoming["id"] = entity; incoming["revision"] = selectedID ?? uid()
            if kind == "thought" {
                incoming["profileId"] = try entry(entity)?["profileId"] ?? null
                incoming["tagIds"] = try validTags(Array(Set(strings(incoming,"tagIds").map(canonicalTag))))
                for media in incoming["attachments"] as? [[String:Any]] ?? [] { try registerMedia(media) }
                try putEntry(incoming)
            } else { try putProjectedTag(incoming) }
        } else { try db.run("DELETE FROM \(kind == "thought" ? "entries" : "tags") WHERE id=?",[entity]) }
        if let selectedID { try setMetadata("head:\(kind):\(entity)",selectedID) }
        for value in values {
            let token = try revisionID(value)
            if token == selectedID, selected?["deleted"] as? Bool != true { try db.run("DELETE FROM recovery WHERE id=?",[token]); continue }
            guard try !isPurged(token), let payload = value["payload"] as? [String:Any], try !isRetired(kind,entity) else { continue }
            try db.run("INSERT OR IGNORE INTO recovery(id,entity_id,created_at,payload,kind) VALUES(?,?,?,?,?)",[token,entity,try timestamp(object(revision(value),"clock"),"wall"),try encode(payload),kind])
        }
    }
    func applyPurges() throws {
        let proofs = try operations("verified=1 AND kind='purge'") + db.run("SELECT value FROM metadata WHERE key LIKE 'proof:%'").map { try decode($0["value"]) }
        for proof in proofs {
            let position = try dot(proof), origin = try string(position,"origin"), sequence = try timestamp(position,"sequence"), token = try revisionID(proof)
            guard let stored = try db.run("SELECT envelope,verified FROM sync_ops WHERE origin=? AND sequence=?",[origin,sequence]).first, (stored["verified"] as? Int64 ?? 0) > 0 else { continue }
            guard try SyncCore.hash(object(decode(stored["envelope"]),"header")) == SyncCore.hash(object(proof,"header")) else { throw LibraryError("Erasure proof conflicts with durable history.") }
            let values = try operations("verified>0")
            let bodyPresent = try values.filter { !($0["payload"] is NSNull) }.map(revisionID)
            let headers = try values.map { value -> [String:Any] in var value = value; if try revisionID(value) != token { value["payload"] = null }; return value }
            let request: [String:Any] = ["action":"purgeEligible", "proof":proof,"headers":headers,"bodyPresent":bodyPresent,"applied":try receipts(),
                "authorizedHistory":try metadataObject("authorizedHistory"),"authorizedAnchors":try metadataObject("authorizedAnchors"),
                "purged":try db.run("SELECT revision_id FROM purged").map { $0["revision_id"]! },"retired":try db.run("SELECT id FROM retired WHERE kind='thought'").map { $0["id"]! }]
            guard try SyncCore.evaluate(request)["eligible"] as? Bool == true else { continue }
            let payload = try object(proof,"payload")
            try setMetadata("erased:\(token)",encode(position))
            for id in try strings(payload,"revisionIds") {
                try db.run("INSERT OR IGNORE INTO purged VALUES(?)",[id]); try db.run("DELETE FROM recovery WHERE id=?",[id])
                for value in try operations() where try revisionID(value) == id {
                    let header = try object(value,"header"); guard !["purge","tagAlias"].contains(try string(header,"kind")) else { throw LibraryError("Erasure cannot remove control proofs.") }
                    var stripped = value; stripped["payload"] = null; let dot = try self.dot(value)
                    try db.run("UPDATE sync_ops SET envelope=? WHERE origin=? AND sequence=?",[try encode(stripped),dot["origin"]!,dot["sequence"]!])
                }
            }
            for entity in try strings(payload,"entityIds") {
                try db.run("INSERT OR IGNORE INTO retired VALUES('thought',?)",[entity]); try db.run("DELETE FROM entries WHERE id=?",[entity]); try db.run("DELETE FROM recovery WHERE entity_id=? AND kind='thought'",[entity])
                for value in try operations("kind IN ('thought','archiveThought') AND entity_id=?",[entity]) { var stripped = value; stripped["payload"] = null; let dot = try self.dot(value); try db.run("UPDATE sync_ops SET envelope=? WHERE origin=? AND sequence=?",[try encode(stripped),dot["origin"]!,dot["sequence"]!]) }
            }
        }
    }
    func clearRecovery(_ only: String?) throws {
        let rows = try db.run("SELECT * FROM recovery" + (only == nil ? "" : " WHERE id=?"), only.map { [$0] } ?? [])
        var privateRows: [[String:Any]] = []
        for row in rows {
            let id = row["id"] as! String
            if id.hasPrefix("shared:") {
                let parts = id.split(separator:":",maxSplits:2).map(String.init)
                guard parts.count == 3, let binding = try sharingBindings()[parts[1]], try sharingMetadata(binding["tagId"] as! String) != nil else { throw LibraryError("You no longer belong to this shared hashtag.") }
                try queueShared(["scope":parts[1],"grant":binding["grant"]!,"kind":"purge","revisionId":parts[2]])
                try db.run("DELETE FROM recovery WHERE id=?",[id])
            } else { privateRows.append(row) }
        }
        if try metadata("group") != nil, !privateRows.isEmpty {
            let entities = try privateRows.filter { ($0["kind"] as? String) == "thought" && (try entry($0["entity_id"] as! String)) == nil }.map { $0["entity_id"]! }
            try recordLocal("purge",uid(),["revisionIds":privateRows.map { $0["id"]! },"entityIds":entities])
        } else { for row in privateRows { try db.run("DELETE FROM recovery WHERE id=?",[row["id"]!]) } }
    }
}
