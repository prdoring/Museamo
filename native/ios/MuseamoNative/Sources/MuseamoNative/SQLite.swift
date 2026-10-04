import Foundation
import CoreFoundation
import CSQLite

public struct LibraryError: LocalizedError {
    public let message: String
    public var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

/// Access is confined to the owning LibraryStore's serial caller.
final class SQLite {
    private var handle: OpaquePointer?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let result = sqlite3_open_v2(url.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        guard result == SQLITE_OK else {
            let error = failure()
            sqlite3_close(handle)
            handle = nil
            throw error
        }
        sqlite3_busy_timeout(handle, 5_000)
        do {
            try run("PRAGMA foreign_keys = ON")
            try run("PRAGMA journal_mode = WAL")
            try run("PRAGMA synchronous = FULL")
        } catch {
            sqlite3_close(handle)
            handle = nil
            throw error
        }
    }

    deinit { sqlite3_close(handle) }

    private func failure() -> LibraryError {
        LibraryError("Library storage failed: \(handle.map { String(cString: sqlite3_errmsg($0)) } ?? "cannot open database")")
    }

    @discardableResult
    func run(_ sql: String, _ bindings: [Any] = []) throws -> [[String: Any]] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw failure() }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_bind_parameter_count(statement) == Int32(bindings.count) else { throw LibraryError("Invalid storage parameters.") }
        for (offset, value) in bindings.enumerated() {
            let index = Int32(offset + 1)
            let result: Int32
            if value is NSNull { result = sqlite3_bind_null(statement, index) }
            else if let text = value as? String {
                let byteCount = text.utf8.count
                guard byteCount <= Int32.max else { throw LibraryError("Text exceeds the library storage limit.") }
                result = text.withCString { bytes in
                    sqlite3_bind_text(statement, index, bytes, Int32(byteCount), transient)
                }
            }
            else if let number = value as? NSNumber {
                if CFGetTypeID(number) == CFBooleanGetTypeID() { result = sqlite3_bind_int(statement, index, number.boolValue ? 1 : 0) }
                else { result = sqlite3_bind_int64(statement, index, number.int64Value) }
            } else { throw LibraryError("Unsupported storage value.") }
            guard result == SQLITE_OK else { throw failure() }
        }
        var rows: [[String: Any]] = []
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE { return rows }
            guard result == SQLITE_ROW else { throw failure() }
            var row: [String: Any] = [:]
            for column in 0..<sqlite3_column_count(statement) {
                let key = String(cString: sqlite3_column_name(statement, column))
                switch sqlite3_column_type(statement, column) {
                case SQLITE_INTEGER: row[key] = sqlite3_column_int64(statement, column)
                case SQLITE_FLOAT: row[key] = sqlite3_column_double(statement, column)
                case SQLITE_NULL: row[key] = NSNull()
                default:
                    let byteCount = Int(sqlite3_column_bytes(statement, column))
                    if byteCount == 0 { row[key] = "" }
                    else {
                        guard let bytes = sqlite3_column_text(statement, column) else { throw failure() }
                        row[key] = String(decoding: UnsafeBufferPointer(start: bytes, count: byteCount), as: UTF8.self)
                    }
                }
            }
            rows.append(row)
        }
    }

    func transaction<T>(_ body: () throws -> T) throws -> T {
        try run("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try run("COMMIT")
            return result
        } catch {
            _ = try? run("ROLLBACK")
            throw error
        }
    }
}
