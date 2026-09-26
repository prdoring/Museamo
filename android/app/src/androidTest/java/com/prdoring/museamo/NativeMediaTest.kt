package com.prdoring.museamo

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import androidx.core.content.FileProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class NativeMediaTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private fun <T> repository(block: (Repository) -> T): T = Store.executor.submit(Callable { block(Store.get(context)) }).get(30, TimeUnit.SECONDS)
    private fun js(scenario: ActivityScenario<MainActivity>, script: String): String {
        val latch = CountDownLatch(1); var result = ""
        scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { value -> result = value; latch.countDown() } }
        assertTrue(latch.await(5, TimeUnit.SECONDS)); return result
    }
    private fun until(scenario: ActivityScenario<MainActivity>, script: String, expected: String) {
        val deadline = System.currentTimeMillis() + 20000
        var result: String
        do { result = js(scenario, script); if (result.contains(expected)) return; Thread.sleep(100) } while (System.currentTimeMillis() < deadline)
        fail("Expected $expected; got $result")
    }
    /** Small deterministic video, generated locally so tests do not need a download. */
    private fun video(file: File) {
        val codec = MediaCodec.createEncoderByType("video/avc")
        val format = MediaFormat.createVideoFormat("video/avc", 64, 64).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
            setInteger(MediaFormat.KEY_BIT_RATE, 64000); setInteger(MediaFormat.KEY_FRAME_RATE, 15); setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }
        val muxer = MediaMuxer(file.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var started = false
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE); codec.start()
            var frame = 0; var ended = false; var track = -1
            val info = MediaCodec.BufferInfo(); val deadline = System.currentTimeMillis() + 15000
            while (!ended && System.currentTimeMillis() < deadline) {
                if (frame <= 30) {
                    val input = codec.dequeueInputBuffer(1000)
                    if (input >= 0) {
                        val buffer = codec.getInputBuffer(input)!!; buffer.clear()
                        if (frame < 30) { buffer.put(ByteArray(64 * 64 * 3 / 2) { 120 }); codec.queueInputBuffer(input, 0, 64 * 64 * 3 / 2, frame * 1000000L / 15, 0) }
                        else codec.queueInputBuffer(input, 0, 0, frame * 1000000L / 15, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        frame++
                    }
                }
                val output = codec.dequeueOutputBuffer(info, 1000)
                if (output == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { track = muxer.addTrack(codec.outputFormat); muxer.start(); started = true }
                else if (output >= 0) {
                    val buffer = codec.getOutputBuffer(output)!!
                    if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                        buffer.position(info.offset); buffer.limit(info.offset + info.size); muxer.writeSampleData(track, buffer, info)
                    }
                    ended = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                    codec.releaseOutputBuffer(output, false)
                }
            }
            assertTrue("Video encoding timed out", ended)
        } finally { codec.stop(); codec.release(); if (started) muxer.stop(); muxer.release() }
    }
    @Test fun photoViewerSupportsTouchGesturesAndFitsTheWebView() {
        val file = File(context.cacheDir, "gesture-photo.png")
        Bitmap.createBitmap(600, 800, Bitmap.Config.ARGB_8888).also { bitmap ->
            val canvas = android.graphics.Canvas(bitmap)
            canvas.drawColor(0xFF287B91.toInt())
            val paint = android.graphics.Paint().apply { color = 0xFFF3B562.toInt() }
            canvas.drawCircle(400f, 220f, 110f, paint)
            paint.color = 0xFF164653.toInt(); canvas.drawRect(0f, 540f, 600f, 800f, paint)
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
        val entry = repository { repo ->
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
            val rows = MediaFiles(context, repo).import(listOf(uri, uri), 10)
            repo.commitDraft(repo.draft("gesture-viewer", null, null).copy(text = "Gesture viewer test", mediaIds = jsonIds(rows.map { it.id }))).also { rows.forEach { row -> repo.mediaPins.remove(row.id) } }
        }
        try {
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                until(scenario, "document.body.innerText", "Gesture viewer test")
                until(scenario, "document.querySelector('.media-photo') !== null", "true")
                js(scenario, "document.querySelector('.media-photo').click()")
                until(scenario, "document.querySelector('.photo-stage img')?.naturalWidth", "600")
                assertEquals("true", js(scenario, "(()=>{const r=document.querySelector('.photo-lightbox').getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight+1 && document.querySelector('.photo-lightbox').querySelectorAll('button').length===1})()"))
                fun touch(action: Int, points: List<Pair<Float, Float>>) {
                    scenario.onActivity { activity ->
                        val web = activity.bridge.webView
                        val properties = points.mapIndexed { i, _ -> android.view.MotionEvent.PointerProperties().apply { id = i; toolType = android.view.MotionEvent.TOOL_TYPE_FINGER } }.toTypedArray()
                        val coords = points.map { (x, y) -> android.view.MotionEvent.PointerCoords().apply { this.x = web.width * x; this.y = web.height * y; pressure = 1f; size = 1f } }.toTypedArray()
                        val now = android.os.SystemClock.uptimeMillis()
                        val event = android.view.MotionEvent.obtain(now, now, action, points.size, properties, coords, 0, 0, 1f, 1f, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, 0)
                        web.dispatchTouchEvent(event); event.recycle()
                    }
                    Thread.sleep(30)
                }
                touch(0, listOf(.8f to .5f)); touch(2, listOf(.2f to .5f)); touch(1, listOf(.2f to .5f))
                until(scenario, "document.querySelector('.photo-lightbox-header').innerText", "2 / 2")
                until(scenario, "document.querySelector('.photo-stage img')?.naturalWidth", "600")
                touch(0, listOf(.4f to .5f)); touch(5 or (1 shl 8), listOf(.4f to .5f, .6f to .5f))
                touch(2, listOf(.2f to .5f, .8f to .5f)); touch(6 or (1 shl 8), listOf(.2f to .5f, .8f to .5f)); touch(1, listOf(.2f to .5f))
                assertEquals("true", js(scenario, "new DOMMatrix(getComputedStyle(document.querySelector('.photo-stage img')).transform).a > 2"))
                repeat(2) { touch(0, listOf(.5f to .5f)); touch(1, listOf(.5f to .5f)) }
                until(scenario, "new DOMMatrix(getComputedStyle(document.querySelector('.photo-stage img')).transform).a", "1")
                androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bitmap ->
                    File(context.getExternalFilesDir(null), "photo-viewer.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                }
                assertEquals("false", js(scenario, "window.dispatchEvent(new Event('museamoBack',{cancelable:true}))"))
                until(scenario, "document.querySelector('.photo-lightbox') === null", "true")
            }
        } finally { file.delete(); repository { repo -> repo.dao.deleteEntry(entry.id); MediaFiles(context, repo).cleanup() } }
    }
    @Test fun originalsSurviveSourceRemovalAndPlayInsideTheWebView() {
        val image = File(context.cacheDir, "media-test-${uid()}.png")
        val clip = File(context.cacheDir, "media-test-${uid()}.mp4")
        Bitmap.createBitmap(32, 24, Bitmap.Config.ARGB_8888).also { bitmap -> image.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
        video(clip)
        val invalid = File(context.cacheDir, "invalid-${uid()}.png").apply { writeText("not an image") }
        try {
            repository { repo ->
                val before = repo.dao.media().map { it.id }.toSet()
                val uris = listOf(image, invalid).map { FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", it) }
                assertTrue(runCatching { MediaFiles(context, repo).import(uris, 10) }.isFailure)
                assertEquals(before, repo.dao.media().map { it.id }.toSet())
            }
        } finally { invalid.delete() }
        val (entry, rows) = repository { repo ->
            val uris = listOf(image, clip).map { FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", it) }
            val rows = MediaFiles(context, repo).import(uris, 10)
            val entry = repo.commitDraft(repo.draft("media-webview", null, null).copy(text = "Native media playback", mediaIds = jsonIds(rows.map { it.id })))
            rows.forEach { repo.mediaPins.remove(it.id) }
            entry to rows
        }
        image.delete(); clip.delete()
        try {
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                until(scenario, "document.body.innerText", "Native media playback")
                js(scenario, "document.querySelector('.media-video').scrollIntoView(); 'scrolled'")
                until(scenario, "document.querySelector('video')?.readyState", "4")
                assertEquals("true", js(scenario, "document.querySelector('video').paused && !document.querySelector('video').autoplay && document.querySelector('video').controls"))
                js(scenario, "const v=document.querySelector('video'); v.currentTime=1; v.addEventListener('seeked',()=>window.__seeked=true,{once:true}); 'seeking'")
                until(scenario, "window.__seeked", "true")
                js(scenario, "document.querySelector('video').play().then(()=>window.__played=true).catch(e=>window.__played=e.message); 'play requested'")
                until(scenario, "window.__played", "true")
                until(scenario, "document.querySelector('video').currentTime > 1.1", "true")
                js(scenario, "document.querySelector('video').pause(); 'paused'")
                js(scenario, "window.Capacitor.nativePromise('Museamo','resolveMedia',{id:'${rows[0].id}'}).then(r=>fetch(r.url,{headers:{Range:'bytes=1-3'}})).then(async r=>window.__range=r.status+':'+(await r.arrayBuffer()).byteLength); 'reading'")
                until(scenario, "window.__range", "206:3")
                js(scenario, "fetch('https://com.prdoring.museamo/_media/00000000-0000-0000-0000-000000000000').then(r=>window.__missing=r.status); 'reading'")
                until(scenario, "window.__missing", "404")
                js(scenario, "fetch('https://com.prdoring.museamo/_capacitor_file_/data/data/com.prdoring.museamo/files/museamo.db').then(r=>window.__blocked=r.status); 'reading'")
                until(scenario, "window.__blocked", "403")
            }
        } finally { repository { repo -> repo.dao.deleteEntry(entry.id); MediaFiles(context, repo).cleanup() } }
    }
}
