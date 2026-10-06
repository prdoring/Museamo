import Foundation
import MuseamoSyncCore

/// Pure protocol helpers may be called from the repository queue without entering a runtime.
public enum SyncCore {
    public static func evaluate(_ request: [String: Any]) throws -> [String: Any] {
        let bytes = try JSONSerialization.data(withJSONObject: request)
        return try bytes.withUnsafeBytes { raw in
            try response(museamo_sync_evaluate(raw.bindMemory(to: UInt8.self).baseAddress, bytes.count))
        }
    }
    public static func response(_ buffer: MuseamoBuffer) throws -> [String: Any] {
        defer { museamo_sync_free(buffer) }
        guard let pointer = buffer.data, buffer.len > 0, buffer.len <= 26 * 1024 * 1024,
              let object = try JSONSerialization.jsonObject(with: Data(bytes: pointer, count: buffer.len)) as? [String: Any] else {
            throw LibraryError("Invalid native sync response.")
        }
        guard object["ok"] as? Bool == true else { throw LibraryError(object["error"] as? String ?? "Native sync failed.") }
        return object["result"] as? [String: Any] ?? [:]
    }
    public static func hash(_ value: Any) throws -> String {
        guard let result = try evaluate(["action": "hash", "value": value])["hash"] as? String else { throw LibraryError("Invalid native digest.") }
        return result
    }
    public static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
    public static func bytes(_ hex: String) throws -> Data {
        guard hex.count % 2 == 0, hex.count <= 52 * 1024 * 1024 else { throw LibraryError("Invalid native byte encoding.") }
        var result = Data(); var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else { throw LibraryError("Invalid native byte encoding.") }
            result.append(byte); index = next
        }
        return result
    }
}

/// Runtime ownership and calls are serialized by its caller. Callbacks can arrive on workers.
public final class NativeSyncRuntime {
    private var handle: OpaquePointer?
    private let context: PlatformContext
    public let initialState: [String: Any]

    public init(call: @escaping (String, [String: Any]) throws -> [String: Any]) throws {
        guard museamo_sync_abi_version() == 1 else { throw LibraryError("Incompatible sync core.") }
        let callbackContext = PlatformContext(call: call)
        context = callbackContext
        var response = MuseamoBuffer(data: nil, len: 0)
        let callbacks = MuseamoCallbacks(abi_version: 1, context: Unmanaged.passUnretained(callbackContext).toOpaque(), call: platformCall,
            release_response: releaseResponse, retain_context: retainContext, release_context: releaseContext)
        let created = museamo_sync_create(callbacks, &response)
        do { initialState = try SyncCore.response(response) }
        catch { if let created { museamo_sync_destroy(created) }; throw error }
        guard let created else { throw LibraryError("Could not start sync.") }
        handle = created
    }
    public func command(_ method: String, _ input: [String: Any] = [:]) throws -> [String: Any] {
        guard let handle else { throw LibraryError("Sync is suspended. Reopen Museamo to resume.") }
        let methodBytes = Data(method.utf8), bytes = try JSONSerialization.data(withJSONObject: input)
        return try methodBytes.withUnsafeBytes { name in
            try bytes.withUnsafeBytes { body in
                try SyncCore.response(museamo_sync_command(handle, name.bindMemory(to: UInt8.self).baseAddress, methodBytes.count,
                    body.bindMemory(to: UInt8.self).baseAddress, bytes.count))
            }
        }
    }
    public func stop() { if let handle { self.handle = nil; museamo_sync_destroy(handle) } }
    deinit { stop() }
}
private final class PlatformContext {
    let call: (String, [String: Any]) throws -> [String: Any]
    init(call: @escaping (String, [String: Any]) throws -> [String: Any]) { self.call = call }
}
private func retainContext(_ pointer: UnsafeMutableRawPointer?) {
    guard let pointer else { return }; _ = Unmanaged<PlatformContext>.fromOpaque(pointer).retain()
}
private func releaseContext(_ pointer: UnsafeMutableRawPointer?) {
    guard let pointer else { return }; Unmanaged<PlatformContext>.fromOpaque(pointer).release()
}
private func releaseResponse(_ pointer: UnsafeMutableRawPointer?, _ buffer: MuseamoBuffer) { buffer.data?.deallocate() }
private func platformCall(_ pointer: UnsafeMutableRawPointer?, _ method: UnsafePointer<UInt8>?, _ methodLength: Int,
                          _ input: UnsafePointer<UInt8>?, _ inputLength: Int) -> MuseamoBuffer {
    let result: [String: Any]
    do {
        guard let pointer, let method, let input, methodLength > 0, methodLength <= 128, inputLength > 0, inputLength <= 26 * 1024 * 1024,
              let name = String(data: Data(bytes: method, count: methodLength), encoding: .utf8),
              let body = try JSONSerialization.jsonObject(with: Data(bytes: input, count: inputLength)) as? [String: Any] else { throw LibraryError("Invalid sync callback.") }
        result = ["ok": true, "result": try Unmanaged<PlatformContext>.fromOpaque(pointer).takeUnretainedValue().call(name, body)]
    } catch { result = ["ok": false, "error": error.localizedDescription] }
    let bytes = (try? JSONSerialization.data(withJSONObject: result)) ?? Data("{\"ok\":false,\"error\":\"Invalid platform response\"}".utf8)
    let output = UnsafeMutablePointer<UInt8>.allocate(capacity: bytes.count)
    bytes.copyBytes(to: output, count: bytes.count)
    return MuseamoBuffer(data: output, len: bytes.count)
}
