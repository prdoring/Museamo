package com.prdoring.museamo

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

object MediaBackup {
    fun export(context: Context, repo: Repository, output: OutputStream) {
        val files = MediaFiles(context, repo)
        // Caller runs on the repository executor, so this snapshot and its files cannot change.
        val root = JSONObject(Backup.export(repo)).put("version", 3)
        val rows = repo.dao.entries().flatMap { ids(it.mediaIds) }.distinct().map { requireNotNull(repo.dao.media(it)) }
        root.put("media", JSONArray(rows.map { it.json() }))
        val manifest = root.toString(2).toByteArray(Charsets.UTF_8)
        require(manifest.size <= Backup.MAX_BYTES) { "Backup metadata exceeds 25 MiB." }
        rows.forEach { require(files.file(it.id).isFile && files.file(it.id).length() == it.byteSize) { "An attachment is missing. Restore it before exporting." } }
        ZipOutputStream(output).use { zip ->
            zip.putNextEntry(ZipEntry("manifest.json")); zip.write(manifest); zip.closeEntry()
            rows.forEach { row ->
                zip.putNextEntry(ZipEntry("media/${row.id}"))
                val digest = java.security.MessageDigest.getInstance("SHA-256")
                java.security.DigestInputStream(files.file(row.id).inputStream(), digest).use { it.copyTo(zip, 64 * 1024) }
                require(digest.digest().joinToString("") { "%02x".format(it) } == row.checksum) { "An attachment is damaged. Backup was not completed." }
                zip.closeEntry()
            }
        }
    }
    private fun readManifest(input: InputStream): String {
        val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
        while (true) { val n = input.read(buffer); if (n < 0) break; require(output.size() + n <= Backup.MAX_BYTES) { "Backup metadata exceeds 25 MiB." }; output.write(buffer, 0, n) }
        return output.toString("UTF-8")
    }
    fun import(context: Context, repo: Repository, input: InputStream) {
        val buffered = input.buffered(); buffered.mark(4)
        val signature = ByteArray(4); val n = buffered.read(signature); buffered.reset()
        if (n < 2 || signature[0] != 0x50.toByte() || signature[1] != 0x4b.toByte()) { Backup.import(repo, readManifest(buffered)); return }
        val files = MediaFiles(context, repo)
        val staging = File(context.cacheDir, "media-import-${uid()}").apply { mkdirs() }
        val installed = mutableListOf<String>()
        try {
            ZipInputStream(buffered).use { zip ->
                require(zip.nextEntry?.name == "manifest.json") { "Choose a Museamo archive with manifest.json first." }
                val root = JSONObject(readManifest(zip))
                require(root.get("format") == "museamo" && root.get("version") in listOf(2, 3)) { "Unsupported backup version." }
                val array = root.getJSONArray("media")
                val rows = (0 until array.length()).map { parseMedia(array.getJSONObject(it)) }
                require(rows.map { it.id }.distinct().size == rows.size) { "Duplicate media IDs." }
                val expected = rows.associateBy { "media/${it.id}" }
                val seen = mutableSetOf<String>()
                while (true) {
                    val entry = zip.nextEntry ?: break
                    val row = expected[entry.name] ?: throw IllegalArgumentException("Unexpected or unsafe archive path.")
                    require(!entry.isDirectory && seen.add(entry.name)) { "Duplicate media file." }
                    require(row.byteSize + MediaFiles.RESERVE < staging.usableSpace) { "Not enough device storage to import this backup." }
                    val result = File(staging, row.id).outputStream().use { files.copyChecked(zip, it, row.byteSize) }
                    require(result.first == row.byteSize && result.second == row.checksum) { "An attachment is damaged or incomplete." }
                }
                require(seen == expected.keys) { "Backup is missing attachment files." }
                val entries = root.getJSONArray("entries")
                val referenced = (0 until entries.length()).flatMap { ids(Backup.entry(entries.getJSONObject(it)).mediaIds) }.toSet()
                require(referenced == rows.map { it.id }.toSet()) { "Backup has missing or unreferenced media." }
                val mapping = mutableMapOf<String, String>()
                val newRows = mutableListOf<MediaRow>()
                rows.forEach { row ->
                    val existing = repo.dao.media().find { it.copy(id = row.id) == row && files.intact(it) }
                    if (existing != null) mapping[row.id] = existing.id
                    else {
                        val target = if (repo.dao.media(row.id) == null && !files.file(row.id).exists()) row.id else uid()
                        require(File(staging, row.id).renameTo(files.file(target))) { "Could not store attachment. Free space and retry." }
                        installed.add(target); mapping[row.id] = target
                        newRows.add(row.copy(id = target))
                        // Preserve portable originals even if this device lacks their decoder.
                        runCatching { files.inspect(target, row.kind, row.mimeType, row.filename, row.byteSize, row.checksum) }
                    }
                }
                for (i in 0 until entries.length()) {
                    val entry = entries.getJSONObject(i)
                    entry.put("attachmentIds", JSONArray(ids(Backup.entry(entry).mediaIds).map { mapping.getValue(it) }))
                }
                repo.db.runInTransaction {
                    newRows.forEach { repo.dao.insertMedia(it) }
                    Backup.import(repo, root.toString(), withMedia = true)
                }
                installed.clear()
            }
        } finally {
            installed.forEach { files.file(it).delete(); files.thumbnail(it).delete() }
            staging.listFiles()?.forEach { it.delete() }; staging.delete()
        }
    }
    private fun string(o: JSONObject, key: String): String = (o.get(key) as? String) ?: throw IllegalArgumentException("$key must be text.")
    private fun integer(o: JSONObject, key: String, maximum: Long = Long.MAX_VALUE): Long {
        val value = o.get(key)
        require(value is Number && value.toDouble().isFinite() && value.toDouble() == value.toLong().toDouble() && value.toLong() in 0..maximum) { "Invalid $key." }
        return value.toLong()
    }
    private fun parseMedia(o: JSONObject): MediaRow {
        val id = string(o, "id"); require(UUID.fromString(id).toString() == id)
        val kind = string(o, "kind"); require(kind in setOf("image", "video"))
        val mime = string(o, "mimeType"); require(mime in if (kind == "image") MediaFiles.IMAGE_TYPES else MediaFiles.VIDEO_TYPES)
        val size = integer(o, "byteSize", MediaFiles.limit(kind)); require(size in 1..MediaFiles.limit(kind))
        val width = integer(o, "width", Int.MAX_VALUE.toLong()).toInt(); val height = integer(o, "height", Int.MAX_VALUE.toLong()).toInt(); require(width > 0 && height > 0)
        val duration = if (o.isNull("duration")) null else integer(o, "duration").also { require(it >= 0) }
        val name = string(o, "filename"); require(name.isNotBlank() && name.length <= 255)
        val checksum = string(o, "checksum"); require(Regex("[a-f0-9]{64}").matches(checksum))
        return MediaRow(id, kind, mime, name, size, width, height, duration, checksum)
    }
}
