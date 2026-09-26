package com.prdoring.museamo

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeWebViewClient
import java.io.ByteArrayInputStream
import java.io.FilterInputStream

object MediaRange {
    fun parse(header: String?, size: Long): LongRange? {
        if (header == null) return null
        require(size > 0)
        val match = Regex("bytes=(\\d*)-(\\d*)").matchEntire(header) ?: throw IllegalArgumentException("Invalid range")
        val (first, last) = match.destructured
        require(first.isNotEmpty() || last.isNotEmpty())
        val start = if (first.isEmpty()) (size - last.toLong().also { require(it > 0) }).coerceAtLeast(0) else first.toLong()
        val end = if (last.isEmpty() || first.isEmpty()) size - 1 else last.toLong().coerceAtMost(size - 1)
        require(start in 0 until size && end >= start)
        return start..end
    }
}

class MediaWebViewClient(private val mediaBridge: Bridge) : BridgeWebViewClient(mediaBridge) {
    private fun empty(status: Int, reason: String, headers: Map<String, String> = emptyMap()) =
        WebResourceResponse("text/plain", "UTF-8", status, reason, headers, ByteArrayInputStream(ByteArray(0)))
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        if (uri.host != "com.prdoring.museamo" && uri.host != "localhost") return super.shouldInterceptRequest(view, request)
        // Never expose Capacitor's arbitrary filesystem/content routes.
        if (uri.path?.startsWith("/_capacitor_file_") == true || uri.path?.startsWith("/_capacitor_content_") == true) return empty(403, "Forbidden")
        if (uri.path?.startsWith("/_media/") != true) return super.shouldInterceptRequest(view, request)
        if (request.method != "GET" && request.method != "HEAD") return empty(405, "Method Not Allowed")
        return try {
            val parts = uri.pathSegments
            require(parts.size == 2 || (parts.size == 3 && parts[2] == "thumbnail"))
            val repo = Store.get(view.context)
            val row = repo.dao.media(parts[1]) ?: return empty(404, "Not Found")
            val files = MediaFiles(view.context, repo)
            val thumb = parts.size == 3
            val file = if (thumb) files.thumbnail(row.id) else files.file(row.id)
            if (!file.isFile) return empty(404, "Not Found")
            val size = file.length()
            val range = try { MediaRange.parse(request.requestHeaders.entries.find { it.key.equals("Range", true) }?.value, size) }
                catch (_: Exception) { return empty(416, "Range Not Satisfiable", mapOf("Content-Range" to "bytes */$size")) }
            val start = range?.first ?: 0L; val end = range?.last ?: size - 1
            val length = end - start + 1
            val headers = mutableMapOf("Accept-Ranges" to "bytes", "Content-Length" to "$length", "Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff")
            if (range != null) headers["Content-Range"] = "bytes $start-$end/$size"
            val stream = if (request.method == "HEAD") ByteArrayInputStream(ByteArray(0)) else file.inputStream().let { input ->
                input.channel.position(start)
                object : FilterInputStream(input) {
                    var remaining = length
                    override fun read(): Int { if (remaining <= 0) return -1; val n = super.read(); if (n >= 0) remaining--; return n }
                    override fun read(b: ByteArray, off: Int, len: Int): Int { if (remaining <= 0) return -1; val n = `in`.read(b, off, minOf(len.toLong(), remaining).toInt()); if (n > 0) remaining -= n; return n }
                }
            }
            WebResourceResponse(if (thumb) "image/jpeg" else row.mimeType, null, if (range == null) 200 else 206, if (range == null) "OK" else "Partial Content", headers, stream)
        } catch (_: Exception) { empty(404, "Not Found") }
    }
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (!request.isForMainFrame && request.url.scheme == "https" && request.url.host in setOf("www.youtube.com", "player.vimeo.com")) return false
        return super.shouldOverrideUrlLoading(view, request)
    }
}
