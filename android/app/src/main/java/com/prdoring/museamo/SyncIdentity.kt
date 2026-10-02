package com.prdoring.museamo

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONObject
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Signing keys never leave Keystore. The Noise key is encrypted by an app-scoped Keystore key. */
class SyncIdentity(private val context: Context) {
    private val keystore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val signingAlias = "museamo.sync.signing.v1"
    private val wrappingAlias = "museamo.sync.wrapping.v1"
    private val file = File(context.filesDir, "sync-identity.v1.enc")

    fun identity(repo: Repository): JSONObject = identity(repo.rawDao)
    @Synchronized fun identity(dao: StoreDao): JSONObject {
        if (!keystore.containsAlias(signingAlias)) {
            check(!file.exists()) { "The device security key is unavailable. Relink this installation after restoring its library." }
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                initialize(KeyGenParameterSpec.Builder(signingAlias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build())
            }.generateKeyPair()
        }
        val noise = if (file.exists()) readNoise() else {
            val pair = SyncCore.request(JSONObject().put("action", "newNoiseKey"))
            writeNoise(pair)
            pair
        }
        val id = dao.syncMetadata("device")?.value ?: uid().also { dao.putSyncMetadata(SyncMetadataRow("device", it)) }
        val name = dao.syncMetadata("device.name")?.value ?: android.os.Build.MODEL.take(80).also { dao.putSyncMetadata(SyncMetadataRow("device.name", it)) }
        val public = keystore.getCertificate(signingAlias).publicKey as ECPublicKey
        val bytes = byteArrayOf(4) + unsigned32(public.w.affineX.toByteArray()) + unsigned32(public.w.affineY.toByteArray())
        return JSONObject().put("deviceId", id).put("name", name)
            .put("noisePrivate", noise.getString("private")).put("noisePublic", noise.getString("public")).put("signingPublic", hex(bytes))
    }

    @Synchronized fun sign(bytes: ByteArray): String {
        require(bytes.size <= Backup.MAX_BYTES) { "Signing request is too large." }
        val entry = keystore.getEntry(signingAlias, null) as? KeyStore.PrivateKeyEntry ?: error("Signing key is unavailable")
        val signature = Signature.getInstance("SHA256withECDSA").apply { initSign(entry.privateKey); update(bytes) }.sign()
        return hex(signature)
    }
    private fun wrappingKey(): SecretKey {
        if (!keystore.containsAlias(wrappingAlias)) {
            check(!file.exists()) { "The wrapping key is unavailable. Device pairing needs to be reset." }
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder(wrappingAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build())
            }.generateKey()
        }
        return keystore.getKey(wrappingAlias, null) as SecretKey
    }
    private fun writeNoise(pair: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, wrappingKey()); updateAAD("museamo-noise-v1".toByteArray()) }
        val encrypted = cipher.doFinal(pair.toString().toByteArray(Charsets.UTF_8))
        val temp = File(context.filesDir, "sync-identity.v1.tmp")
        java.io.FileOutputStream(temp).use { it.write(byteArrayOf(cipher.iv.size.toByte())); it.write(cipher.iv); it.write(encrypted); it.fd.sync() }
        check(temp.renameTo(file)) { "Could not save the device security key" }
    }
    private fun readNoise(): JSONObject {
        val bytes = file.readBytes(); require(bytes.size in 32..4096) { "Stored device security key is damaged" }
        val size = bytes[0].toInt() and 255; require(size == 12 && bytes.size > size + 17)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, bytes.copyOfRange(1, size + 1))); updateAAD("museamo-noise-v1".toByteArray()) }
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(size + 1, bytes.size)), Charsets.UTF_8))
    }
    private fun unsigned32(bytes: ByteArray): ByteArray = ByteArray(32).also { output -> val trimmed = bytes.takeLast(32).toByteArray(); trimmed.copyInto(output, 32 - trimmed.size) }
    companion object {
        fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
        fun decode(value: String): ByteArray { require(value.length % 2 == 0 && value.matches(Regex("[0-9a-fA-F]*"))) { "Invalid hexadecimal bytes" }; return value.chunked(2).map { it.toInt(16).toByte() }.toByteArray() }
    }
}
