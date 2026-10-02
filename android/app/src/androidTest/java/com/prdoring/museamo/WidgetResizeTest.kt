package com.prdoring.museamo

import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Builds real RemoteViews without changing the user's profiles, drafts, or widget bindings. */
@RunWith(AndroidJUnit4::class)
class WidgetResizeTest {
    @Test fun compactRowsAndCardsKeepActionsInsideBounds() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val base = instrumentation.targetContext
        for (fontScale in listOf(1f, 2f)) for (mode in listOf("fixed", "picker")) for (checklist in listOf(false, true)) for (shared in listOf(false, true)) {
            val context = base.createConfigurationContext(Configuration(base.resources.configuration).apply { this.fontScale = fontScale })
            for ((width, height) in listOf(40 to 40, 80 to 40, 40 to 80, 80 to 80, 140 to 40, 180 to 60, 220 to 60, 259 to 60, 260 to 40, 100 to 120, 260 to 120, 100 to 180, 320 to 280, 600 to 400)) {
                val compact = width < 260 && !(width >= 100 && height >= 120)
                val profile = ProfileRow("resize-test", "Words and thoughts to remember for later", mode, "[]", null)
                val remote = CaptureWidget.buildViews(context, -991, width, height, profile, true, "A very long tag name", checklist, shared)
                instrumentation.runOnMainSync {
                    val view = remote.apply(context, FrameLayout(context))
                    val density = context.resources.displayMetrics.density
                    val w = (width * density).toInt()
                    val h = (height * density).toInt()
                    view.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
                    view.layout(0, 0, w, h)
                    fun action(id: Int) {
                        val child = view.findViewById<View>(id)
                        assertEquals(View.VISIBLE, child.visibility)
                        assertTrue(child.hasOnClickListeners())
                        assertTrue("Empty action at $width x $height", child.width > 0 && child.height > 0)
                        val bounds = android.graphics.Rect(0, 0, child.width, child.height)
                        (view as android.view.ViewGroup).offsetDescendantRectToMyCoords(child, bounds)
                        assertTrue("Action outside $width x $height: $bounds", bounds.left >= 0 && bounds.top >= 0 && bounds.right <= w && bounds.bottom <= h)
                    }
                    if (compact) {
                        assertTrue(view.findViewById<View>(R.id.widget_capture) is android.widget.ImageButton)
                        assertNull(view.findViewById<View>(R.id.widget_label))
                        assertNull(view.findViewById<View>(R.id.widget_picker))
                    }
                    assertEquals(if (shared) View.VISIBLE else View.GONE, view.findViewById<View>(R.id.widget_shared).visibility)
                    assertEquals(shared, view.findViewById<View>(R.id.widget_capture).contentDescription.contains("Shared"))
                    action(R.id.widget_capture)
                    if (!compact) assertEquals("Continue draft", view.findViewById<TextView>(R.id.widget_label).text.toString())
                    action(R.id.widget_open_app)
                    if (!compact) assertEquals(if (mode == "picker" && !compact) View.VISIBLE else View.GONE, view.findViewById<View>(R.id.widget_picker).visibility)
                    if (mode == "picker" && !compact) action(R.id.widget_picker)
                    if (mode == "picker" && !compact) {
                        val marker = view.findViewById<View>(R.id.widget_picker_type)
                        assertEquals(if (checklist) View.VISIBLE else View.GONE, marker.visibility)
                        assertEquals(checklist, view.findViewById<View>(R.id.widget_picker).contentDescription.contains("Checklist"))
                        if (checklist) {
                            val bounds = android.graphics.Rect(0, 0, marker.width, marker.height)
                            (view as android.view.ViewGroup).offsetDescendantRectToMyCoords(marker, bounds)
                            assertTrue("Checklist indicator outside $width x $height: $bounds", bounds.left >= 0 && bounds.top >= 0 && bounds.right <= w && bounds.bottom <= h)
                            if (width < 260) assertEquals(View.GONE, view.findViewById<View>(R.id.widget_picker_text).visibility)
                        }
                    }
                    if (fontScale == 1f && mode == "picker") {
                        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                        view.draw(Canvas(bitmap))
                        val dir = File(base.cacheDir, "widget-resize").apply { mkdirs() }
                        File(dir, "$width-$height${if (checklist) "-checklist" else ""}.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                        bitmap.recycle()
                    }
                }
            }
        }
    }
}
