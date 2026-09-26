package com.prdoring.museamo

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class NativeBridgeTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private fun <T> repository(block: (Repository) -> T): T = Store.executor.submit(Callable { block(Store.get(context)) }).get(10, TimeUnit.SECONDS)
    private fun js(scenario: ActivityScenario<MainActivity>, script: String): String {
        val latch = CountDownLatch(1); var result = ""
        scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { value -> result = value; latch.countDown() } }
        assertTrue("WebView callback timed out", latch.await(5, TimeUnit.SECONDS)); return result
    }
    private fun until(scenario: ActivityScenario<MainActivity>, script: String, expected: String) {
        val deadline = System.currentTimeMillis() + 15000
        var result: String
        do { result = js(scenario, script); if (result.contains(expected)) return; Thread.sleep(100) } while (System.currentTimeMillis() < deadline)
        fail("WebView did not reach $expected; last result: $result")
    }
    @Test fun reactLoadsOfflineAndBridgeMutationsRefreshTheStream() {
        val text = "A thought doesn't have to become something to be worth keeping."
        repository { repo -> repo.commitDraft(repo.draft("bridge-test", null, null).copy(text = text)) }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            until(scenario, "document.body.innerText", "MUSEAMO")
            until(scenario, "document.body.innerText", "worth keeping")
            assertFalse(js(scenario, "document.body.innerText").contains("Preview ·"))
            js(scenario, "window.Capacitor.nativePromise('Museamo','library',{}).then(r=>window.__bridgeResult=JSON.stringify(r)).catch(e=>window.__bridgeResult='ERROR:'+e.message); 'started'")
            until(scenario, "window.__bridgeResult", "profiles")
            val name = "Bridge ${uid()}"
            js(scenario, "window.Capacitor.nativePromise('Museamo','saveTag',{name:'$name'}).then(()=>window.__saved=true).catch(e=>window.__saved=e.message); 'started'")
            until(scenario, "window.__saved", "true")
            assertTrue(repository { it.dao.tags().any { t -> t.name == name } })
            InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bitmap ->
                File(context.getExternalFilesDir(null), "stream.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            }
        }
    }
    @Test fun widgetRemoteViewsRenderFixedAndPickerModes() {
        val profile = repository { repo ->
            val tag = repo.saveTag(null, "Widget ${uid()}")
            ProfileRow(uid(), "Cool words", "picker", selectedTagId = tag.id).also { repo.saveProfile(it); repo.dao.putBinding(BindingRow(99991, it.id)) }
        }
        val remote = Store.executor.submit(Callable { CaptureWidget.views(context, 99991) }).get(5, TimeUnit.SECONDS)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val view = remote.apply(context, null)
            assertEquals("Cool words", view.findViewById<TextView>(R.id.widget_label).text.toString())
            assertEquals(View.VISIBLE, view.findViewById<View>(R.id.widget_picker).visibility)
            val openApp = view.findViewById<View>(R.id.widget_open_app)
            assertEquals("Open Museamo", openApp.contentDescription.toString())
            assertTrue(openApp.hasOnClickListeners())
            view.measure(View.MeasureSpec.makeMeasureSpec(750, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(150, View.MeasureSpec.EXACTLY)); view.layout(0, 0, 750, 150)
            val bitmap = Bitmap.createBitmap(750, 150, Bitmap.Config.ARGB_8888); view.draw(Canvas(bitmap))
            File(context.getExternalFilesDir(null), "widget.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        repository { it.saveProfile(profile.copy(mode = "fixed")) }
        val fixed = Store.executor.submit(Callable { CaptureWidget.views(context, 99991) }).get(5, TimeUnit.SECONDS)
        InstrumentationRegistry.getInstrumentation().runOnMainSync { assertEquals(View.GONE, fixed.apply(context, null).findViewById<View>(R.id.widget_picker).visibility) }
        repository { it.dao.deleteBinding(99991) }
    }
    @Test fun widgetSetupIsNotAFloatingLauncherOverlay() {
        val info = context.packageManager.getActivityInfo(android.content.ComponentName(context, WidgetConfigActivity::class.java), 0)
        assertEquals(android.content.pm.ActivityInfo.LAUNCH_MULTIPLE, info.launchMode)
        val theme = context.resources.newTheme().apply { applyStyle(info.theme, true) }
        val value = android.util.TypedValue()
        assertTrue(theme.resolveAttribute(android.R.attr.windowIsFloating, value, true))
        assertEquals(0, value.data)
    }
}
