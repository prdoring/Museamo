package com.prdoring.museamo

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.*
import androidx.test.espresso.matcher.ViewMatchers.*
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.TimeUnit

class MediaCaptureTest {
    @get:Rule val location = ManualLocationRule()
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private fun <T> repository(block: (Repository) -> T): T = Store.executor.submit(Callable { block(Store.get(context)) }).get(20, TimeUnit.SECONDS)
    private fun settle() { repository { }; InstrumentationRegistry.getInstrumentation().waitForIdleSync() }
    @Test fun pickerResultPersistsAcrossRecreationAndSendsWithoutText() {
        val file = File(context.cacheDir, "picked-${uid()}.png")
        Bitmap.createBitmap(20, 30, Bitmap.Config.ARGB_8888).also { bitmap -> file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val pickerIntent = ActivityResultContracts.PickMultipleVisualMedia(10).createIntent(context, PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
        val profile = repository { repo ->
            val tag = repo.saveTag(null, "Photo checklist ${uid()}", "checklist")
            ProfileRow(uid(), "Media widget", "fixed", jsonIds(listOf(tag.id))).also { repo.saveProfile(it) }
        }
        var entryId: String? = null
        try {
            ActivityScenario.launch<CaptureActivity>(Intent(context, CaptureActivity::class.java).putExtra("profileId", profile.id)).use { scenario ->
                settle(); settle(); settle()
                androidx.test.espresso.Espresso.closeSoftKeyboard()
                onView(withContentDescription("Attach photos/videos")).check(androidx.test.espresso.assertion.ViewAssertions.matches(isEnabled()))
                val monitor = instrumentation.addMonitor(IntentFilter(pickerIntent.action), Instrumentation.ActivityResult(Activity.RESULT_OK, Intent().setData(uri)), true)
                try { onView(withContentDescription("Attach photos/videos")).perform(click()) }
                finally { instrumentation.removeMonitor(monitor) }
                assertEquals("The attachment action must open the picker", 1, monitor.hits)
                settle()
                val deadline = System.currentTimeMillis() + 10000
                var draft = repository { it.dao.draft(profile.id)!! }
                while (ids(draft.mediaIds).isEmpty() && System.currentTimeMillis() < deadline) {
                    settle(); Thread.sleep(50)
                    draft = repository { it.dao.draft(profile.id)!! }
                }
                var importError = ""
                scenario.onActivity { importError = it.error.text.toString() }
                assertEquals("Import should finish: $importError", 1, ids(draft.mediaIds).size)
                assertEquals("", draft.text)
                entryId = draft.entryId
                file.delete()
                scenario.recreate(); settle(); settle()
                scenario.onActivity { activity ->
                    fun find(view: android.view.View, description: String): android.view.View? {
                        if (view.contentDescription == description) return view
                        if (view is android.view.ViewGroup) for (i in 0 until view.childCount) find(view.getChildAt(i), description)?.let { return it }
                        return null
                    }
                    val attach = requireNotNull(find(activity.window.decorView, "Attach photos/videos"))
                    val send = requireNotNull(find(activity.window.decorView, "Send thought"))
                    val writing = requireNotNull(find(activity.window.decorView, "Thought text"))
                    val a = IntArray(2); val b = IntArray(2); attach.getLocationOnScreen(a); send.getLocationOnScreen(b)
                    assertEquals("Tools and Send share one row", a[1], b[1])
                    assertTrue("Attachments must leave room to write", writing.height >= activity.dp(120))
                }
                instrumentation.uiAutomation.takeScreenshot()?.let { bitmap -> File(context.getExternalFilesDir(null), "capture-media.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } }
                androidx.test.espresso.Espresso.closeSoftKeyboard()
                onView(withContentDescription(file.name)).perform(scrollTo()).check(androidx.test.espresso.assertion.ViewAssertions.matches(isDisplayed()))
                onView(withContentDescription("Send thought")).perform(click()); settle()
                assertEquals(draft.mediaIds, repository { it.dao.entry(draft.entryId)!!.mediaIds })
                assertFalse(repository { it.dao.entry(draft.entryId)!!.completed })
                repository { it.setCompleted(draft.entryId, true) }
                assertTrue(repository { it.dao.entry(draft.entryId)!!.completed })
                assertEquals(draft.mediaIds, repository { it.dao.entry(draft.entryId)!!.mediaIds })
                assertNull(repository { it.dao.draft(profile.id) })
            }
        } finally {
            file.delete()
            repository { repo -> entryId?.let { repo.dao.deleteEntry(it) }; repo.dao.deleteDraft(profile.id); MediaFiles(context, repo).cleanup() }
        }
    }
}
