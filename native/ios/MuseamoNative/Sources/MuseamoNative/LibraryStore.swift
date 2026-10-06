import Foundation
import CoreFoundation

/// Durable offline library. The host must call this instance from a serial queue.
public final class LibraryStore {
    let db: SQLite
    let null = NSNull()
    private static let schemaVersion: Int64 = 2
    public let directory: URL
    let migrationSnapshot: URL
    var projecting = false
    var sharingProjection = false
    var identityReader: (() throws -> [String: Any])?
    var signer: ((Data) throws -> String)?
    var mediaPins = Set<String>()

    public init(databaseURL: URL) throws {
        directory = databaseURL.deletingLastPathComponent()
        migrationSnapshot = databaseURL.appendingPathExtension("before-connected-v2")
        db = try SQLite(url: databaseURL)
        try migrate(snapshotURL: databaseURL.appendingPathExtension("before-connected-v2"))
        try finishErasure()
    }

    func migrate(snapshotURL: URL) throws {
        let version = (try db.run("PRAGMA user_version").first?["user_version"] as? Int64) ?? 0
        guard version <= Self.schemaVersion else { throw LibraryError("This library was created by a newer version of Museamo.") }
        if version == 0 {
            try db.transaction {
                try db.run("CREATE TABLE tags (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, type TEXT NOT NULL CHECK(type IN ('standard','checklist')))")
                try db.run("CREATE TABLE entries (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, completed INTEGER NOT NULL, starred INTEGER NOT NULL, search_text TEXT NOT NULL, payload TEXT NOT NULL)")
                try db.run("CREATE INDEX entries_newest ON entries(created_at DESC, id DESC)")
                try db.run("CREATE INDEX entries_checklist ON entries(completed, created_at DESC, id DESC)")
                try db.run("CREATE TABLE entry_tags (entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(entry_id, tag_id))")
                try db.run("CREATE INDEX entry_tags_tag ON entry_tags(tag_id, entry_id)")
                try db.run("CREATE TABLE profiles (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)")
                try db.run("CREATE TABLE drafts (profile_key TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)")
                try db.run("CREATE TABLE commits (entry_id TEXT PRIMARY KEY NOT NULL, profile_key TEXT NOT NULL)")
                try db.run("CREATE TABLE recovery (id TEXT PRIMARY KEY NOT NULL, entity_id TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL)")
                try db.run("CREATE INDEX recovery_newest ON recovery(created_at DESC, id DESC)")
                try db.run("PRAGMA user_version = 1")
            }
        }
        if version < 2 {
            if version == 1 { try db.snapshot(to: snapshotURL) }
            try db.transaction {
                try db.run("CREATE TEMP TABLE preserved_entry_tags AS SELECT * FROM entry_tags")
                try db.run("DROP TABLE entry_tags")
                try db.run("CREATE TABLE tags_next (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, normalized_name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('standard','checklist')))")
                try db.run("INSERT INTO tags_next SELECT * FROM tags")
                try db.run("DROP TABLE tags")
                try db.run("ALTER TABLE tags_next RENAME TO tags")
                try db.run("CREATE INDEX tags_name ON tags(normalized_name)")
                try db.run("CREATE TABLE entry_tags (entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(entry_id,tag_id))")
                try db.run("INSERT INTO entry_tags SELECT * FROM preserved_entry_tags")
                try db.run("DROP TABLE preserved_entry_tags")
                try db.run("CREATE INDEX entry_tags_tag ON entry_tags(tag_id,entry_id)")
                try db.run("ALTER TABLE recovery ADD COLUMN kind TEXT NOT NULL DEFAULT 'thought'")
                try db.run("CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)")
                try db.run("CREATE TABLE sync_ops (origin TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, envelope TEXT NOT NULL, verified INTEGER NOT NULL, PRIMARY KEY(origin,sequence))")
                try db.run("CREATE INDEX sync_entities ON sync_ops(kind,entity_id)")
                try db.run("CREATE TABLE purged (revision_id TEXT PRIMARY KEY NOT NULL)")
                try db.run("CREATE TABLE retired (kind TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(kind,id))")
                try db.run("CREATE TABLE tag_aliases (source_id TEXT PRIMARY KEY,canonical_id TEXT NOT NULL)")
                try db.run("CREATE TABLE sharing_pending (id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL)")
                try db.run("CREATE TABLE media (id TEXT PRIMARY KEY,payload TEXT NOT NULL)")
                try db.run("PRAGMA user_version = 2")
            }
        }
    }

