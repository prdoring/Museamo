package com.prdoring.museamo

import android.content.Context
import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.action.ViewActions.*
import androidx.test.espresso.matcher.ViewMatchers.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.Callable
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class CaptureFlowTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private fun <T> repository(block: (Repository) -> T): T = Store.executor.submit(Callable { block(Store.get(context)) }).get(10, TimeUnit.SECONDS)
    private fun settle() { repository { }; InstrumentationRegistry.getInstrumentation().waitForIdleSync() }
    @Test fun nativeComposerSavesWithProfileTagsWithoutLaunchingReact() {
        val profile = repository { repo ->
            val tag = repo.saveTag(null, "Capture test ${uid()}")
            ProfileRow(uid(), "Native capture test", "fixed", jsonIds(listOf(tag.id))).also { repo.saveProfile(it) }
        }
        val text = "Native capture ${uid()}"
        ActivityScenario.launch<CaptureActivity>(Intent(context, CaptureActivity::class.java).putExtra("profileId", profile.id)).use {
            settle()
            onView(withContentDescription("Thought text")).check(androidx.test.espresso.assertion.ViewAssertions.matches(hasFocus()))
            Thread.sleep(500) // Let the requested IME finish its platform animation for the screenshot.
            InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bitmap ->
                java.io.File(context.getExternalFilesDir(null), "capture.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            }
            onView(withContentDescription("Thought text")).perform(replaceText(text), closeSoftKeyboard())
            onView(withContentDescription("Send thought and return")).perform(scrollTo(), click())
            settle()
            val entries = repository { repo -> repo.dao.query(text, false, "", 10, 0) }
            assertEquals(1, entries.size); assertEquals(profile.tagIds, entries.single().tagIds)
            assertNull(repository { repo -> repo.dao.draft(profile.id) })
        }
    }
    @Test fun activityRecreationPreservesUnsentText() {
        val profile = repository { repo -> ProfileRow(uid(), "Draft lifecycle test", "fixed").also { repo.saveProfile(it) } }
        val text = "Interrupted ${uid()}"
        ActivityScenario.launch<CaptureActivity>(Intent(context, CaptureActivity::class.java).putExtra("profileId", profile.id)).use { scenario ->
            settle()
            onView(withContentDescription("Thought text")).perform(replaceText(text), closeSoftKeyboard())
            scenario.recreate(); settle()
            onView(withContentDescription("Thought text")).check(androidx.test.espresso.assertion.ViewAssertions.matches(withText(text)))
            assertEquals(text, repository { repo -> repo.dao.draft(profile.id)!!.text })
            assertTrue(repository { repo -> repo.dao.query(text, false, "", 10, 0).isEmpty() })
        }
    }
    @Test fun pickerSearchUpdatesOnlyItsOwnProfileAndPreservesDraftTags() {
        val (first, second, tag) = repository { repo ->
            val t = repo.saveTag(null, "Searchable ${uid()}")
            val a = ProfileRow(uid(), "Picker one", "picker"); val b = ProfileRow(uid(), "Picker two", "picker")
            repo.saveProfile(a); repo.saveProfile(b)
            repo.saveDraft(repo.draft(a.id, a, null).copy(text = "Already started"))
            Triple(a, b, t)
        }
        ActivityScenario.launch<TagPickerActivity>(Intent(context, TagPickerActivity::class.java).putExtra("profileId", first.id)).use {
            settle()
            onView(withContentDescription("Search available tags")).perform(replaceText(tag.name), closeSoftKeyboard())
            Thread.sleep(500) // The bottom sheet relocates while the IME animates away.
            onView(org.hamcrest.Matchers.allOf(withText(tag.name), isAssignableFrom(android.widget.Button::class.java))).perform(scrollTo(), click()); settle()
            assertEquals(tag.id, repository { repo -> repo.dao.profile(first.id)!!.selectedTagId })
            assertNull(repository { repo -> repo.dao.profile(second.id)!!.selectedTagId })
            assertEquals("[]", repository { repo -> repo.dao.draft(first.id)!!.tagIds })
        }
    }
}
