import Foundation
import XCTest
@testable import MuseamoNative

final class LibraryStoreTests: XCTestCase {
    private var directory: URL!
    private var databaseURL: URL { directory.appendingPathComponent("library.sqlite3") }

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("MuseamoNativeTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }

    private func draft(_ store: LibraryStore, tagID: String? = nil) throws -> [String: Any] {
        let result = try store.execute(method: "getDraft", input: tagID.map { ["tagId": $0] } ?? [:])
        return try XCTUnwrap(result["draft"] as? [String: Any])
    }
    private func save(_ store: LibraryStore, text: String, tagIDs: [String] = []) throws -> String {
        var value = try draft(store)
        value["text"] = text
        value["tagIds"] = tagIDs
        let result = try store.execute(method: "commitDraft", input: ["draft": value])
        return try XCTUnwrap(result["entryId"] as? String)
    }
    private func entry(_ store: LibraryStore, _ id: String) throws -> [String: Any] {
        try XCTUnwrap(store.execute(method: "getEntry", input: ["id": id])["entry"] as? [String: Any])
    }
    private func rows(_ store: LibraryStore, query: [String: Any] = [:]) throws -> [[String: Any]] {
        try XCTUnwrap(store.execute(method: "queryEntries", input: query)["entries"] as? [[String: Any]])
    }

    func testDraftAndThoughtSurviveCloseAndReopen() throws {
        var store: LibraryStore? = try LibraryStore(databaseURL: databaseURL)
        let captured = try draft(store!)
        let id = try XCTUnwrap(captured["entryId"] as? String)
        XCTAssertNotNil(UUID(uuidString: id))
        try store!.execute(method: "updateDraft", input: ["profileKey": captured["profileKey"]!, "text": "Still writing #café", "tagIds": [String]()])
        store = nil
        store = try LibraryStore(databaseURL: databaseURL)
        var reopened = try draft(store!)
        XCTAssertEqual(reopened["entryId"] as? String, id)
        XCTAssertEqual(reopened["text"] as? String, "Still writing #café")
        reopened["text"] = "Finished #café"
        XCTAssertEqual(try store!.execute(method: "commitDraft", input: ["draft": reopened])["entryId"] as? String, id)
        store = nil
        let final = try LibraryStore(databaseURL: databaseURL)
        XCTAssertEqual(try entry(final, id)["text"] as? String, "Finished #café")
        XCTAssertNotEqual(try draft(final)["entryId"] as? String, id)
        let tags = try XCTUnwrap(final.execute(method: "library")["tags"] as? [[String: Any]])
        XCTAssertEqual(tags.first?["name"] as? String, "café")
        XCTAssertEqual((tags.first?["count"] as? NSNumber)?.intValue, 1)
    }

    func testCommitIsIdempotentAndDoesNotDeleteNewDraft() throws {
        let store = try LibraryStore(databaseURL: databaseURL)
        var original = try draft(store)
        original["text"] = "Once"
        let id = try XCTUnwrap(store.execute(method: "commitDraft", input: ["draft": original])["entryId"] as? String)
        let next = try draft(store)
        XCTAssertEqual(try store.execute(method: "commitDraft", input: ["draft": original])["entryId"] as? String, id)
        XCTAssertEqual(try draft(store)["entryId"] as? String, next["entryId"] as? String)
        XCTAssertEqual(try rows(store).count, 1)
        try store.execute(method: "deleteEntry", input: ["id": id])
        XCTAssertEqual(try store.execute(method: "commitDraft", input: ["draft": original])["entryId"] as? String, id)
        XCTAssertEqual(try rows(store).count, 0)
        var forged = next
        forged["entryId"] = UUID().uuidString
        forged["text"] = "Wrong draft"
        XCTAssertThrowsError(try store.execute(method: "commitDraft", input: ["draft": forged]))
        XCTAssertEqual(try draft(store)["entryId"] as? String, next["entryId"] as? String)
    }

    func testInvalidWritesLeaveDraftAndLibraryIntact() throws {
        let store = try LibraryStore(databaseURL: databaseURL)
        var value = try draft(store)
        try store.execute(method: "updateDraft", input: ["profileKey": value["profileKey"]!, "text": "Keep me", "tagIds": [String]()])
        value["text"] = "Unsupported #new-tag"
        value["attachments"] = [["id": "not-imported"]]
        XCTAssertThrowsError(try store.execute(method: "commitDraft", input: ["draft": value]))
        value["attachments"] = [Any]()
        value["location"] = ["latitude": 1, "longitude": 2]
        XCTAssertThrowsError(try store.execute(method: "commitDraft", input: ["draft": value]))
        value["location"] = NSNull()
        value["text"] = "  \n "
        XCTAssertThrowsError(try store.execute(method: "commitDraft", input: ["draft": value]))
        XCTAssertEqual(try draft(store)["text"] as? String, "Keep me")
        XCTAssertEqual(try rows(store).count, 0)
        XCTAssertEqual((try store.execute(method: "library")["tags"] as? [[String: Any]])?.count, 0)
    }

    func testCursorOrderingFiltersAndSearchTreatWildcardsLiterally() throws {
        let store = try LibraryStore(databaseURL: databaseURL)
        try store.execute(method: "saveTag", input: ["id": "list", "name": "List", "type": "checklist"])
        let a = try save(store, text: "ALPHA café 100%", tagIDs: ["list"])
        let b = try save(store, text: "Beta", tagIDs: ["list"])
        let c = try save(store, text: "Outside")
        let aUpdated = try entry(store, a)["updatedAt"] as? NSNumber
        let bUpdated = try entry(store, b)["updatedAt"] as? NSNumber
        try store.execute(method: "setCompleted", input: ["id": b, "completed": true])
        try store.execute(method: "setStar", input: ["id": a, "starred": true])
        XCTAssertEqual(try entry(store, a)["updatedAt"] as? NSNumber, aUpdated)
        XCTAssertEqual(try entry(store, b)["updatedAt"] as? NSNumber, bUpdated)
        XCTAssertThrowsError(try store.execute(method: "setCompleted", input: ["id": c, "completed": true]))
        XCTAssertEqual(try rows(store, query: ["checklistOnly": true]).count, 2)
        XCTAssertEqual(try rows(store, query: ["starred": true]).first?["id"] as? String, a)
        XCTAssertEqual(try rows(store, query: ["search": "CAFÉ"]).first?["id"] as? String, a)
        XCTAssertEqual(try rows(store, query: ["search": "%"]).count, 1)
        XCTAssertEqual(try rows(store, query: ["located": true]).count, 0)
        let firstPage = try store.execute(method: "queryEntries", input: ["tagId": "list", "order": "checklist", "limit": 1])
        XCTAssertEqual(firstPage["hasMore"] as? Bool, true)
        let first = try XCTUnwrap((firstPage["entries"] as? [[String: Any]])?.first)
        XCTAssertEqual(first["id"] as? String, a)
        let second = try rows(store, query: ["tagId": "list", "order": "checklist", "limit": 1, "beforeTime": first["createdAt"]!, "beforeId": a, "beforeCompleted": false])
        XCTAssertEqual(second.first?["id"] as? String, b)
        XCTAssertThrowsError(try store.execute(method: "queryEntries", input: ["tagId": "list", "order": "checklist", "beforeTime": first["createdAt"]!]))
        XCTAssertThrowsError(try store.execute(method: "queryEntries", input: ["tagId": "unknown", "order": "checklist"]))
        var gathered: [String] = []
        var query: [String: Any] = ["limit": 1]
        while let row = try rows(store, query: query).first {
            let id = try XCTUnwrap(row["id"] as? String)
            gathered.append(id)
            query = ["limit": 1, "beforeTime": row["createdAt"]!, "beforeId": id]
        }
        XCTAssertEqual(Set(gathered), Set([a, b, c]))
        XCTAssertEqual(gathered.count, 3)
    }

    func testRevisionGuardAndRecoverySurviveReopen() throws {
        var store: LibraryStore? = try LibraryStore(databaseURL: databaseURL)
        let id = try save(store!, text: "First")
        let original = try entry(store!, id)
        let revision = try XCTUnwrap(original["revision"] as? String)
        try store!.execute(method: "updateEntry", input: ["id": id, "text": "Second", "tagIds": [String](), "baseRevision": revision])
        XCTAssertThrowsError(try store!.execute(method: "updateEntry", input: ["id": id, "text": "Stale", "tagIds": [String](), "baseRevision": revision]))
        XCTAssertThrowsError(try store!.execute(method: "deleteEntry", input: ["id": id, "baseRevision": revision]))
        XCTAssertEqual(try entry(store!, id)["text"] as? String, "Second")
        try store!.execute(method: "deleteEntry", input: ["id": id])
        store = nil
        let reopened = try LibraryStore(databaseURL: databaseURL)
        let recovery = try XCTUnwrap(reopened.execute(method: "listRecovery")["items"] as? [[String: Any]])
        XCTAssertEqual(recovery.count, 2)
        let first = try XCTUnwrap(recovery.first { ($0["payload"] as? [String: Any])?["text"] as? String == "First" })
        let restored = try XCTUnwrap(reopened.execute(method: "restoreRecovery", input: ["id": first["id"]!])["entryId"] as? String)
        XCTAssertNotEqual(restored, id)
        XCTAssertEqual(try entry(reopened, restored)["text"] as? String, "First")
        try reopened.execute(method: "clearAllRecovery")
        XCTAssertEqual((try reopened.execute(method: "listRecovery")["items"] as? [[String: Any]])?.count, 0)
    }

    func testTagDeletionCleansDraftProfileEntryAndDoesNotRecreateInlineTag() throws {
        let store = try LibraryStore(databaseURL: databaseURL)
        try store.execute(method: "saveTag", input: ["id": "tag", "name": "Café", "type": "checklist"])
        XCTAssertThrowsError(try store.execute(method: "saveTag", input: ["name": "Cafe\u{301}"]))
        let id = try save(store, text: "#Café", tagIDs: ["tag"])
        try store.execute(method: "saveProfile", input: ["profile": ["id": "profile", "label": "Capture", "mode": "picker", "tagIds": ["tag"], "selectedTagId": "tag"]])
        let profileDraft = try XCTUnwrap(store.execute(method: "getDraft", input: ["profileId": "profile"])["draft"] as? [String: Any])
        XCTAssertEqual(profileDraft["tagIds"] as? [String], ["tag"])
        try store.execute(method: "deleteTag", input: ["id": "tag"])
        XCTAssertEqual(try entry(store, id)["tagIds"] as? [String], [])
        let updated = try XCTUnwrap(store.execute(method: "getDraft", input: ["profileId": "profile"])["draft"] as? [String: Any])
        XCTAssertEqual(updated["tagIds"] as? [String], [])
        try store.execute(method: "updateEntry", input: ["id": id, "text": "Edited #Café", "tagIds": [String]()])
        XCTAssertEqual((try store.execute(method: "library")["tags"] as? [[String: Any]])?.count, 0)
        let profiles = try XCTUnwrap(store.execute(method: "library")["profiles"] as? [[String: Any]])
        XCTAssertTrue(profiles.first?["selectedTagId"] is NSNull)
    }

    func testSharedHashtagFixtures() throws {
        let fixture = try XCTUnwrap(Bundle.module.url(forResource: "hashtags", withExtension: "json", subdirectory: "Fixtures"))
        let cases = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [[String: Any]])
        for item in cases {
            let text = try XCTUnwrap(item["text"] as? String)
            XCTAssertEqual(Hashtags.names(text), item["names"] as? [String], text)
        }
    }

