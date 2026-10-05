import Foundation
import CoreFoundation

/// Durable offline library. The host must call this instance from a serial queue.
public final class LibraryStore {
    private let db: SQLite
    private let null = NSNull()
    private static let schemaVersion: Int64 = 1

    public init(databaseURL: URL) throws {
        db = try SQLite(url: databaseURL)
        try migrate()
    }

    private func migrate() throws {
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
                ["id": row["id"]!, "kind": "entry", "entityId": row["entity_id"]!, "createdAt": row["created_at"]!, "payload": try decode(row["payload"])] as [String: Any]
            }]
        default:
            return try db.transaction { try mutate(method, input) }
        }
    }

    private func mutate(_ method: String, _ input: [String: Any]) throws -> [String: Any] {
        switch method {
        case "getDraft": return ["draft": try getDraft(input)]
        case "updateDraft":
            try rejectUnsupported(input)
            let key = try string(input, "profileKey")
            guard var draft = try record("drafts", key: "profile_key", id: key) else { throw LibraryError("Open a draft before editing it.") }
            draft["text"] = try string(input, "text", allowEmpty: true)
            draft["tagIds"] = try validTags(strings(input, "tagIds"))
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
            try nonblank(text)
            let tags = try assignedTags(text: text, explicit: strings(input, "tagIds"), previous: old)
            try recover(old)
            old["text"] = text
            old["tagIds"] = tags
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
        case "clearRecovery": try db.run("DELETE FROM recovery WHERE id = ?", [try string(input, "id")])
        case "clearAllRecovery": try db.run("DELETE FROM recovery")
        default: throw LibraryError("\(method) is not available in this iOS version.")
        }
        return [:]
    }

    private func library() throws -> [String: Any] {
        let rows = try db.run("SELECT tags.*, COUNT(entry_tags.entry_id) AS count FROM tags LEFT JOIN entry_tags ON tags.id = entry_tags.tag_id GROUP BY tags.id ORDER BY normalized_name, tags.id")
        return ["tags": rows.map(tagJSON), "profiles": try db.run("SELECT payload FROM profiles ORDER BY id").map { try decode($0["payload"]) }]
    }

    private func tagJSON(_ row: [String: Any]) -> [String: Any] {
        var tag: [String: Any] = ["id": row["id"]!, "name": row["name"]!, "normalizedName": row["normalized_name"]!, "type": row["type"]!]
        if let count = row["count"] { tag["count"] = count }
        return tag
    }

    private func tags() throws -> [[String: Any]] { try db.run("SELECT * FROM tags ORDER BY normalized_name, id").map(tagJSON) }

    private func queryEntries(_ query: [String: Any]) throws -> [String: Any] {
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
                case "located": filters.append("0 = 1") // This milestone only accepts text thoughts.
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

    private func getDraft(_ input: [String: Any]) throws -> [String: Any] {
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

    private func commitDraft(_ input: [String: Any]) throws -> [String: Any] {
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
        try nonblank(text)
        let tagIDs = try assignedTags(text: text, explicit: strings(input, "tagIds"))
        let now = milliseconds()
        let row: [String: Any] = ["id": id, "text": text, "tagIds": tagIDs, "createdAt": now, "updatedAt": now, "starred": false, "completed": false, "profileId": draft["profileId"] ?? null, "attachments": [Any](), "location": null, "revision": uid()]
        try putEntry(row)
        try db.run("INSERT INTO commits(entry_id, profile_key) VALUES (?, ?)", [id, key])
        try db.run("DELETE FROM drafts WHERE profile_key = ?", [key])
        return ["entryId": id]
    }

    private func assignedTags(text: String, explicit: [String], previous: [String: Any]? = nil) throws -> [String] {
        var result = try validTags(explicit)
        let oldNames = Set(Hashtags.names(previous?["text"] as? String ?? "").map(Hashtags.normalized))
        let oldIDs = previous?["tagIds"] as? [String] ?? []
        for name in Hashtags.names(text) {
            let normalized = Hashtags.normalized(name)
            let matches = try db.run("SELECT * FROM tags WHERE normalized_name = ?", [normalized])
            // Deleting a tag must not recreate it just because its hashtag text remains in an edit.
            if previous != nil && oldNames.contains(normalized) && !matches.contains(where: { oldIDs.contains($0["id"] as! String) }) { continue }
            let id: String
            if let tag = matches.first { id = tag["id"] as! String }
            else {
                id = uid()
                try saveTag(["id": id, "name": name])
            }
            if !result.contains(id) { result.append(id) }
        }
        return result
    }

    private func saveTag(_ input: [String: Any]) throws {
        let name = try string(input, "name").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf16.count <= 80 else { throw LibraryError("Use a tag name between 1 and 80 characters.") }
        let id = try optionalString(input, "id") ?? uid()
        let existing = try db.run("SELECT type FROM tags WHERE id = ?", [id]).first
        let type = try optionalString(input, "type") ?? existing?["type"] as? String ?? "standard"
        guard ["standard", "checklist"].contains(type) else { throw LibraryError("Unknown category type.") }
        let normalized = Hashtags.normalized(name)
        guard try db.run("SELECT id FROM tags WHERE normalized_name = ? AND id != ?", [normalized, id]).isEmpty else { throw LibraryError("A tag with this name already exists.") }
        try db.run("INSERT INTO tags(id,name,normalized_name,type) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, normalized_name=excluded.normalized_name, type=excluded.type", [id, name, normalized, type])
    }

    private func deleteTag(_ id: String) throws {
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

    private func saveProfile(_ input: [String: Any]) throws {
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

    private func restore(_ input: [String: Any]) throws -> String {
        try rejectUnsupported(input)
        // Restore as a new thought, matching Android's tombstone-safe restore contract.
        let id = uid()
        let text = try string(input, "text", allowEmpty: true)
        try nonblank(text)
        let profileID = try optionalString(input, "profileId")
        let profile = jsonString(try profileID.flatMap { try record("profiles", key: "id", id: $0) == nil ? nil : $0 })
        let row: [String: Any] = ["id": id, "text": text, "createdAt": try timestamp(input, "createdAt"), "updatedAt": milliseconds(), "starred": try boolean(input, "starred"), "completed": try boolean(input, "completed"), "tagIds": try validTags(strings(input, "tagIds")), "profileId": profile, "attachments": [Any](), "location": null, "revision": uid()]
        try putEntry(row)
        return id
    }

    private func recover(_ entry: [String: Any]) throws {
        try db.run("INSERT INTO recovery(id,entity_id,created_at,payload) VALUES(?,?,?,?)", [uid(), try string(entry, "id"), milliseconds(), try encode(entry)])
    }

    private func checkRevision(_ input: [String: Any], _ entry: [String: Any]) throws {
        if let base = try optionalString(input, "baseRevision"), base != entry["revision"] as? String {
            throw LibraryError("This thought changed. Your writing is preserved; reload the current revision or save as a new thought.")
        }
    }

    private func validTags(_ ids: [String]) throws -> [String] {
        let existing = Set(try tags().map { $0["id"] as! String })
        var seen = Set<String>()
        return ids.filter { existing.contains($0) && seen.insert($0).inserted }
    }

    private func putEntry(_ input: [String: Any], revise: Bool = false, updateTimestamp: Bool = true) throws {
        var row = input
        if revise {
            row["revision"] = uid()
            if updateTimestamp { row["updatedAt"] = milliseconds() }
        }
        let id = try string(row, "id")
        try db.run("INSERT INTO entries(id,created_at,completed,starred,search_text,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, completed=excluded.completed, starred=excluded.starred, search_text=excluded.search_text, payload=excluded.payload", [id, try timestamp(row, "createdAt"), try boolean(row, "completed"), try boolean(row, "starred"), try string(row, "text", allowEmpty: true).lowercased(), try encode(row)])
        try db.run("DELETE FROM entry_tags WHERE entry_id = ?", [id])
        for tag in try strings(row, "tagIds") { try db.run("INSERT INTO entry_tags(entry_id,tag_id) VALUES(?,?)", [id, tag]) }
    }

    private func putDraft(_ draft: [String: Any]) throws {
        try db.run("INSERT INTO drafts(profile_key,payload) VALUES(?,?) ON CONFLICT(profile_key) DO UPDATE SET payload=excluded.payload", [try string(draft, "profileKey"), try encode(draft)])
    }

    private func entry(_ id: String) throws -> [String: Any]? { try record("entries", key: "id", id: id) }
    private func requireEntry(_ id: String) throws -> [String: Any] {
        guard let entry = try entry(id) else { throw LibraryError("This thought no longer exists.") }
        return entry
    }
    private func record(_ table: String, key: String, id: String) throws -> [String: Any]? {
        // Table and key are internal constants; caller-provided values are always bound.
        try db.run("SELECT payload FROM \(table) WHERE \(key) = ?", [id]).first.map { try decode($0["payload"]) }
    }
    private func encode(_ value: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    private func jsonString(_ value: String?) -> Any {
        if let value { return value }
        return null
    }
    private func decode(_ value: Any?) throws -> [String: Any] {
        guard let text = value as? String, let result = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw LibraryError("Library contains an invalid record.") }
        return result
    }
    private func uid() -> String { UUID().uuidString.lowercased() }
    private func milliseconds() -> Int64 { Int64(Date().timeIntervalSince1970 * 1_000) }
    private func nonblank(_ text: String) throws {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw LibraryError("Add text or an attachment.") }
    }
    private func string(_ input: [String: Any], _ key: String, allowEmpty: Bool = false) throws -> String {
        guard let value = input[key] as? String, allowEmpty || !value.isEmpty else { throw LibraryError("Invalid \(key).") }
        return value
    }
    private func optionalString(_ input: [String: Any], _ key: String) throws -> String? {
        guard let value = input[key], !(value is NSNull) else { return nil }
        guard let text = value as? String else { throw LibraryError("Invalid \(key).") }
        return text
    }
    private func strings(_ input: [String: Any], _ key: String) throws -> [String] {
        guard let value = input[key] as? [String] else { throw LibraryError("Invalid \(key).") }
        return value
    }
    private func object(_ input: [String: Any], _ key: String) throws -> [String: Any] {
        guard let value = input[key] as? [String: Any] else { throw LibraryError("Invalid \(key).") }
        return value
    }
    private func boolean(_ input: [String: Any], _ key: String) throws -> Bool {
        guard let value = input[key] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { throw LibraryError("Invalid \(key).") }
        return value.boolValue
    }
    private func timestamp(_ input: [String: Any], _ key: String) throws -> Int64 {
        guard let value = input[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite, value.doubleValue >= 0, value.doubleValue <= 8_640_000_000_000_000, value.doubleValue.rounded(.towardZero) == value.doubleValue else { throw LibraryError("Invalid \(key).") }
        return value.int64Value
    }
    private func integer(_ input: [String: Any], _ key: String, default fallback: Int, minimum: Int, maximum: Int) throws -> Int {
        guard input[key] != nil else { return fallback }
        let value = try timestamp(input, key)
        return max(minimum, min(maximum, Int(value)))
    }
    private func rejectUnsupported(_ input: [String: Any]) throws {
        for key in ["attachments", "attachmentIds"] {
            if let value = input[key], !(value is NSNull) {
                guard let items = value as? [Any], items.isEmpty else { throw LibraryError("Attachments are not available in this iOS version. Your writing is kept.") }
            }
        }
        if let value = input["location"], !(value is NSNull) { throw LibraryError("Saving locations is not available in this iOS version. Your writing is kept.") }
    }
}
