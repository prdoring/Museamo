package com.prdoring.museamo

import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatDelegate
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Opt-in visual evidence against an isolated application id, never the user's library. */
@RunWith(AndroidJUnit4::class)
class PaperThemeTest {
    @Test fun capturePaperSurfaces() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        assumeTrue("Requires the isolated paperpreview build", context.packageName.endsWith(".paperpreview"))
        val output = File(context.filesDir, "paper-theme").apply { mkdirs() }
        val repo = Store.get(context)
        val tag = repo.dao.tags().find { it.name == "For later" } ?: repo.saveTag(null, "For later")
        repo.saveProfile(ProfileRow("paper-preview", "Words to remember", "picker", "[]", tag.id))
        repo.dao.putBinding(BindingRow(991, "paper-preview"))
        fun save(view: View, name: String, verifyFrame: Boolean = false) {
            check(view.width > 0 && view.height > 0)
            val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
            view.draw(Canvas(bitmap))
            if (verifyFrame) {
                // The launcher clips the surface; no contrasting frame may reach its corners.
                val inset = (5 * view.resources.displayMetrics.density).toInt()
                val ink = view.context.getColor(R.color.widget_text)
                for (x in listOf(inset, bitmap.width - inset - 1)) {
                    for (y in listOf(inset, bitmap.height - inset - 1)) {
                        check(bitmap.getPixel(x, y) != ink) { "Widget has a contrasting border: $name ($x,$y)" }
                    }
                }
            }
            File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        for ((mode, name) in listOf(AppCompatDelegate.MODE_NIGHT_NO to "light", AppCompatDelegate.MODE_NIGHT_YES to "dark")) {
            instrumentation.runOnMainSync { AppCompatDelegate.setDefaultNightMode(mode) }
            val capture = instrumentation.startActivitySync(Intent(context, CaptureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("profileId", "paper-preview"))
            instrumentation.waitForIdleSync()
            Thread.sleep(1200)
            instrumentation.runOnMainSync {
                fun seed(view: View) {
                    if (view is VisualThoughtInput) { view.setMarkdown("A **small** thought, _worth keeping_.\n\n- Notice the light\n- Write it down"); view.setSelection(view.length()) }
                    if (view is android.view.ViewGroup) for (i in 0 until view.childCount) seed(view.getChildAt(i))
                }
                seed(capture.window.decorView)
            }
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync { save(capture.window.decorView, "native-composer-$name"); capture.finish() }
            instrumentation.waitForIdleSync()
            val config = instrumentation.startActivitySync(Intent(context, WidgetConfigActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("profileId", "paper-preview"))
            instrumentation.waitForIdleSync()
            Thread.sleep(900)
            instrumentation.runOnMainSync { save(config.window.decorView, "native-settings-$name"); config.finish() }
            instrumentation.waitForIdleSync()
            val configuration = Configuration(context.resources.configuration).apply {
                uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or if (name == "dark") Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
            }
            val themed = context.createConfigurationContext(configuration)
            // RemoteViews uses the actual widget layout and rendering code.
            for (width in listOf(180, 320)) {
                val remote = CaptureWidget.viewsForWidth(themed, 991, width)
                instrumentation.runOnMainSync {
                val view = remote.apply(themed, FrameLayout(themed))
                val px = (width * themed.resources.displayMetrics.density).toInt()
                view.measure(View.MeasureSpec.makeMeasureSpec(px, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec((48 * themed.resources.displayMetrics.density).toInt(), View.MeasureSpec.EXACTLY))
                check(view.measuredHeight <= (48 * themed.resources.displayMetrics.density).toInt() + 1) { "Widget texture expanded the capture row" }
                view.layout(0, 0, px, view.measuredHeight)
                save(view, "widget-$width-$name", verifyFrame = true)
                }
            }
        }
        instrumentation.runOnMainSync { AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM) }
    }
}