    /// Bridge response dictionaries contain only JSON-compatible values.
    @discardableResult
    public func execute(method: String, input: [String: Any] = [:]) throws -> [String: Any] {
        switch method {
        case "library": return try library()
        case "queryEntries": return try queryEntries(input)
        case "getEntry": return ["entry": try entry(string(input, "id")) ?? null as Any]
        case "listRecovery":
            return ["items": try db.run("SELECT * FROM recovery ORDER BY created_at DESC, id DESC").map { row in
                ["id": row["id"]!, "kind": row["kind"]!, "entityId": row["entity_id"]!, "createdAt": row["created_at"]!, "payload": try decode(row["payload"])] as [String: Any]
            }]
        default:
            let result = try db.transaction { try mutate(method, input) }
            try finishErasure()
            return result
        }
    }

    /// Physical cleanup follows the durable proof transaction and is retryable after a crash.
    func finishErasure() throws {
        guard try metadata("cleanup.erasure") != nil else { return }
        for url in [migrationSnapshot, migrationSnapshot.appendingPathExtension("tmp")] where FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        guard (try db.run("PRAGMA wal_checkpoint(TRUNCATE)").first?["busy"] as? Int64 ?? 1) == 0 else { throw LibraryError("Permanent clearing is saved; storage cleanup is waiting for a database reader. Reopen Museamo to finish.") }
        try collectMedia()
        try db.run("DELETE FROM metadata WHERE key='cleanup.erasure'")
    }

    func mutate(_ method: String, _ input: [String: Any]) throws -> [String: Any] {
        switch method {
        case "getDraft": return ["draft": try getDraft(input)]
        case "updateDraft":
            try rejectUnsupported(input)
            let key = try string(input, "profileKey")
            guard var draft = try record("drafts", key: "profile_key", id: key) else { throw LibraryError("Open a draft before editing it.") }
            draft["text"] = try string(input, "text", allowEmpty: true)
            draft["tagIds"] = try validTags(strings(input, "tagIds"))
            draft["attachments"] = try attachments(input, fallback: draft["attachments"] as? [[String: Any]] ?? [])
            if input["location"] != nil { draft["location"] = input["location"] }
            if input["locationAttempted"] != nil { draft["locationAttempted"] = try boolean(input, "locationAttempted") }
            try putDraft(draft)
        case "discardDraft": try db.run("DELETE FROM drafts WHERE profile_key = ?", [try string(input, "profileKey")])
        case "commitDraft": return try commitDraft(object(input, "draft"))
        case "updateEntry":
            try rejectUnsupported(input)
            let id = try string(input, "id")
            var old = try requireEntry(id)
            try checkRevision(input, old)
            let text = try string(input, "text", allowEmpty: true)
            let selectedMedia = try attachments(input, fallback: old["attachments"] as? [[String: Any]] ?? [])
            if selectedMedia.isEmpty { try nonblank(text) }
            let tags = try assignedTags(text: text, explicit: strings(input, "tagIds"), previous: old)
            try recover(old)
            old["text"] = text
            old["tagIds"] = tags
            old["attachments"] = selectedMedia
            if input["location"] != nil { old["location"] = input["location"] }
            try putEntry(old, revise: true)
        case "setStar", "setCompleted":
            var old = try requireEntry(string(input, "id"))
            let field = method == "setStar" ? "starred" : "completed"
            let value = try boolean(input, field)
            if method == "setCompleted" {
                let tagIDs = try strings(old, "tagIds")
                guard try tags().contains(where: { ($0["type"] as? String) == "checklist" && tagIDs.contains($0["id"] as! String) }) else {
                    throw LibraryError("This thought no longer belongs to a Checklist category.")
                }
            }
            if (old[field] as? Bool) != value {
                try recover(old)
                old[field] = value
                try putEntry(old, revise: true, updateTimestamp: false)
            }
        case "deleteEntry":
            let id = try string(input, "id")
            if let old = try entry(id) {
                try checkRevision(input, old)
                try recover(old)
                try recordLocal("thought", id, old, deleted: true)
                try recordShared("thought", id, old, old: old, deleted: true)
                try db.run("DELETE FROM entries WHERE id = ?", [id])
            }
        case "restoreEntry": return ["entryId": try restore(object(input, "entry"))]
        case "saveTag": try saveTag(input)
        case "deleteTag": try deleteTag(string(input, "id"))
        case "saveProfile": try saveProfile(object(input, "profile"))
        case "restoreRecovery":
            let id = try string(input, "id")
            guard let row = try db.run("SELECT payload FROM recovery WHERE id = ?", [id]).first else { throw LibraryError("This version is no longer in Recovery.") }
            return ["entryId": try restore(decode(row["payload"]))]
        case "clearRecovery": try clearRecovery(try string(input, "id"))
        case "clearAllRecovery": try clearRecovery(nil)
        default: throw LibraryError("\(method) is not available in this iOS version.")
        }
        return [:]
    }

