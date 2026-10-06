import Foundation
import CryptoKit

extension LibraryStore {
    func mediaURL(_ id: String, staged: Bool = false) throws -> URL {
        guard UUID(uuidString:id) != nil else { throw LibraryError("Invalid original identity.") }
        let folder = directory.appendingPathComponent(staged ? "staging":"media",isDirectory:true)
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        return folder.appendingPathComponent(id)
    }
    func fileHash(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom:url); defer { try? handle.close() }
        var hash = SHA256()
        while let chunk = try handle.read(upToCount:1024*1024), !chunk.isEmpty { hash.update(data:chunk) }
        return SyncCore.hex(Data(hash.finalize()))
    }
    func registerMedia(_ value: [String:Any]) throws {
        _ = try SyncCore.evaluate(["action":"validateMedia","payload":value])
        let id = try string(value,"id")
        if let current = try record("media",key:"id",id:id) {
            guard try SyncCore.hash(normalizedMedia(current)) == SyncCore.hash(normalizedMedia(value)) else { throw LibraryError("Attachment identity conflicts with a saved original.") }
        } else { try db.run("INSERT INTO media VALUES(?,?)",[id,try encode(normalizedMedia(value))]) }
    }
    private func normalizedMedia(_ value: [String: Any]) -> [String: Any] {
        var metadata = value
        // The wire protocol accepts an absent still-image duration and emits null.
        metadata["duration"] = value["duration"] ?? NSNull()
        return metadata
    }
    func attachments(_ input: [String:Any],fallback: [[String:Any]] = []) throws -> [[String:Any]] {
        let ids: [String]
        if input["attachmentIds"] != nil { ids = try strings(input,"attachmentIds") }
        else if let values = input["attachments"] as? [[String:Any]] { ids = try values.map { try string($0,"id") } }
        else { return fallback }
        guard ids.count <= 10, Set(ids).count == ids.count else { throw LibraryError("Choose up to ten distinct attachments.") }
        return try ids.map { id in guard let value = try record("media",key:"id",id:id) else { throw LibraryError("An attachment is no longer available. Your writing is kept.") }; return value }
    }
    public func importMedia(from url: URL,metadata input: [String:Any]) throws -> [String:Any] {
        let size = (try FileManager.default.attributesOfItem(atPath:url.path)[.size] as? NSNumber)?.int64Value ?? 0
        let kind = try string(input,"kind")
        guard size > 0, size <= (kind == "image" ? 50:500)*1024*1024 else { throw LibraryError("Choose a photo up to 50 MB or a video up to 500 MB.") }
        let free = (try FileManager.default.attributesOfFileSystem(forPath:directory.path)[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
        guard free > size + 16*1024*1024 else { throw LibraryError("Not enough device storage. Your writing is kept.") }
        let id = uid(); var value = normalizedMedia(input)
        value["id"] = id; value["byteSize"] = size; value["checksum"] = try fileHash(url)
        value["width"] = input["width"] ?? 0; value["height"] = input["height"] ?? 0
        let target = try mediaURL(id)
        try FileManager.default.copyItem(at:url,to:target)
        do { try db.transaction { try registerMedia(value) }; mediaPins.insert(id); return value }
        catch { try? FileManager.default.removeItem(at:target); throw error }
    }
    public func originalURL(_ id: String) throws -> URL? {
        guard let metadata = try record("media",key:"id",id:id) else { throw LibraryError("Original is no longer in this library.") }
        let url = try mediaURL(id)
        guard FileManager.default.fileExists(atPath:url.path) else { return nil }
        let size = (try FileManager.default.attributesOfItem(atPath:url.path)[.size] as? NSNumber)?.int64Value ?? 0
        guard size == (try timestamp(metadata,"byteSize")) else { throw LibraryError("Saved original size differs from its metadata.") }
        return url
    }
    public func releaseMedia(_ ids: [String]) throws { mediaPins.subtract(ids); try collectMedia() }
    func referencedMedia(local: Bool) throws -> [String:[String:Any]] {
        var references: [String:[String:Any]] = [:]
        func include(_ value: [String:Any]) throws {
            for metadata in value["attachments"] as? [[String:Any]] ?? [] {
                let id = try string(metadata,"id"), normalized = normalizedMedia(metadata)
                if let previous = references[id], try SyncCore.hash(previous) != SyncCore.hash(normalized) { throw LibraryError("Referenced original identities conflict.") }
                references[id] = normalized
            }
        }
        for table in local ? ["entries","recovery","drafts"]:["entries","recovery"] {
            for row in try db.run("SELECT payload FROM \(table)") { try include(decode(row["payload"])) }
        }
        if local {
            for value in try operations("1=1") where !(value["payload"] is NSNull) { let payload = try object(value,"payload"); try include(payload["payload"] as? [String:Any] ?? payload) }
            for pending in try db.run("SELECT payload FROM sharing_pending") { let item = try decode(pending["payload"]); if let payload = item["payload"] as? [String:Any] { try include(payload) } }
            for scope in (try sharingRegistry()["scopes"] as? [String:[String:Any]] ?? [:]).values {
                for record in scope["records"] as? [[String:Any]] ?? [] { if let payload = record["payload"] as? [String:Any] { try include(payload) } }
            }
        }
        return references
    }
    func scopedMedia(_ scope: String) throws -> Set<String> {
        guard let value = (try sharingRegistry()["scopes"] as? [String:[String:Any]])?[scope] else { throw LibraryError("Unknown shared collection.") }
        return Set((value["records"] as? [[String:Any]] ?? []).flatMap { ($0["payload"] as? [String:Any])?["attachments"] as? [[String:Any]] ?? [] }.compactMap { $0["id"] as? String })
    }
    func missingMedia(_ input: [String:Any],shared: Bool) throws -> [String:Any] {
        let allowed = shared ? try scopedMedia(string(input,"scope")):nil
        var items: [[String:Any]] = []; var total = 0
        let limit = try integer(input,"limit",default:32,minimum:1,maximum:32)
        for (id,metadata) in try referencedMedia(local:false) where allowed == nil || allowed!.contains(id) {
            try registerMedia(metadata)
            if try originalURL(id) != nil { continue }
            total += 1; if items.count == limit { continue }
            let staging = try mediaURL(id,staged:true), offset = (try? FileManager.default.attributesOfItem(atPath:staging.path)[.size] as? NSNumber)?.int64Value ?? 0
            items.append(["id":id,"checksum":metadata["checksum"]!,"size":metadata["byteSize"]!,"offset":offset,"metadata":metadata])
        }
        return ["items":items,"totalCount":total]
    }
    func readMedia(_ input: [String:Any],shared: Bool) throws -> [String:Any] {
        let id = try string(input,"id"), offset = try timestamp(input,"offset")
        guard try referencedMedia(local:false)[id] != nil, try (!shared || scopedMedia(string(input,"scope")).contains(id)), let url = try originalURL(id) else { throw LibraryError("Original is not referenced by this saved collection.") }
        let metadata = try record("media",key:"id",id:id)!, size = try timestamp(metadata,"byteSize")
        guard offset <= size else { throw LibraryError("Invalid original offset.") }
        let file = try FileHandle(forReadingFrom:url); defer { try? file.close() }; try file.seek(toOffset:UInt64(offset))
        let count = min(Int(size-offset),try integer(input,"maxBytes",default:16384,minimum:1,maximum:16384)), bytes = try file.read(upToCount:count) ?? Data()
        guard bytes.count == count else { throw LibraryError("Could not read the saved original.") }
        return ["bytes":SyncCore.hex(bytes),"eof":offset+Int64(bytes.count) == size]
    }
    func writeMedia(_ input: [String:Any],shared: Bool) throws -> [String:Any] {
        let id = try string(input,"id"), size = try timestamp(input,"size"), offset = try timestamp(input,"offset"), metadata = try object(input,"metadata")
        guard metadata["id"] as? String == id, metadata["checksum"] as? String == input["checksum"] as? String, try timestamp(metadata,"byteSize") == size,
              try referencedMedia(local:false)[id] != nil, try (!shared || scopedMedia(string(input,"scope")).contains(id)) else { throw LibraryError("Original is not in this saved collection.") }
        try registerMedia(metadata)
        if try originalURL(id) != nil { return ["offset":size,"complete":true] }
        let bytes = try SyncCore.bytes(string(input,"bytes",allowEmpty:true)), staging = try mediaURL(id,staged:true)
        guard bytes.count <= 16384, offset+Int64(bytes.count) <= size else { throw LibraryError("Invalid original chunk.") }
        let existing = (try? FileManager.default.attributesOfItem(atPath:staging.path)[.size] as? NSNumber)?.int64Value ?? 0
        let free = (try FileManager.default.attributesOfFileSystem(forPath:directory.path)[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
        guard offset == existing, free > 16*1024*1024 + Int64(bytes.count) else { throw LibraryError("Invalid offset or not enough storage for this original.") }
        if !FileManager.default.fileExists(atPath:staging.path) { guard FileManager.default.createFile(atPath:staging.path,contents:nil) else { throw LibraryError("Could not stage original.") } }
        let file = try FileHandle(forWritingTo:staging); defer { try? file.close() }; try file.seek(toOffset:UInt64(offset)); try file.write(contentsOf:bytes); try file.synchronize()
        let through = offset+Int64(bytes.count)
        if through == size {
            guard try fileHash(staging) == string(metadata,"checksum") else { try FileManager.default.removeItem(at:staging); throw LibraryError("Transferred original checksum mismatch.") }
            try FileManager.default.moveItem(at:staging,to:mediaURL(id))
        }
        return ["offset":through,"complete":through == size]
    }
    public func collectMedia() throws {
        let references = try referencedMedia(local:true)
        for row in try db.run("SELECT id FROM media") {
            let id = row["id"] as! String
            guard references[id] == nil, !mediaPins.contains(id) else { continue }
            for staged in [false,true] { let url = try mediaURL(id,staged:staged); if FileManager.default.fileExists(atPath:url.path) { try FileManager.default.removeItem(at:url) } }
            let previews = directory.appendingPathComponent("previews", isDirectory: true)
            if FileManager.default.fileExists(atPath: previews.path) { for url in try FileManager.default.contentsOfDirectory(at: previews, includingPropertiesForKeys: nil) where url.lastPathComponent.hasPrefix(id + ".") || url.lastPathComponent == id + "-thumbnail.jpg" { try FileManager.default.removeItem(at: url) } }
            try db.run("DELETE FROM media WHERE id=?",[id])
        }
    }
}
