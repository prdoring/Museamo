import Foundation
import CryptoKit
import XCTest
@testable import MuseamoNative

/// Real Rust listeners call real Swift repositories. No Keychain/UI or fake journals.
final class RuntimeInteropTests: XCTestCase {
    private final class Peer {
        let queue = DispatchQueue(label: "Swift-peer-\(UUID().uuidString)")
        let store: LibraryStore
        let runtime: NativeSyncRuntime
        init(_ directory: URL) throws {
            let native = try LibraryStore(databaseURL: directory.appendingPathComponent("library.sqlite"))
            let signing = P256.Signing.PrivateKey(), noise = try SyncCore.evaluate(["action": "newNoiseKey"])
            let identity: [String: Any] = ["deviceId": UUID().uuidString.lowercased(), "name": "Swift peer", "noisePrivate": noise["private"]!, "noisePublic": noise["public"]!, "signingPublic": SyncCore.hex(signing.publicKey.x963Representation)]
            native.configureSync(identity: { identity }, sign: { try SyncCore.hex(signing.signature(for: $0).derRepresentation) })
            store = native
            let serial = queue
            runtime = try NativeSyncRuntime { method, input in try serial.sync { try native.nativeCall(method, input) } }
        }
        func local(_ method: String, _ input: [String: Any] = [:]) throws -> [String: Any] { let result = try queue.sync { try store.execute(method: method, input: input) }; _ = try runtime.command("localDataChanged"); return result }
        func save(_ text: String, _ tags: [String] = [], media: [[String: Any]] = [], location: [String: Any]? = nil) throws -> String {
            var draft = try XCTUnwrap(local("getDraft")["draft"] as? [String: Any]); draft["text"] = text; draft["tagIds"] = tags; draft["attachments"] = media; if let location { draft["location"] = location }
            return try XCTUnwrap(local("commitDraft", ["draft": draft])["entryId"] as? String)
        }
        func thoughts() throws -> [[String: Any]] { try XCTUnwrap(local("queryEntries")["entries"] as? [[String: Any]]) }
        deinit { runtime.stop() }
    }
    private func awaitState(_ predicate: () throws -> Bool, file: StaticString = #filePath, line: UInt = #line) throws {
        let end = Date().addingTimeInterval(12)
        while Date() < end { if try predicate() { return }; Thread.sleep(forTimeInterval: 0.02) }
        XCTFail("Swift/Rust peers did not converge before timeout", file: file, line: line)
    }
    func testQRSharingPreservesPrivateBoundariesAndLinkedPersonalDevicesReceiveSharedTags() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("MuseamoInterop-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let owner = try Peer(directory.appendingPathComponent("owner")), member = try Peer(directory.appendingPathComponent("member")), personal = try Peer(directory.appendingPathComponent("personal"))
        defer { owner.runtime.stop(); member.runtime.stop(); personal.runtime.stop() }
        let tag = UUID().uuidString.lowercased(), privateTag = UUID().uuidString.lowercased()
        try owner.local("saveTag", ["id": tag, "name": "Tasks", "type": "checklist"]); try owner.local("saveTag", ["id": privateTag, "name": "Private"])
        _ = try owner.save("Secret outside the shared tag", [privateTag]); let sharedID = try owner.save("Earlier private history", [tag, privateTag])
        let original = directory.appendingPathComponent("original.jpg"), originalBytes = Data(repeating: 3, count: 19000); try originalBytes.write(to: original)
        let media = try owner.queue.sync { try owner.store.importMedia(from: original, metadata: ["kind": "image", "mimeType": "image/jpeg", "filename": "original.jpg", "width": 100, "height": 100]) }
        let location: [String: Any] = ["latitude": 37.7, "longitude": -122.4, "capturedAt": 10, "token": UUID().uuidString.lowercased()]
        try owner.local("updateEntry", ["id": sharedID, "text": "Shared checklist", "tagIds": [tag, privateTag], "attachmentIds": [media["id"]!], "location": location])
        try owner.local("setStar", ["id": sharedID, "starred": true]); _ = try member.save("Member private thought"); _ = try personal.save("Personal existing thought")
        try member.local("saveTag", ["id": UUID().uuidString.lowercased(), "name": "Tasks"])
        _ = try owner.runtime.command("startTagSharing", ["tagId": tag])
        let invitation = try XCTUnwrap(owner.runtime.command("createTagInvite", ["tagId": tag])["invite"] as? String)
        let preview = try member.runtime.command("previewTagInvite", ["invite": invitation]); XCTAssertEqual(preview["name"] as? String, "Tasks")
        XCTAssertEqual(try member.thoughts().count, 1)
        let joined = try member.runtime.command("joinTagShare", ["invite": invitation]), joinedTag = try XCTUnwrap(joined["tagId"] as? String)
        try awaitState { try member.thoughts().contains { $0["text"] as? String == "Shared checklist" } }
        let copied = try XCTUnwrap(member.thoughts().first { $0["text"] as? String == "Shared checklist" })
        XCTAssertEqual(copied["starred"] as? Bool, false); XCTAssertEqual(copied["tagIds"] as? [String], [joinedTag])
        XCTAssertEqual((copied["location"] as? [String: Any])?["latitude"] as? Double, 37.7)
        XCTAssertEqual((copied["attachments"] as? [[String: Any]])?.first?["checksum"] as? String, media["checksum"] as? String)
        let mediaID = media["id"] as! String
        try awaitState { try member.queue.sync { try member.store.originalURL(mediaID) != nil } }
        XCTAssertEqual(try member.queue.sync { try Data(contentsOf: XCTUnwrap(member.store.originalURL(mediaID))) }, originalBytes)
        XCTAssertFalse(try member.thoughts().contains { ($0["text"] as? String)?.contains("Secret") == true })
        let history = try XCTUnwrap(member.local("listRecovery")["items"] as? [[String: Any]])
        XCTAssertFalse(history.contains { ($0["payload"] as? [String: Any])?["text"] as? String == "Earlier private history" })
        XCTAssertNotEqual(try owner.queue.sync { try owner.store.metadata("group") }, try member.queue.sync { try member.store.metadata("group") })
        let copiedID = try XCTUnwrap(copied["id"] as? String)
        try member.local("setCompleted", ["id": copiedID, "completed": true])
        try awaitState { try owner.thoughts().first { $0["text"] as? String == "Shared checklist" }?["completed"] as? Bool == true }
        let second = UUID().uuidString.lowercased(); try owner.local("saveTag", ["id": second, "name": "Second shared list"])
        _ = try owner.runtime.command("startTagSharing", ["tagId": second])
        XCTAssertThrowsError(try owner.local("updateEntry", ["id": sharedID, "text": "Must stay in one list", "tagIds": [tag, second]]))
        // Linking is a separate handshake with matching-code confirmation and merge consent.
        let address = try XCTUnwrap(owner.runtime.command("getSyncState")["address"] as? String)
        _ = try personal.runtime.command("linkDevice", ["address": address])
        try awaitState { try (owner.runtime.command("getSyncState")["pairing"] as? [String: Any])?["code"] is String && (personal.runtime.command("getSyncState")["pairing"] as? [String: Any])?["code"] is String }
        let lhs = try XCTUnwrap(owner.runtime.command("getSyncState")["pairing"] as? [String: Any]), rhs = try XCTUnwrap(personal.runtime.command("getSyncState")["pairing"] as? [String: Any])
        XCTAssertEqual(lhs["code"] as? String, rhs["code"] as? String)
        _ = try owner.runtime.command("confirmPairing", ["sessionId": lhs["sessionId"]!, "confirmed": true]); _ = try personal.runtime.command("confirmPairing", ["sessionId": rhs["sessionId"]!, "confirmed": true])
        try awaitState { try (owner.runtime.command("getSyncState")["pairing"] as? [String: Any])?["summary"] is [String: Any] && (personal.runtime.command("getSyncState")["pairing"] as? [String: Any])?["summary"] is [String: Any] }
        XCTAssertFalse(try personal.thoughts().contains { $0["text"] as? String == "Shared checklist" })
        _ = try owner.runtime.command("acceptEnrollment", ["sessionId": lhs["sessionId"]!, "accepted": true]); _ = try personal.runtime.command("acceptEnrollment", ["sessionId": rhs["sessionId"]!, "accepted": true])
        try awaitState { try personal.thoughts().contains { $0["text"] as? String == "Shared checklist" } }
        let sharing = try XCTUnwrap(owner.runtime.initialState["sharing"] as? [String: Any]), listen = try XCTUnwrap(sharing["address"] as? String)
        let port = try XCTUnwrap(listen.split(separator: ":").last)
        _ = try personal.runtime.command("shareDiscoveryHint", ["deviceId": owner.runtime.initialState["deviceId"]!, "address": "127.0.0.1:\(port)"])
        try awaitState { try (personal.local("library")["tags"] as? [[String: Any]] ?? []).contains { $0["sharing"] != nil } }
        XCTAssertTrue(try personal.thoughts().contains { $0["text"] as? String == "Personal existing thought" })
        _ = try member.runtime.command("leaveTagShare", ["tagId": joinedTag])
        XCTAssertTrue(try member.thoughts().contains { $0["text"] as? String == "Shared checklist" })
        XCTAssertFalse(try (member.local("library")["tags"] as? [[String: Any]] ?? []).contains { $0["sharing"] != nil })
        _ = try owner.runtime.command("stopTagSharing", ["tagId": tag])
        XCTAssertTrue(try owner.thoughts().contains { $0["text"] as? String == "Shared checklist" && $0["starred"] as? Bool == true })
    }
}