    func library() throws -> [String: Any] {
        let rows = try db.run("SELECT tags.*, COUNT(entry_tags.entry_id) AS count FROM tags LEFT JOIN entry_tags ON tags.id = entry_tags.tag_id GROUP BY tags.id ORDER BY normalized_name, tags.id")
        return ["tags": try rows.map(tagJSON), "profiles": try db.run("SELECT payload FROM profiles ORDER BY id").map { try decode($0["payload"]) }]
    }

    func tagJSON(_ row: [String: Any]) throws -> [String: Any] {
        var tag: [String: Any] = ["id": row["id"]!, "name": row["name"]!, "normalizedName": row["normalized_name"]!, "type": row["type"]!]
        if let count = row["count"] { tag["count"] = count }
        if let metadata = try sharingMetadata(row["id"] as! String) { tag["sharing"] = metadata }
        return tag
    }

    func tags() throws -> [[String: Any]] { try db.run("SELECT * FROM tags ORDER BY normalized_name, id").map(tagJSON) }

    func queryEntries(_ query: [String: Any]) throws -> [String: Any] {
        let order = try optionalString(query, "order") ?? "newest"
        guard ["newest", "checklist"].contains(order) else { throw LibraryError("Unknown thought order.") }
        let checklist = order == "checklist"
        let tag = try optionalString(query, "tagId")
        if checklist {
            guard let tag, try db.run("SELECT id FROM tags WHERE id = ? AND type = 'checklist'", [tag]).first != nil else { throw LibraryError("Choose a Checklist category.") }
        }
        var filters = ["1 = 1"]
        var values: [Any] = []
        for flag in ["starred", "checklistOnly", "located"] where query[flag] != nil {
            if try boolean(query, flag) {
                switch flag {
                case "starred": filters.append("e.starred = 1")
                case "located": filters.append("json_extract(e.payload, '$.location.latitude') IS NOT NULL")
                default: filters.append("EXISTS (SELECT 1 FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entry_id = e.id AND t.type = 'checklist')")
                }
            }
        }
        if let tag {
            filters.append("EXISTS (SELECT 1 FROM entry_tags et WHERE et.entry_id = e.id AND et.tag_id = ?)")
            values.append(tag)
        }
        if let search = try optionalString(query, "search"), !search.isEmpty {
            filters.append("instr(e.search_text, ?) > 0")
            values.append(search.lowercased())
        }
        if query["beforeTime"] != nil {
            let before = try timestamp(query, "beforeTime")
            let beforeID = try optionalString(query, "beforeId") ?? ""
            let cursor = "(e.created_at < ? OR (e.created_at = ? AND e.id < ?))"
            if checklist {
                let completed = try boolean(query, "beforeCompleted")
                filters.append("(e.completed > ? OR (e.completed = ? AND \(cursor)))")
                values += [completed, completed, before, before, beforeID]
            } else {
                filters.append(cursor)
                values += [before, before, beforeID]
            }
        }
        let limit = try integer(query, "limit", default: 50, minimum: 1, maximum: 1_000)
        let offset = query["beforeTime"] == nil ? try integer(query, "offset", default: 0, minimum: 0, maximum: Int.max - 1) : 0
        values += [limit + 1, offset]
        let sql = "SELECT e.payload FROM entries e WHERE \(filters.joined(separator: " AND ")) ORDER BY \(checklist ? "e.completed ASC, " : "")e.created_at DESC, e.id DESC LIMIT ? OFFSET ?"
        let rows = try db.run(sql, values)
        return ["entries": try rows.prefix(limit).map { try decode($0["payload"]) }, "hasMore": rows.count > limit]
    }

