package com.prdoring.museamo

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.ComponentName
import android.content.res.Configuration
import android.os.Build
import android.view.Surface
import android.widget.Button
import android.widget.LinearLayout
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.Callable
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class PortraitMotionTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    @get:Rule val location = ManualLocationRule()
    private fun <T> repository(block: (Repository) -> T): T = Store.executor.submit(Callable { block(Store.get(context)) }).get(10, TimeUnit.SECONDS)
    private fun <T : Activity> portrait(intent: Intent, verify: (T) -> Unit = {}) {
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        // The entrypoint must also handle a landscape launcher.
        assertTrue(automation.setRotation(Surface.ROTATION_90))
        ActivityScenario.launch<T>(intent).use { scenario ->
            try {
                for (rotation in listOf(Surface.ROTATION_90, Surface.ROTATION_270, Surface.ROTATION_180)) {
                    assertTrue(automation.setRotation(rotation))
                    InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                    // WindowManager can deliver the configuration after the main queue first becomes idle.
                    val deadline = android.os.SystemClock.uptimeMillis() + 3000
                    var orientation = Configuration.ORIENTATION_UNDEFINED
                    do {
                        scenario.onActivity { orientation = it.resources.configuration.orientation }
                        if (orientation != Configuration.ORIENTATION_PORTRAIT) {
                            Thread.sleep(25); InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                        }
                    } while (orientation != Configuration.ORIENTATION_PORTRAIT && android.os.SystemClock.uptimeMillis() < deadline)
                    scenario.onActivity {
                        assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, it.requestedOrientation)
                        assertEquals(Configuration.ORIENTATION_PORTRAIT, it.resources.configuration.orientation)
                        verify(it)
                    }
                    if (rotation == Surface.ROTATION_90) automation.takeScreenshot()?.let { bitmap ->
                        java.io.File(context.getExternalFilesDir(null), "portrait-${intent.component!!.shortClassName}.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                        bitmap.recycle()
                    }
                }
            } finally { automation.setRotation(android.app.UiAutomation.ROTATION_UNFREEZE) }
        }
    }
    @Test fun allOwnedActivitiesDeclareUprightPortrait() {
        listOf(MainActivity::class.java, CaptureActivity::class.java, TagPickerActivity::class.java, WidgetConfigActivity::class.java).forEach {
            assertEquals(it.simpleName, ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, context.packageManager.getActivityInfo(ComponentName(context, it), 0).screenOrientation)
        }
    }
    @Test fun mainAppDoesNotRotate() = portrait<MainActivity>(Intent(context, MainActivity::class.java))
    @Test fun widgetCaptureAndTagPickerDoNotRotateOrLoseDrafts() {
        val profile = repository { repo -> ProfileRow(uid(), "Portrait capture", "picker").also { repo.saveProfile(it) } }
        val text = "Portrait draft ${uid()}"
        repository { repo -> repo.saveDraft(repo.draft(profile.id, profile, null).copy(text = text)) }
        portrait<CaptureActivity>(Intent(context, CaptureActivity::class.java).putExtra("profileId", profile.id)) {
            if (Build.VERSION.SDK_INT == 26) {
                val attributes = it.obtainStyledAttributes(intArrayOf(android.R.attr.windowIsFloating, android.R.attr.windowIsTranslucent))
                try { assertFalse(attributes.getBoolean(0, true)); assertFalse(attributes.getBoolean(1, true)) } finally { attributes.recycle() }
            }
        }
        assertEquals(text, repository { it.dao.draft(profile.id)!!.text })
        portrait<TagPickerActivity>(Intent(context, TagPickerActivity::class.java).putExtra("profileId", profile.id))
    }
    @Test fun widgetConfigurationStaysPortrait() {
        val profile = repository { repo -> ProfileRow(uid(), "Portrait setup", "picker").also { repo.saveProfile(it) } }
        portrait<WidgetConfigActivity>(Intent(context, WidgetConfigActivity::class.java).putExtra("profileId", profile.id))
    }
    @Test fun unchangedNativeKeysPreserveViewsAndRefreshTheirActions() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val group = LinearLayout(context)
            var click = ""
            fun render(keys: List<String>, version: String) = NativeMotion.reconcile(group, keys, { Button(context) }, { view, key ->
                (view as Button).text = "$key:$version"; view.setOnClickListener { click = version }
            })
            render(listOf("a", "b"), "first")
            val original = group.getChildAt(0)
            render(listOf("a", "b"), "updated")
            assertSame(original, group.getChildAt(0)); original.performClick(); assertEquals("updated", click)
            render(listOf("b", "a", "c"), "reordered")
            assertSame(original, group.getChildAt(1)); assertEquals(3, group.childCount)
            render(listOf("a"), "removed"); assertSame(original, group.getChildAt(0)); assertEquals(1, group.childCount)
        }
    }
}
