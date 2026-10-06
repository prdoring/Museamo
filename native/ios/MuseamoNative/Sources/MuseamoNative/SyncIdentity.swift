import Foundation
import Security

/// Installation-scoped keys never enter a bridge response, portable library, or iCloud Keychain.
public final class SyncIdentity {
    private let installation: String
    private let service = "com.prdoring.museamo.sync.v1"
    public init(installation: String) { self.installation = installation }
    private func query(_ account: String, _ kind: CFString = kSecClassGenericPassword) -> [String: Any] {
        var result: [String: Any] = [kSecClass as String: kind, kSecAttrSynchronizable as String: false]
        if kind == kSecClassKey { result[kSecAttrApplicationTag as String] = Data("\(service).\(installation).\(account)".utf8); result[kSecAttrKeyType as String] = kSecAttrKeyTypeECSECPrimeRandom }
        else { result[kSecAttrService as String] = service; result[kSecAttrAccount as String] = "\(installation).\(account)" }
        #if os(macOS)
        result[kSecUseDataProtectionKeychain as String] = true
        #endif
        return result
    }
    private func failure(_ status: OSStatus) -> LibraryError { LibraryError("The device security key is unavailable (\(status)). Your local library is kept; sync cannot continue.") }
    private func signingKey(create: Bool) throws -> SecKey {
        var lookup = query("signing", kSecClassKey); lookup[kSecReturnRef as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if status == errSecSuccess, let result { return (result as! SecKey) }
        guard status == errSecItemNotFound, create else { throw failure(status) }
        var attributes = query("signing", kSecClassKey)
        attributes.removeValue(forKey: kSecClass as String)
        attributes[kSecAttrKeySizeInBits as String] = 256
        attributes[kSecPrivateKeyAttrs as String] = [kSecAttrIsPermanent as String: true,
            kSecAttrApplicationTag as String: Data("\(service).\(installation).signing".utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else { throw error?.takeRetainedValue() as Error? ?? failure(errSecInternalError) }
        return key
    }
    public func identity(create: Bool, name: String) throws -> [String: Any] {
        let key = try signingKey(create: create)
        var lookup = query("noise"); lookup[kSecReturnData as String] = true
        var result: CFTypeRef?; let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        let noise: [String: Any]
        if status == errSecSuccess, let data = result as? Data,
           let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] { noise = value }
        else {
            guard status == errSecItemNotFound, create else { throw failure(status) }
            noise = try SyncCore.evaluate(["action": "newNoiseKey"])
            var insertion = query("noise"); insertion[kSecValueData as String] = try JSONSerialization.data(withJSONObject: noise)
            insertion[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            let saved = SecItemAdd(insertion as CFDictionary, nil); guard saved == errSecSuccess else { throw failure(saved) }
        }
        guard let publicKey = SecKeyCopyPublicKey(key), let publicBytes = SecKeyCopyExternalRepresentation(publicKey, nil) as Data? else { throw failure(errSecDecode) }
        guard let privateKey = noise["private"] as? String, let noisePublic = noise["public"] as? String,
              try SyncCore.bytes(privateKey).count == 32, try SyncCore.bytes(noisePublic).count == 32 else { throw failure(errSecDecode) }
        return ["deviceId": installation, "name": name, "noisePrivate": privateKey, "noisePublic": noisePublic, "signingPublic": SyncCore.hex(publicBytes)]
    }
    public func sign(_ bytes: Data) throws -> String {
        guard bytes.count <= 25 * 1024 * 1024 else { throw LibraryError("Signing request is too large.") }
        let key = try signingKey(create: false); var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, bytes as CFData, &error) as Data? else { throw error?.takeRetainedValue() as Error? ?? failure(errSecInternalError) }
        return SyncCore.hex(signature)
    }
}