    func getDraft(_ input: [String: Any]) throws -> [String: Any] {
        let profileID = try optionalString(input, "profileId")
        let tagID = try optionalString(input, "tagId")
        let profile: [String: Any]?
        if let profileID {
            guard let row = try record("profiles", key: "id", id: profileID) else { throw LibraryError("Unknown capture profile.") }
            profile = row
        } else { profile = nil }
        let key = profileID ?? "app:\(tagID ?? "general")"
        if let draft = try record("drafts", key: "profile_key", id: key) { return draft }
        let defaults: [String]
        if let profile {
            defaults = (profile["mode"] as? String) == "picker" ? [profile["selectedTagId"] as? String].compactMap { $0 } : try strings(profile, "tagIds")
        } else { defaults = tagID.map { [$0] } ?? [] }
        let draft: [String: Any] = ["profileKey": key, "entryId": uid(), "text": "", "tagIds": try validTags(defaults), "profileId": jsonString(profileID), "attachments": [Any](), "location": null, "locationAttempted": false]
        try putDraft(draft)
        return draft
    }

    func commitDraft(_ input: [String: Any]) throws -> [String: Any] {
        try rejectUnsupported(input)
        let id = try string(input, "entryId")
        let key = try string(input, "profileKey")
        if let committed = try db.run("SELECT profile_key FROM commits WHERE entry_id = ?", [id]).first {
            guard committed["profile_key"] as? String == key else { throw LibraryError("This draft changed. Reload it before saving.") }
            return ["entryId": id]
        }
        guard let draft = try record("drafts", key: "profile_key", id: key) else { throw LibraryError("Open a draft before saving it.") }
        guard draft["entryId"] as? String == id else { throw LibraryError("This draft changed. Reload it before saving.") }
        let text = try string(input, "text", allowEmpty: true)
        let media = try attachments(input, fallback: draft["attachments"] as? [[String: Any]] ?? [])
        if media.isEmpty { try nonblank(text) }
        let tagIDs = try assignedTags(text: text, explicit: strings(input, "tagIds"))
        let now = milliseconds()
        let row: [String: Any] = ["id": id, "text": text, "tagIds": tagIDs, "createdAt": now, "updatedAt": now, "starred": false, "completed": false, "profileId": draft["profileId"] ?? null, "attachments": media, "location": input["location"] ?? draft["location"] ?? null, "revision": uid()]
        try putEntry(row)
        try db.run("INSERT INTO commits(entry_id, profile_key) VALUES (?, ?)", [id, key])
        try db.run("DELETE FROM drafts WHERE profile_key = ?", [key])
        return ["entryId": id]
    }

    func assignedTags(text: String, explicit: [String], previous: [String: Any]? = nil) throws -> [String] {
        var result = try validTags(explicit)
        let oldNames = Set(Hashtags.names(previous?["text"] as? String ?? "").map(Hashtags.normalized))
        let oldIDs = previous?["tagIds"] as? [String] ?? []
        for name in Hashtags.names(text) {
            let normalized = Hashtags.normalized(name)
            let matches = try db.run("SELECT * FROM tags WHERE normalized_name = ?", [normalized])
            // Deleting a tag must not recreate it just because its hashtag text remains in an edit.
            if previous != nil && oldNames.contains(normalized) && !matches.contains(where: { oldIDs.contains($0["id"] as! String) }) { continue }
            let id: String
            if matches.count > 1 {
                let chosen = matches.filter { result.contains($0["id"] as! String) }
                guard chosen.count == 1 else { throw LibraryError("Choose the Shared or Private hashtag explicitly for matching inline text. Your draft is kept.") }
                id = chosen[0]["id"] as! String
            } else if let tag = matches.first { id = tag["id"] as! String }
            else {
                id = uid()
                try saveTag(["id": id, "name": name])
            }
            if !result.contains(id) { result.append(id) }
        }
        try validateSharedTags(result)
        return result
    }

    func saveTag(_ input: [String: Any]) throws {
        let name = try string(input, "name").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf16.count <= 80 else { throw LibraryError("Use a tag name between 1 and 80 characters.") }
        let id = try optionalString(input, "id") ?? uid()
        let existing = try db.run("SELECT * FROM tags WHERE id = ?", [id]).first
        let type = try optionalString(input, "type") ?? existing?["type"] as? String ?? "standard"
        guard ["standard", "checklist"].contains(type) else { throw LibraryError("Unknown category type.") }
        let normalized = Hashtags.normalized(name)
        if try sharingMetadata(id) == nil {
            guard try db.run("SELECT id FROM tags WHERE normalized_name = ? AND id != ?", [normalized, id]).allSatisfy({ try sharingMetadata($0["id"] as! String) != nil }) else { throw LibraryError("A tag with this name already exists.") }
        }
        let old = try existing.map(tagJSON)
        try db.run("INSERT INTO tags(id,name,normalized_name,type) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, normalized_name=excluded.normalized_name, type=excluded.type", [id, name, normalized, type])
        let saved: [String: Any] = ["id": id, "name": name, "type": type]
        try recordShared("tag", id, saved, old: old)
        try recordLocal("tag", id, saved)
    }

