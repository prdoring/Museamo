import Foundation
import CryptoKit
import XCTest
@testable import MuseamoNative

final class ConnectedStoreTests: XCTestCase {
    private var directory: URL!
    override func setUpWithError() throws { directory = FileManager.default.temporaryDirectory.appendingPathComponent("MuseamoConnected-\(UUID().uuidString)"); try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func store(_ name: String = "library") throws -> LibraryStore { try LibraryStore(databaseURL: directory.appendingPathComponent(name).appendingPathComponent("library.sqlite")) }
    private func identity(_ store: LibraryStore) throws -> [String: Any] {
        let key = P256.Signing.PrivateKey(), noise = try SyncCore.evaluate(["action": "newNoiseKey"])
        let value: [String: Any] = ["deviceId": UUID().uuidString.lowercased(), "name": "Swift test", "signingPublic": SyncCore.hex(key.publicKey.x963Representation), "noisePrivate": noise["private"]!, "noisePublic": noise["public"]!]
        store.configureSync(identity: { value }, sign: { try SyncCore.hex(key.signature(for: $0).derRepresentation) })
        return value
    }
    private func save(_ store: LibraryStore, _ text: String, tags: [String] = [], media: [[String: Any]] = []) throws -> String {
        var draft = try XCTUnwrap(store.execute(method: "getDraft")["draft"] as? [String: Any]); draft["text"] = text; draft["tagIds"] = tags; draft["attachments"] = media
        return try XCTUnwrap(store.execute(method: "commitDraft", input: ["draft": draft])["entryId"] as? String)
    }
    private func apply(_ source: LibraryStore, to target: LibraryStore, identity: [String: Any], group: String, after: [String: Int64] = [:]) throws -> [String: Any] {
        let batch = try source.nativeCall("syncExport", ["groupId": group, "after": after])
        var input = batch; input["groupId"] = group; input["members"] = [identity]; input["authorizedHistory"] = [String: Int64](); input["authorizedAnchors"] = [String: Any]()
        return try target.nativeCall("syncApply", input)
    }
    func testInterruptedEnrollmentIsAtomicAndRetryDoesNotDuplicateContentOrDrafts() throws {
        let library = try store(); _ = try identity(library)
        let tag = UUID().uuidString.lowercased(); try library.execute(method: "saveTag", input: ["id": tag, "name": "Tasks", "type": "checklist"])
        let thought = try save(library, "Saved", tags: [tag]); try library.execute(method: "setStar", input: ["id": thought, "starred": true])
        var draft = try XCTUnwrap(library.execute(method: "getDraft")["draft"] as? [String: Any]); draft["text"] = "Unsent"
        try library.execute(method: "updateDraft", input: ["profileKey": draft["profileKey"]!, "text": "Unsent", "tagIds": [tag]])
        let goodSign = library.signer!; var writes = 0
        library.signer = { bytes in writes += 1; if writes == 2 { throw LibraryError("Injected unavailable key") }; return try goodSign(bytes) }
        XCTAssertThrowsError(try library.nativeCall("syncEnroll", ["groupId": "test-library"]))
        XCTAssertNil(try library.metadata("group")); XCTAssertTrue(try library.operations("1=1").isEmpty)
        library.signer = goodSign
        try library.nativeCall("syncEnroll", ["groupId": "test-library"])
        let first = try library.operations(); try library.nativeCall("syncEnroll", ["groupId": "test-library"])
        XCTAssertEqual(try library.operations().count, first.count)
        XCTAssertEqual(try library.entry(thought)?["starred"] as? Bool, true)
        XCTAssertEqual((try library.execute(method: "getDraft")["draft"] as? [String: Any])?["text"] as? String, "Unsent")
        XCTAssertFalse(first.contains { ($0["payload"] as? [String: Any])?["text"] as? String == "Unsent" })
    }
    func testSignedReplicationRejectsTamperingAndStagesGapsBeforeDurableReceipts() throws {
        let source = try store("source"), target = try store("target"), id = try identity(source); _ = try identity(target)
        let thought = try save(source, "first"); try source.nativeCall("syncEnroll", ["groupId": "group"]); try target.nativeCall("syncEnroll", ["groupId": "group"])
        try source.execute(method: "updateEntry", input: ["id": thought, "text": "second", "tagIds": [String]()])
        let changes = try source.operations(); var input: [String: Any] = ["groupId": "group", "members": [id], "authorizedHistory": [String: Int64](), "authorizedAnchors": [String: Any](), "purgeProofs": [Any](), "envelopes": [changes[1]]]
        try target.nativeCall("syncApply", input); XCTAssertTrue(try target.receipts().isEmpty); XCTAssertNil(try target.entry(thought))
        input["envelopes"] = [changes[0]]; try target.nativeCall("syncApply", input)
        XCTAssertEqual(try target.receipts()[id["deviceId"] as! String], 2); XCTAssertEqual(try target.entry(thought)?["text"] as? String, "second")
        _ = try apply(source, to: target, identity: id, group: "group")
        XCTAssertEqual(try target.operations("1=1").count, 2)
        var changed = changes[1], body = changed["payload"] as! [String: Any]; body["text"] = "unsigned"; changed["payload"] = body; input["envelopes"] = [changed]
        XCTAssertThrowsError(try target.nativeCall("syncApply", input)); XCTAssertEqual(try target.entry(thought)?["text"] as? String, "second")
        input["members"] = [id, id]; XCTAssertThrowsError(try target.nativeCall("syncApply", input))
    }
    func testOriginalTransfersResumeVerifyChecksumsAndKeepDraftRecoveryReferences() throws {
        let source = try store(), original = directory.appendingPathComponent("photo.jpeg"), bytes = Data(repeating: 9, count: 19000)
        try bytes.write(to: original)
        let media = try source.importMedia(from: original, metadata: ["kind": "image", "mimeType": "image/jpeg", "filename": "photo.jpeg"])
        XCTAssertTrue(media["duration"] is NSNull)
        var legacyMetadata = media; legacyMetadata.removeValue(forKey: "duration")
        try source.registerMedia(legacyMetadata)
        let id = try save(source, "", media: [media]); let mediaID = media["id"] as! String
        try source.releaseMedia([mediaID]); XCTAssertNotNil(try source.originalURL(mediaID))
        let target = try store("target"); try target.registerMedia(media)
        var remote = try source.requireEntry(id); remote["tagIds"] = [String](); try target.db.transaction { try target.putEntry(remote) }
        let first = try source.readMedia(["id": mediaID, "offset": 0, "maxBytes": 1000], shared: false)
        var chunk: [String: Any] = ["id": mediaID, "offset": 0, "size": bytes.count, "checksum": media["checksum"]!, "metadata": media, "bytes": first["bytes"]!]
        XCTAssertEqual(try target.writeMedia(chunk, shared: false)["complete"] as? Bool, false)
        XCTAssertEqual((try target.missingMedia([:], shared: false)["items"] as? [[String: Any]])?.first?["offset"] as? Int64, 1000)
        chunk["offset"] = 1000; chunk["bytes"] = SyncCore.hex(Data(repeating: 0, count: 16000)); try target.writeMedia(chunk, shared: false)
        chunk["offset"] = 17000; chunk["bytes"] = SyncCore.hex(Data(repeating: 0, count: 2000)); XCTAssertThrowsError(try target.writeMedia(chunk, shared: false))
        XCTAssertNil(try target.originalURL(mediaID))
        for offset in stride(from: 0, to: bytes.count, by: 16000) { chunk["offset"] = offset; chunk["bytes"] = SyncCore.hex(bytes.subdata(in: offset..<min(bytes.count, offset + 16000))); try target.writeMedia(chunk, shared: false) }
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(target.originalURL(mediaID))), bytes)
        try source.execute(method: "deleteEntry", input: ["id": id]); try source.collectMedia(); XCTAssertNotNil(try source.originalURL(mediaID))
        try source.execute(method: "clearAllRecovery"); try source.collectMedia(); XCTAssertThrowsError(try source.originalURL(mediaID))
    }
    func testSharedPayloadExcludesPrivateAssignmentsGemsProfilesAndHistory() throws {
        let library = try store(), id = try save(library, "visible")
        var value = try library.requireEntry(id); value["tagIds"] = [UUID().uuidString]; value["starred"] = true; value["profileId"] = "private profile"; value["history"] = ["private earlier text"]
        let shared = try library.sharedPayload(value)
        for field in ["tagIds", "starred", "profileId", "history", "revision"] { XCTAssertNil(shared[field], field) }
        XCTAssertEqual(shared["text"] as? String, "visible")
    }
    func testPermanentClearingReplicatesToExistingAndFreshPeersWithoutRetiringSameIDTag() throws {
        let source = try store("source"), target = try store("target"), fresh = try store("fresh"), id = try identity(source)
        _ = try identity(target); _ = try identity(fresh)
        let thought = try save(source, "Before clearing")
        try source.execute(method: "saveTag", input: ["id": thought, "name": "Surviving tag"])
        try source.execute(method: "updateEntry", input: ["id": thought, "text": "Edited", "tagIds": [thought]])
        for peer in [source, target, fresh] { try peer.nativeCall("syncEnroll", ["groupId": "group"]) }
        _ = try apply(source, to: target, identity: id, group: "group")
        XCTAssertEqual(try target.entry(thought)?["text"] as? String, "Edited")
        try source.execute(method: "deleteEntry", input: ["id": thought]); try source.execute(method: "clearAllRecovery")
        for peer in [target, fresh] {
            _ = try apply(source, to: peer, identity: id, group: "group")
            XCTAssertNil(try peer.entry(thought)); XCTAssertTrue(try peer.isRetired("thought", thought))
            XCTAssertFalse(try peer.isRetired("tag", thought))
            XCTAssertEqual(try peer.tags().first?["name"] as? String, "Surviving tag")
            XCTAssertTrue(try peer.db.run("SELECT * FROM recovery WHERE kind='thought'").isEmpty)
            XCTAssertEqual(try peer.receipts()[id["deviceId"] as! String], try source.receipts()[id["deviceId"] as! String])
        }
        try source.execute(method: "saveTag", input: ["id": thought, "name": "Renamed after clearing"])
        _ = try apply(source, to: target, identity: id, group: "group")
        XCTAssertEqual(try target.tags().first?["name"] as? String, "Renamed after clearing")
    }
    func testReprojectingTagRestoresThoughtAssociationsWithoutCreatingLocalOperations() throws {
        let library = try store(); _ = try identity(library)
        let tag = UUID().uuidString.lowercased(); try library.execute(method: "saveTag", input: ["id": tag, "name": "Tasks"])
        let thought = try save(library, "Tagged", tags: [tag]); try library.nativeCall("syncEnroll", ["groupId": "group"])
        let count = try library.operations().count
        try library.db.transaction {
            try library.db.run("DELETE FROM tags WHERE id=?", [tag])
            try library.project("thought", thought)
            XCTAssertEqual(try library.entry(thought)?["tagIds"] as? [String], [])
            try library.project("tag", tag)
        }
        XCTAssertEqual(try library.entry(thought)?["tagIds"] as? [String], [tag])
        XCTAssertEqual(try library.db.run("SELECT * FROM entry_tags").count, 1)
        XCTAssertEqual(try library.operations().count, count)
    }
    func testLegacyMigrationSnapshotIncludesWALAndRollbackPreservesAssociations() throws {
        let url = directory.appendingPathComponent("legacy.sqlite"), database = try SQLite(url: url)
        for sql in [
            "CREATE TABLE tags(id TEXT PRIMARY KEY,name TEXT,normalized_name TEXT UNIQUE,type TEXT)",
            "CREATE TABLE entries(id TEXT PRIMARY KEY,created_at INTEGER,completed INTEGER,starred INTEGER,search_text TEXT,payload TEXT)",
            "CREATE TABLE entry_tags(entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE,tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE,PRIMARY KEY(entry_id,tag_id))",
            "CREATE INDEX entry_tags_tag ON entry_tags(tag_id,entry_id)", "CREATE TABLE profiles(id TEXT PRIMARY KEY,payload TEXT)", "CREATE TABLE drafts(profile_key TEXT PRIMARY KEY,payload TEXT)",
            "CREATE TABLE commits(entry_id TEXT PRIMARY KEY,profile_key TEXT)", "CREATE TABLE recovery(id TEXT PRIMARY KEY,entity_id TEXT,created_at INTEGER,payload TEXT)", "PRAGMA user_version=1"
        ] { try database.run(sql) }
        let tag = UUID().uuidString.lowercased(), thought = UUID().uuidString.lowercased()
        let value: [String: Any] = ["id": thought, "text": "Legacy", "tagIds": [tag], "createdAt": 1, "updatedAt": 2, "starred": true, "completed": true, "attachments": [Any](), "location": NSNull(), "profileId": NSNull(), "revision": "old revision"]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
        try database.run("INSERT INTO tags VALUES(?,?,?,'checklist')", [tag,"Tasks","tasks"]); try database.run("INSERT INTO entries VALUES(?,1,1,1,'legacy',?)", [thought,json]); try database.run("INSERT INTO entry_tags VALUES(?,?)", [thought,tag])
        try database.run("INSERT INTO recovery VALUES('old',?,1,?)", [thought,json]); try database.run("INSERT INTO drafts VALUES('app:general',?)", ["{\"profileKey\":\"app:general\",\"entryId\":\"\(UUID().uuidString.lowercased())\",\"text\":\"Unsent\",\"tagIds\":[\"\(tag)\"],\"profileId\":null,\"attachments\":[],\"location\":null}"])
        try database.run("CREATE TABLE tags_next(collision TEXT)")
        XCTAssertThrowsError(try LibraryStore(databaseURL: url)); XCTAssertEqual(try database.run("SELECT * FROM entry_tags").count, 1); XCTAssertEqual(try database.run("PRAGMA user_version").first?["user_version"] as? Int64, 1)
        let snapshot = try SQLite(url: url.appendingPathExtension("before-connected-v2")); XCTAssertEqual(try snapshot.run("SELECT * FROM entries").count, 1)
        try database.run("DROP TABLE tags_next"); let migrated = try LibraryStore(databaseURL: url)
        XCTAssertEqual(try migrated.requireEntry(thought)["revision"] as? String, "old revision"); XCTAssertEqual(try migrated.db.run("SELECT * FROM entry_tags").count, 1)
        XCTAssertEqual((try migrated.execute(method: "getDraft")["draft"] as? [String: Any])?["text"] as? String, "Unsent")
        XCTAssertEqual((try migrated.execute(method: "listRecovery")["items"] as? [[String: Any]])?.count, 1)
        try migrated.putProjectedTag(["id": UUID().uuidString.lowercased(), "name": "Tasks", "type": "standard"])
        XCTAssertEqual(try migrated.tags().count, 2)
    }
}
