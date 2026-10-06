import Foundation

struct PersonalSharingProjection { let value: [String:Any]? }
extension LibraryStore {
    func sharingRegistry() throws -> [String:Any] { try metadata("sharing.registry").map { try decode($0) } ?? ["scopes":[String:Any](),"bindings":[String:Any](),"peers":[String:String]()] }
    func sharingBindings() throws -> [String:[String:Any]] { try sharingRegistry()["bindings"] as? [String:[String:Any]] ?? [:] }
    func scopeActive(_ scope: [String:Any], _ person: String) -> Bool {
        let controls = scope["controls"] as? [[String:Any]] ?? []
        if controls.contains(where: { ($0["body"] as? [String:Any])?["kind"] as? String == "stop" }) { return false }
        return controls.contains { control in
            guard let body = control["body"] as? [String:Any], ["open","grant"].contains(body["kind"] as? String ?? ""), (body["data"] as? [String:Any])?["participant"] as? String == person else { return false }
            return !controls.contains { revoked in guard let body = revoked["body"] as? [String:Any] else { return false }; return ["leave","remove"].contains(body["kind"] as? String ?? "") && (body["data"] as? [String:Any])?["grant"] as? String == control["id"] as? String }
        }
    }
    func sharingDeviceActive(_ scope: [String:Any]) throws -> Bool {
        guard let person = try metadata("group"), let proof = (scope["proofs"] as? [String:Any])?[person], let device = try nativeIdentity()["deviceId"] as? String else { return false }
        return try SyncCore.evaluate(["action":"sharingDeviceActive","proof":proof,"personal":metadataObject("coordinator"),"device":device])["active"] as? Bool == true
    }
    func sharingMetadata(_ tag: String) throws -> [String:Any]? {
        guard let person = try metadata("group") else { return nil }
        let registry = try sharingRegistry(), scopes = registry["scopes"] as? [String:[String:Any]] ?? [:]
        for (id,binding) in try sharingBindings() where binding["tagId"] as? String == tag && binding["detached"] as? Bool != true {
            guard let scope = scopes[id], scopeActive(scope,person) else { continue }
            let open = (scope["controls"] as? [[String:Any]] ?? []).first { ($0["body"] as? [String:Any])?["kind"] as? String == "open" }
            let owner = (open?["body"] as? [String:Any])?["participant"] as? String
            return ["collectionId":id,"role":owner == person ? "owner":"member","status":"waiting","lastSync":scope["lastSync"] ?? null]
        }
        return nil
    }
    func validateSharedTags(_ tags: [String]) throws { guard try tags.filter({ try sharingMetadata($0) != nil }).count <= 1 else { throw LibraryError("A thought can belong to only one shared hashtag. Your draft is kept.") } }
    func sharedPayload(_ value: [String:Any]) throws -> [String:Any] { try SyncCore.evaluate(["action":"sharedPayload","payload":value]) }
    func localSharingID(_ scope: String,_ person: String,_ item: String) throws -> String { try string(SyncCore.evaluate(["action":"sharingLocalId","scope":scope,"participant":person,"item":item]),"id") }
    func queueShared(_ input: [String:Any]) throws {
        var pending = input; let id = uid(); pending["id"] = id
        try db.run("INSERT INTO sharing_pending VALUES(?,?,?)",[id,try encode(pending),milliseconds()])
    }
    func recordShared(_ kind: String,_ entity: String,_ value: [String:Any],old: [String:Any]?,deleted: Bool = false) throws {
        guard !projecting, !sharingProjection else { return }
        let bindings = try sharingBindings()
        if kind == "tag" {
            guard let (scope,binding) = bindings.first(where: { $0.value["tagId"] as? String == entity && $0.value["detached"] as? Bool != true }), old != nil else { return }
            guard try sharingMetadata(entity)?["role"] as? String == "owner" else { throw LibraryError("Only the creator can change this shared hashtag.") }
            guard let stored = (try sharingRegistry()["scopes"] as? [String:[String:Any]])?[scope], try sharingDeviceActive(stored) else { throw LibraryError("This device no longer has shared access.") }
            try queueShared(["scope":scope,"grant":binding["grant"]!,"kind":"metadata","payload":value]); return
        }
        guard kind == "thought" else { return }
        let prior = bindings.first { $0.value["detached"] as? Bool != true && ($0.value["entries"] as? [String:String] ?? [:]).values.contains(entity) }
        let selected = bindings.first { $0.value["detached"] as? Bool != true && (value["tagIds"] as? [String] ?? []).contains($0.value["tagId"] as? String ?? "") }
        guard prior == nil || selected == nil || prior?.key == selected?.key else { throw LibraryError("Remove the current shared hashtag and save its private copy before adding another. Your draft is kept.") }
        guard let (scopeID,binding) = prior ?? selected else { return }
        guard let scope = (try sharingRegistry()["scopes"] as? [String:[String:Any]])?[scopeID], let person = try metadata("group"), scopeActive(scope,person), try sharingDeviceActive(scope) else { throw LibraryError("You no longer belong to this shared hashtag. Your writing is kept.") }
        let item = (binding["entries"] as? [String:String] ?? [:]).first { $0.value == entity }?.key ?? entity
        var payload = try sharedPayload(value); payload["id"] = item
        let removing = deleted || prior != nil && selected?.key != scopeID
        if !removing, prior != nil, let old { var oldPayload = try sharedPayload(old); oldPayload["id"] = item; if try SyncCore.hash(oldPayload) == SyncCore.hash(payload) { return } }
        var context: [String:Int64] = [:]
        for record in scope["records"] as? [[String:Any]] ?? [] { let position = try dot(["header":["revision":record["revision"]!]]); let origin = try string(position,"origin"); context[origin] = max(context[origin] ?? 0,try timestamp(position,"sequence")) }
        let pendingID = uid()
        let pending: [String:Any] = ["id":pendingID,"scope":scopeID,"grant":binding["grant"]!,"kind":"thought","entityId":item,"localId":entity,"payload":payload,"deleted":removing,"context":context]
        try db.run("INSERT INTO sharing_pending VALUES(?,?,?)",[pendingID,try encode(pending),milliseconds()])
        if removing && !deleted {
            var copy = value; copy["id"] = try localSharingID(scopeID,person,"\(item):detached:\(pendingID)")
            copy["tagIds"] = (value["tagIds"] as? [String] ?? []).filter { tag in bindings.values.allSatisfy { $0["detached"] as? Bool == true || $0["tagId"] as? String != tag } }
            let before = sharingProjection; sharingProjection = true; defer { sharingProjection = before }; try putEntry(copy)
        }
    }
    func sharingSeed(_ tagID: String) throws -> [String:Any] {
        guard let tag = try tags().first(where: { $0["id"] as? String == tagID }) else { throw LibraryError("Hashtag no longer exists.") }
        let entries = try db.run("SELECT e.payload FROM entries e JOIN entry_tags et ON et.entry_id=e.id WHERE et.tag_id=? ORDER BY e.id",[tagID]).map { try decode($0["payload"]) }
        for entry in entries { guard try strings(entry,"tagIds").allSatisfy({ try sharingMetadata($0) == nil }) else { throw LibraryError("Some thoughts already belong to another shared list.") } }
        return ["tag":["id":tagID,"name":tag["name"]!,"type":tag["type"]!],"entries":try entries.map(sharedPayload)]
    }
    func sharingCall(_ method: String,_ input: [String:Any]) throws -> [String:Any] {
        switch method {
        case "shareLoad": return ["registry":try metadata("sharing.registry").map { try decode($0) } ?? null as Any]
        case "sharePending": return ["items":try db.run("SELECT payload FROM sharing_pending ORDER BY created_at,id").map { try decode($0["payload"]) }]
        case "shareSeed": return try sharingSeed(string(input,"tagId"))
        case "shareCommit": let result = try db.transaction { try commitSharing(input) }; try finishErasure(); return result
        default: throw LibraryError("Unknown sharing storage operation.")
        }
    }
    func commitSharing(_ input: [String:Any]) throws -> [String:Any] {
        if let seed = input["seed"] as? [String:Any] { guard try SyncCore.hash(seed) == SyncCore.hash(sharingSeed(string(object(seed,"tag"),"id"))) else { throw LibraryError("This hashtag changed while sharing started. Try again.") } }
        var next = try object(input,"registry"), bindings = next["bindings"] as? [String:[String:Any]] ?? [:]
        let previous = try sharingBindings(), person = try string(input,"participant"), scopes = next["scopes"] as? [String:[String:Any]] ?? [:]
        for id in input["ack"] as? [String] ?? [] { try db.run("DELETE FROM sharing_pending WHERE id=?",[id]) }
        let pending = Set(try db.run("SELECT payload FROM sharing_pending").compactMap { try decode($0["payload"])["localId"] as? String })
        let before = sharingProjection; sharingProjection = true; defer { sharingProjection = before }
        for projection in input["projections"] as? [[String:Any]] ?? [] {
            let scopeID = try string(projection,"collectionId")
            guard var binding = bindings[scopeID], let scope = scopes[scopeID] else { throw LibraryError("Missing sharing binding.") }
            if !scopeActive(scope,person) { binding["detached"] = true }
            if binding["detached"] as? Bool == true {
                if let old = previous[scopeID], old["detached"] as? Bool != true { try detachSharing(scopeID,person,old) }
                bindings[scopeID] = binding; continue
            }
            let tagID = try string(binding,"tagId")
            var tag = try object(projection,"tag"); tag["id"] = tagID
            let oldTag = try tags().first { $0["id"] as? String == tagID }
            if oldTag?["name"] as? String != tag["name"] as? String || oldTag?["type"] as? String != tag["type"] as? String { try putProjectedTag(tag); try recordLocal("tag",tagID,tag) }
            var mappings = binding["entries"] as? [String:String] ?? [:]
            for item in projection["items"] as? [[String:Any]] ?? [] {
                let itemID = try string(item,"itemId"), entryID = try mappings[itemID] ?? localSharingID(scopeID,person,"\(tagID):\(itemID)")
                mappings[itemID] = entryID
                if pending.contains(entryID) { continue }
                let old = try entry(entryID)
                if item["deleted"] as? Bool == true {
                    if let old { try recover(old); try recordLocal("thought",entryID,old,deleted:true); try db.run("DELETE FROM entries WHERE id=?",[entryID]) }
                    continue
                }
                var value = try object(item,"payload"); value["id"] = entryID; value["starred"] = old?["starred"] ?? false; value["profileId"] = old?["profileId"] ?? null
                value["tagIds"] = (old?["tagIds"] as? [String] ?? []).filter { tag in previous.values.allSatisfy { $0["detached"] as? Bool == true || $0["tagId"] as? String != tag } && tag != tagID } + [tagID]
                value["revision"] = try string(item,"revision")
                for media in value["attachments"] as? [[String:Any]] ?? [] { try registerMedia(media) }
                var compare = old; compare?.removeValue(forKey:"revision"); var body = value; body.removeValue(forKey:"revision")
                if try compare.map(SyncCore.hash) != SyncCore.hash(body) { try putEntry(value) }
            }
            binding["entries"] = mappings; bindings[scopeID] = binding
            try db.run("DELETE FROM recovery WHERE id LIKE ?",["shared:\(scopeID):%"])
            for history in projection["recovery"] as? [[String:Any]] ?? [] {
                guard let entryID = mappings[try string(history,"itemId")] else { continue }
                var payload = try object(history,"payload"); payload["id"] = entryID; payload["starred"] = false; payload["profileId"] = null; payload["tagIds"] = [tagID]
                for media in payload["attachments"] as? [[String:Any]] ?? [] { try registerMedia(media) }
                try db.run("INSERT OR IGNORE INTO recovery(id,entity_id,created_at,payload,kind) VALUES(?,?,?,?,'thought')",[try string(history,"id"),entryID,try timestamp(history,"createdAt"),try encode(payload)])
            }
        }
        next["bindings"] = bindings; try setMetadata("sharing.registry",encode(next)); return ["registry":next]
    }
    func detachSharing(_ scope: String,_ person: String,_ binding: [String:Any]) throws {
        let tagID = try string(binding,"tagId")
        guard var tag = try tags().first(where: { $0["id"] as? String == tagID }) else { return }
        let originalTag = tag
        let privateTag = try localSharingID(scope,person,"\(tagID):private"); tag["id"] = privateTag; tag.removeValue(forKey:"sharing")
        try putProjectedTag(tag); try recordLocal("tag",privateTag,tag)
        for id in (binding["entries"] as? [String:String] ?? [:]).values {
            guard let old = try entry(id) else { continue }
            var copy = old; copy["id"] = try localSharingID(scope,person,"\(id):private:\(tagID)"); copy["tagIds"] = (old["tagIds"] as? [String] ?? []).filter { $0 != tagID } + [privateTag]
            try putEntry(copy); try recordLocal("thought",id,old,deleted:true); try db.run("DELETE FROM entries WHERE id=?",[id])
        }
        try db.run("DELETE FROM recovery WHERE id LIKE ?",["shared:\(scope):%"])
        try recordLocal("tag",tagID,originalTag,deleted:true); try db.run("DELETE FROM tags WHERE id=?",[tagID])
    }
    func personalSharingProjection(_ kind: String,_ entity: String,_ incoming: [String:Any]?) throws -> PersonalSharingProjection? {
        guard !sharingProjection, let (scopeID,binding) = try sharingBindings().first(where: { $0.value["detached"] as? Bool != true && (kind == "tag" ? $0.value["tagId"] as? String == entity : ($0.value["entries"] as? [String:String] ?? [:]).values.contains(entity)) }) else { return nil }
        let projections = try SyncCore.evaluate(["action":"sharingProjectionItems","registry":sharingRegistry()])["items"] as? [[String:Any]] ?? []
        guard let projection = projections.first(where: { $0["collectionId"] as? String == scopeID }) else { throw LibraryError("Missing shared projection.") }
        if kind == "tag" { var value = try object(projection,"tag"); value["id"] = entity; return PersonalSharingProjection(value:value) }
        let itemID = (binding["entries"] as? [String:String] ?? [:]).first { $0.value == entity }?.key
        let head = (projection["items"] as? [[String:Any]] ?? []).first { $0["itemId"] as? String == itemID }
        let pending = try db.run("SELECT payload FROM sharing_pending WHERE json_extract(payload,'$.localId')=? ORDER BY created_at DESC,rowid DESC LIMIT 1",[entity]).first.map { try decode($0["payload"]) }
        guard let source = pending ?? head, source["deleted"] as? Bool != true, var value = source["payload"] as? [String:Any] else { return PersonalSharingProjection(value:nil) }
        let old = try entry(entity), personal = incoming ?? old
        value["id"] = entity; value["starred"] = personal?["starred"] ?? false; value["profileId"] = old?["profileId"] ?? null
        let bindings = try sharingBindings()
        value["tagIds"] = (personal?["tagIds"] as? [String] ?? []).filter { tag in bindings.values.allSatisfy { $0["detached"] as? Bool == true || $0["tagId"] as? String != tag } } + [try string(binding,"tagId")]
        return PersonalSharingProjection(value:value)
    }
}