    func deleteTag(_ id: String) throws {
        guard try sharingMetadata(id) == nil else { throw LibraryError("Use sharing settings to leave or stop sharing this hashtag.") }
        if let old = try tags().first(where: { $0["id"] as? String == id }) { try recordLocal("tag", id, old, deleted: true) }
        let affected = try db.run("SELECT e.payload FROM entries e JOIN entry_tags et ON et.entry_id = e.id WHERE et.tag_id = ?", [id])
        try db.run("DELETE FROM tags WHERE id = ?", [id])
        for row in affected {
            var entry = try decode(row["payload"])
            entry["tagIds"] = try strings(entry, "tagIds").filter { $0 != id }
            try putEntry(entry, revise: true, updateTimestamp: false)
        }
        for row in try db.run("SELECT payload FROM drafts") {
            var draft = try decode(row["payload"])
            draft["tagIds"] = try strings(draft, "tagIds").filter { $0 != id }
            try putDraft(draft)
        }
        for row in try db.run("SELECT payload FROM profiles") {
            var profile = try decode(row["payload"])
            profile["tagIds"] = try strings(profile, "tagIds").filter { $0 != id }
            if profile["selectedTagId"] as? String == id { profile["selectedTagId"] = null }
            try saveProfile(profile)
        }
    }

    func saveProfile(_ input: [String: Any]) throws {
        let id = try string(input, "id")
        let label = try string(input, "label").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty, label.utf16.count <= 80 else { throw LibraryError("Give the widget a label (up to 80 characters).") }
        let mode = try string(input, "mode")
        guard ["fixed", "picker"].contains(mode) else { throw LibraryError("Unknown widget mode.") }
        let selected = try optionalString(input, "selectedTagId")
        let selectedTagID = try selected.flatMap { try validTags([$0]).first }
        let row: [String: Any] = ["id": id, "label": label, "mode": mode, "tagIds": try validTags(strings(input, "tagIds")), "selectedTagId": jsonString(selectedTagID)]
        try db.run("INSERT INTO profiles(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", [id, try encode(row)])
    }

    func restore(_ input: [String: Any]) throws -> String {
        try rejectUnsupported(input)
        // Restore as a new thought, matching Android's tombstone-safe restore contract.
        let id = uid()
        let text = try string(input, "text", allowEmpty: true)
        let selectedMedia = try attachments(input)
        if selectedMedia.isEmpty { try nonblank(text) }
        let profileID = try optionalString(input, "profileId")
        let profile = jsonString(try profileID.flatMap { try record("profiles", key: "id", id: $0) == nil ? nil : $0 })
        let row: [String: Any] = ["id": id, "text": text, "createdAt": try timestamp(input, "createdAt"), "updatedAt": milliseconds(), "starred": try boolean(input, "starred"), "completed": try boolean(input, "completed"), "tagIds": try validTags(strings(input, "tagIds")), "profileId": profile, "attachments": selectedMedia, "location": input["location"] ?? null, "revision": uid()]
        try putEntry(row)
        return id
    }

    func recover(_ entry: [String: Any]) throws {
        let entity = try string(entry, "id")
        let recoveryID = try metadata("head:thought:\(entity)") ?? uid()
        try db.run("INSERT OR IGNORE INTO recovery(id,entity_id,created_at,payload) VALUES(?,?,?,?)", [recoveryID, entity, milliseconds(), try encode(entry)])
    }

    func checkRevision(_ input: [String: Any], _ entry: [String: Any]) throws {
        if let base = try optionalString(input, "baseRevision"), base != entry["revision"] as? String {
            throw LibraryError("This thought changed. Your writing is preserved; reload the current revision or save as a new thought.")
        }
    }

    func validTags(_ ids: [String]) throws -> [String] {
        let existing = Set(try tags().map { $0["id"] as! String })
        var seen = Set<String>()
        return ids.filter { existing.contains($0) && seen.insert($0).inserted }
    }

