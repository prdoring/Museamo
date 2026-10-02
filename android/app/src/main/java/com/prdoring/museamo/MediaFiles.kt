package com.prdoring.museamo

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.UUID

/** All mutations run on Store.executor. Originals never cross the JS bridge. */
class MediaFiles(private val context: Context, private val repo: Repository) {
    val directory = File(context.filesDir, "media").apply { mkdirs() }
    fun file(id: String): File { require(UUID.fromString(id).toString() == id); return File(directory, id) }
    fun thumbnail(id: String): File = File(directory, "${file(id).name}.jpg")
    fun recoverInterruptedImports() {
        context.cacheDir.listFiles()?.filter { it.isDirectory && it.name.startsWith("media-import-") && runCatching { UUID.fromString(it.name.removePrefix("media-import-")) }.isSuccess }?.forEach { stage ->
            stage.listFiles()?.filter { it.isFile }?.forEach { it.delete() }; stage.delete()
        }
    }
    fun intact(row: MediaRow): Boolean {
        val original = file(row.id)
        if (!original.isFile || original.length() != row.byteSize) return false
        val digest = MessageDigest.getInstance("SHA-256")
        java.security.DigestInputStream(original.inputStream(), digest).use { input -> val buffer = ByteArray(64 * 1024); while (input.read(buffer) >= 0) {} }
        return digest.digest().joinToString("") { "%02x".format(it) } == row.checksum
    }
    fun cleanup() {
        PurgeStorage.finish(repo)
        val keep = repo.references()
        repo.dao.media().filter { it.id !in keep }.forEach { row ->
            file(row.id).delete(); thumbnail(row.id).delete(); repo.dao.deleteMedia(row.id)
        }
        val registered = repo.dao.media().flatMap { listOf(it.id, "${it.id}.jpg") }.toSet()
        directory.listFiles()?.filter { it.name !in registered }?.forEach { it.delete() }
        File(context.filesDir, "sync-media").listFiles()?.filter { it.isFile && it.name.endsWith(".part") && it.name.removeSuffix(".part") !in keep }?.forEach { it.delete() }
    }
    fun import(uris: List<Uri>, remaining: Int): List<MediaRow> {
        require(remaining in 1..10 && uris.size <= remaining) { "Choose up to $remaining more attachments." }
        val imported = mutableListOf<MediaRow>()
        try {
            uris.forEach { uri ->
                require(uri.scheme == "content") { "Choose media using the system picker." }
                val mime = context.contentResolver.getType(uri)?.lowercase() ?: ""
                val kind = when {
                    mime in IMAGE_TYPES -> "image"
                    mime in VIDEO_TYPES -> "video"
                    else -> throw IllegalArgumentException("Unsupported file. Choose a JPEG, PNG, GIF, WebP, HEIF/AVIF image or MP4, WebM, MOV video.")
                }
                val limit = limit(kind)
                var name = if (kind == "image") "Photo" else "Video"
                context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val n = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (n >= 0 && !cursor.isNull(n)) name = cursor.getString(n).take(255)
                        val s = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (s >= 0 && !cursor.isNull(s)) {
                            val size = cursor.getLong(s)
                            require(size <= limit) { sizeMessage(kind) }
                            require(size + RESERVE < directory.usableSpace) { "Not enough device storage. Free some space and try again." }
                        }
                    }
                }
                val id = uid(); val target = file(id)
                try {
                    val result = requireNotNull(context.contentResolver.openInputStream(uri)) { "Cannot read this file. Select it again." }.use { input ->
                        java.io.FileOutputStream(target).use { output -> copyChecked(input, output, limit).also { output.fd.sync() } }
                    }
                    val row = try { inspect(id, kind, mime, name, result.first, result.second) }
                        catch (error: Exception) {
                            // Modern image/video codecs vary by Android version and device. Keep
                            // their originals; a broken baseline JPEG/PNG/GIF/WebP still rejects
                            // the whole picker import before any saved thought is published.
                            if (kind == "image" && mime !in setOf("image/heic", "image/heif", "image/avif")) throw error
                            MediaRow(id, kind, mime, name, result.first, 1, 1, null, result.second)
                        }
                    repo.dao.insertMedia(row); repo.mediaPins.add(id); imported.add(row)
                } catch (e: Exception) { target.delete(); thumbnail(id).delete(); throw e }
            }
            return imported
        } catch (e: Exception) {
            imported.forEach { repo.mediaPins.remove(it.id); file(it.id).delete(); thumbnail(it.id).delete(); repo.dao.deleteMedia(it.id) }
            throw e
        }
    }
    fun inspect(id: String, kind: String, mime: String, name: String, size: Long, checksum: String): MediaRow {
        val target = file(id)
        var width: Int; var height: Int; var duration: Long? = null
        var bitmap: Bitmap? = null
        if (kind == "image") {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(target.path, bounds)
            width = bounds.outWidth; height = bounds.outHeight
            require(width > 0 && height > 0) { "This image format cannot be displayed on this device." }
            var sample = 1
            while (maxOf(width, height) / sample > 1024) sample *= 2
            bitmap = BitmapFactory.decodeFile(target.path, BitmapFactory.Options().apply { inSampleSize = sample })
        } else {
            val retriever = MediaMetadataRetriever()
            try {
                retriever.setDataSource(target.path)
                width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
                height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
                duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
                require(width > 0 && height > 0 && duration != null) { "This video format cannot be played on this device." }
                bitmap = if (android.os.Build.VERSION.SDK_INT >= 27) retriever.getScaledFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 512, (512L * height / width).coerceIn(1, 1024).toInt()) else retriever.getFrameAtTime(0)?.let { frame ->
                    val scaled = Bitmap.createScaledBitmap(frame, 512, (512L * frame.height / frame.width).coerceIn(1, 1024).toInt(), true)
                    if (scaled !== frame) frame.recycle(); scaled
                }
            } finally { retriever.release() }
        }
        if (kind == "image") {
            val exif = runCatching { android.media.ExifInterface(target.path).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1) }.getOrDefault(1)
            val matrix = android.graphics.Matrix()
            when (exif) {
                2 -> matrix.setScale(-1f, 1f)
                3 -> matrix.setRotate(180f)
                4 -> matrix.setScale(1f, -1f)
                5 -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
                6 -> matrix.setRotate(90f)
                7 -> { matrix.setRotate(-90f); matrix.postScale(-1f, 1f) }
                8 -> matrix.setRotate(-90f)
            }
            if (exif in 5..8) { val oldWidth = width; width = height; height = oldWidth }
            if (!matrix.isIdentity) bitmap?.let { original ->
                bitmap = Bitmap.createBitmap(original, 0, 0, original.width, original.height, matrix, true)
                if (bitmap !== original) original.recycle()
            }
        }
        bitmap?.let { image -> try { thumbnail(id).outputStream().use { image.compress(Bitmap.CompressFormat.JPEG, 85, it) } } finally { image.recycle() } }
        return MediaRow(id, kind, mime, name, size, width, height, duration, checksum)
    }
    fun copyChecked(input: InputStream, output: OutputStream, max: Long): Pair<Long, String> {
        val digest = MessageDigest.getInstance("SHA-256"); val buffer = ByteArray(64 * 1024); var total = 0L
        while (true) {
            val count = input.read(buffer); if (count < 0) break
            total += count
            require(total <= max) { "Media exceeds the size limit (50 MiB per image, 500 MiB per video)." }
            require(directory.usableSpace > RESERVE + count) { "Not enough device storage. Free some space and try again." }
            output.write(buffer, 0, count); digest.update(buffer, 0, count)
        }
        require(total > 0) { "The selected file is empty." }
        return total to digest.digest().joinToString("") { "%02x".format(it) }
    }
    companion object {
        const val RESERVE = 16L * 1024 * 1024
        val IMAGE_TYPES = setOf("image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "image/avif")
        val VIDEO_TYPES = setOf("video/mp4", "video/webm", "video/quicktime", "video/x-m4v", "video/ogg")
        fun limit(kind: String) = (if (kind == "image") 50L else 500L) * 1024 * 1024
        fun sizeMessage(kind: String) = if (kind == "image") "Choose an image up to 50 MiB." else "Choose a video up to 500 MiB."
    }
}