    func testTransactionRollsBackPartiallyCreatedInlineTags() throws {
        let store = try LibraryStore(databaseURL: databaseURL)
        var value = try draft(store)
        value["text"] = "#fresh #\"\(String(repeating: "🪷", count: 50))\""
        // Regex counts Unicode scalars, but tag storage validates the 80 UTF-16 editor limit.
        XCTAssertThrowsError(try store.execute(method: "commitDraft", input: ["draft": value]))
        XCTAssertEqual((try store.execute(method: "library")["tags"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual(try draft(store)["entryId"] as? String, value["entryId"] as? String)
    }

    func testUnknownMethodRollsBackAndFutureSchemaIsRejected() throws {
        let store = try LibraryStore(databaseURL: databaseURL)
        XCTAssertThrowsError(try store.execute(method: "unsupported"))
        XCTAssertNotNil(try save(store, text: "Still usable"))
        let futureURL = directory.appendingPathComponent("future.sqlite3")
        var future: SQLite? = try SQLite(url: futureURL)
        try future!.run("PRAGMA user_version = 2")
        future = nil
        XCTAssertThrowsError(try LibraryStore(databaseURL: futureURL))
        let check = try SQLite(url: futureURL)
        XCTAssertEqual(try check.run("PRAGMA user_version").first?["user_version"] as? Int64, 2)
    }

    func testEmbeddedNullAndUnicodeArePreservedAndSearchable() throws {
        let db = try SQLite(url: directory.appendingPathComponent("bytes.sqlite3"))
        try db.run("CREATE TABLE samples (value TEXT NOT NULL)")
        for value in ["", "before\u{0}after", "前\u{0}🪷café"] {
            try db.run("INSERT INTO samples(value) VALUES(?)", [value])
            XCTAssertEqual(try db.run("SELECT value FROM samples ORDER BY rowid DESC LIMIT 1").first?["value"] as? String, value)
        }
        var store: LibraryStore? = try LibraryStore(databaseURL: databaseURL)
        let text = "前\u{0}After 🪷"
        let id = try save(store!, text: text)
        try store!.execute(method: "saveTag", input: ["id": "null-name", "name": "Before\u{0}After"])
        store = nil
        let reopened = try LibraryStore(databaseURL: databaseURL)
        XCTAssertEqual(try entry(reopened, id)["text"] as? String, text)
        XCTAssertEqual(try rows(reopened, query: ["search": "AFTER"]).first?["id"] as? String, id)
        let tags = try XCTUnwrap(reopened.execute(method: "library")["tags"] as? [[String: Any]])
        XCTAssertEqual(tags.first?["name"] as? String, "Before\u{0}After")
    }

    func testBridgeJSONBooleansAndJavaScriptDateBounds() throws {
        let store = try LibraryStore(databaseURL: databaseURL)
        var value = try draft(store)
        value["text"] = "JSON bridge"
        let json = try JSONSerialization.data(withJSONObject: ["draft": value])
        let input = try XCTUnwrap(JSONSerialization.jsonObject(with: json) as? [String: Any])
        let id = try XCTUnwrap(store.execute(method: "commitDraft", input: input)["entryId"] as? String)
        let star = try XCTUnwrap(JSONSerialization.jsonObject(with: Data("{\"id\":\"\(id)\",\"starred\":true}".utf8)) as? [String: Any])
        try store.execute(method: "setStar", input: star)
        XCTAssertEqual(try entry(store, id)["starred"] as? Bool, true)
        XCTAssertThrowsError(try store.execute(method: "setStar", input: ["id": id, "starred": 1]))
        var original = try entry(store, id)
        original["createdAt"] = Int64(8_640_000_000_000_000)
        XCTAssertNoThrow(try store.execute(method: "restoreEntry", input: ["entry": original]))
        let count = try rows(store).count
        original["createdAt"] = Int64(8_640_000_000_000_001)
        XCTAssertThrowsError(try store.execute(method: "restoreEntry", input: ["entry": original]))
        XCTAssertThrowsError(try store.execute(method: "queryEntries", input: ["beforeTime": Int64(8_640_000_000_000_001)]))
        XCTAssertEqual(try rows(store).count, count)
    }
}