    func putEntry(_ input: [String: Any], revise: Bool = false, updateTimestamp: Bool = true) throws {
        var row = input
        if revise {
            row["revision"] = uid()
            if updateTimestamp { row["updatedAt"] = milliseconds() }
        }
        let id = try string(row, "id")
        let old = try entry(id)
        try validateSharedTags(strings(row, "tagIds"))
        _ = try SyncCore.evaluate(["action": "validateThought", "entity": id, "payload": row])
        try recordShared("thought", id, row, old: old)
        try recordLocal("thought", id, row)
        try db.run("INSERT INTO entries(id,created_at,completed,starred,search_text,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, completed=excluded.completed, starred=excluded.starred, search_text=excluded.search_text, payload=excluded.payload", [id, try timestamp(row, "createdAt"), try boolean(row, "completed"), try boolean(row, "starred"), try string(row, "text", allowEmpty: true).lowercased(), try encode(row)])
        try db.run("DELETE FROM entry_tags WHERE entry_id = ?", [id])
        for tag in try strings(row, "tagIds") { try db.run("INSERT INTO entry_tags(entry_id,tag_id) VALUES(?,?)", [id, tag]) }
    }

    func putDraft(_ draft: [String: Any]) throws {
        try db.run("INSERT INTO drafts(profile_key,payload) VALUES(?,?) ON CONFLICT(profile_key) DO UPDATE SET payload=excluded.payload", [try string(draft, "profileKey"), try encode(draft)])
    }

    func entry(_ id: String) throws -> [String: Any]? { try record("entries", key: "id", id: id) }
    func requireEntry(_ id: String) throws -> [String: Any] {
        guard let entry = try entry(id) else { throw LibraryError("This thought no longer exists.") }
        return entry
    }
    func record(_ table: String, key: String, id: String) throws -> [String: Any]? {
        // Table and key are internal constants; caller-provided values are always bound.
        try db.run("SELECT payload FROM \(table) WHERE \(key) = ?", [id]).first.map { try decode($0["payload"]) }
    }
    func encode(_ value: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    func jsonString(_ value: String?) -> Any {
        if let value { return value }
        return null
    }
    func decode(_ value: Any?) throws -> [String: Any] {
        guard let text = value as? String, let result = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw LibraryError("Library contains an invalid record.") }
        return result
    }
    func uid() -> String { UUID().uuidString.lowercased() }
    func milliseconds() -> Int64 { Int64(Date().timeIntervalSince1970 * 1_000) }
    func nonblank(_ text: String) throws {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw LibraryError("Add text or an attachment.") }
    }
    func string(_ input: [String: Any], _ key: String, allowEmpty: Bool = false) throws -> String {
        guard let value = input[key] as? String, allowEmpty || !value.isEmpty else { throw LibraryError("Invalid \(key).") }
        return value
    }
    func optionalString(_ input: [String: Any], _ key: String) throws -> String? {
        guard let value = input[key], !(value is NSNull) else { return nil }
        guard let text = value as? String else { throw LibraryError("Invalid \(key).") }
        return text
    }
    func strings(_ input: [String: Any], _ key: String) throws -> [String] {
        guard let value = input[key] as? [String] else { throw LibraryError("Invalid \(key).") }
        return value
    }
    func object(_ input: [String: Any], _ key: String) throws -> [String: Any] {
        guard let value = input[key] as? [String: Any] else { throw LibraryError("Invalid \(key).") }
        return value
    }
    func boolean(_ input: [String: Any], _ key: String) throws -> Bool {
        guard let value = input[key] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { throw LibraryError("Invalid \(key).") }
        return value.boolValue
    }
    func timestamp(_ input: [String: Any], _ key: String) throws -> Int64 {
        guard let value = input[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite, value.doubleValue >= 0, value.doubleValue <= 8_640_000_000_000_000, value.doubleValue.rounded(.towardZero) == value.doubleValue else { throw LibraryError("Invalid \(key).") }
        return value.int64Value
    }
    func integer(_ input: [String: Any], _ key: String, default fallback: Int, minimum: Int, maximum: Int) throws -> Int {
        guard input[key] != nil else { return fallback }
        let value = try timestamp(input, key)
        return max(minimum, min(maximum, Int(value)))
    }
    func rejectUnsupported(_ input: [String: Any]) throws {
        if let value = input["location"], !(value is NSNull) {
            guard let location = value as? [String: Any], let latitude = location["latitude"] as? Double, let longitude = location["longitude"] as? Double,
                  latitude.isFinite, longitude.isFinite, (-90...90).contains(latitude), (-180...180).contains(longitude) else { throw LibraryError("Invalid saved location. Your writing is kept.") }
            _ = try timestamp(location, "capturedAt"); _ = try string(location, "token")
        }
    }
}
