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
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.runner.RunWith
import java.util.concurrent.Callable
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class CaptureFlowTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    @get:Rule val location = ManualLocationRule()
    private fun <T> repository(block: (Repository) -> T): T = Store.executor.submit(Callable { block(Store.get(context)) }).get(10, TimeUnit.SECONDS)
    private fun settle() { repository { }; InstrumentationRegistry.getInstrumentation().waitForIdleSync() }
    private fun awaitEntry(id: String): EntryRow {
        val deadline = android.os.SystemClock.uptimeMillis() + 5000
        var saved = repository { it.dao.entry(id) }
        while (saved == null && android.os.SystemClock.uptimeMillis() < deadline) {
            settle(); Thread.sleep(50)
            saved = repository { it.dao.entry(id) }
        }
        assertNotNull("The native composer must commit the draft within five seconds", saved)
        return saved!!
    }
    private fun clickControl(description: String) {
        // IME animation can move a synthetic touch; these lifecycle tests check native listeners.
        onView(withContentDescription(description)).perform(object : androidx.test.espresso.ViewAction {
            override fun getConstraints() = org.hamcrest.Matchers.allOf(isDisplayed(), isEnabled())
            override fun getDescription() = "Activate $description through the native button listener"
            override fun perform(controller: androidx.test.espresso.UiController, view: android.view.View) {
                assertTrue(view.performClick()); controller.loopMainThreadUntilIdle()
            }
        })
    }
    private fun sendThought() = clickControl("Send thought")
    @Test fun newlyOpenedBlankComposerDoesNotReuseAnOldCapturedLocation() {
        val oldLocation = PostLocation.parse(JSONObject().put("latitude", 39.7392).put("longitude", -104.9903)
            .put("capturedAt", 1790274033367L).put("token", uid()).put("locality", "Denver"))!!
        val profile = repository { repo ->
            val tag = repo.saveTag(null, "Blank location ${uid()}")
            ProfileRow(uid(), "Blank location regression", "fixed", jsonIds(listOf(tag.id))).also { profile ->
                repo.saveProfile(profile)
                repo.saveDraft(repo.draft(profile.id, profile, null).copy(text = "  ", location = oldLocation, locationAttempted = true))
            }
        }
        val text = "Current blank compose ${uid()}"
        ActivityScenario.launch<CaptureActivity>(Intent(context, CaptureActivity::class.java).putExtra("profileId", profile.id)).use {
            settle()
            // Automatic capture is disabled by the rule: an unavailable new fix must never leave the old one attached.
            val opening = repository { repo -> repo.dao.draft(profile.id)!! }
            assertNull("A new blank composer must discard the previous compose's Denver fix", opening.location)
            assertTrue(opening.locationAttempted)
            assertEquals(profile.tagIds, opening.tagIds)
            onView(withContentDescription("Thought text")).perform(replaceText(text), closeSoftKeyboard())
            sendThought()
            settle()
            val saved = awaitEntry(opening.entryId)
            assertEquals(text, saved.text)
            assertNull(saved.location)
            assertEquals(profile.tagIds, saved.tagIds)
            assertFalse(LocationCapture.enabled(context))
        }
    }
    @Test fun nativeComposerSavesWithProfileTagsWithoutLaunchingReact() {
        val profile = repository { repo ->
            val tag = repo.saveTag(null, "Capture test ${uid()}", "checklist")
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
            val entryId = repository { repo -> repo.dao.draft(profile.id)!!.entryId }
            sendThought()
            settle()
            val saved = awaitEntry(entryId)
            assertEquals(text, saved.text); assertEquals(profile.tagIds, saved.tagIds)
            assertFalse(saved.completed)
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
    @Test fun unfinishedDraftLocationAndExplicitRemovalSurviveBlankActivityRecreation() {
        val raw = PostLocation.parse(JSONObject().put("latitude", 39.7392).put("longitude", -104.9903)
            .put("capturedAt", 1790274033367L).put("token", uid()).put("userLabel", "Chosen draft place"))!!
        val profile = repository { repo ->
            ProfileRow(uid(), "Location lifecycle regression", "fixed").also { profile ->
                repo.saveProfile(profile)
                repo.saveDraft(repo.draft(profile.id, profile, null).copy(text = "Unfinished memory", location = raw, locationAttempted = true))
            }
        }
        ActivityScenario.launch<CaptureActivity>(Intent(context, CaptureActivity::class.java).putExtra("profileId", profile.id)).use { scenario ->
            settle()
            assertEquals(raw, repository { it.dao.draft(profile.id)!!.location })
            onView(withContentDescription("Thought text")).perform(replaceText(""), closeSoftKeyboard())
            scenario.recreate(); settle()
            assertEquals("Recreation of the current blank compose must retain its location", raw, repository { it.dao.draft(profile.id)!!.location })
            androidx.test.espresso.Espresso.closeSoftKeyboard()
            clickControl("Post location")
            onView(withText("Remove location")).perform(click())
            settle()
            scenario.recreate(); settle()
            val removed = repository { it.dao.draft(profile.id)!! }
            assertNull(removed.location)
            assertTrue("An explicit removal must remain attempted across recreation", removed.locationAttempted)
            val text = "Explicitly skipped ${uid()}"
            onView(withContentDescription("Thought text")).perform(replaceText(text), closeSoftKeyboard())
            sendThought()
            settle()
            val saved = awaitEntry(removed.entryId)
            assertEquals(text, saved.text)
            assertNull(saved.location)
        }
    }
    @Test fun pickerSearchUpdatesOnlyItsOwnProfileAndPreservesDraftTags() {
        val (first, second, tag) = repository { repo ->
            val t = repo.saveTag(null, "Searchable ${uid()}", "checklist")
            val a = ProfileRow(uid(), "Picker one", "picker"); val b = ProfileRow(uid(), "Picker two", "picker")
            repo.saveProfile(a); repo.saveProfile(b)
            repo.saveDraft(repo.draft(a.id, a, null).copy(text = "Already started"))
            Triple(a, b, t)
        }
        ActivityScenario.launch<TagPickerActivity>(Intent(context, TagPickerActivity::class.java).putExtra("profileId", first.id)).use {
            settle()
            onView(withContentDescription("Search available tags")).perform(replaceText(tag.name), closeSoftKeyboard())
            Thread.sleep(500) // The bottom sheet relocates while the IME animates away.
            onView(org.hamcrest.Matchers.allOf(withContentDescription(tag.accessibleLabel()), isAssignableFrom(android.widget.Button::class.java))).perform(scrollTo(), click()); settle()
            assertEquals(tag.id, repository { repo -> repo.dao.profile(first.id)!!.selectedTagId })
            assertNull(repository { repo -> repo.dao.profile(second.id)!!.selectedTagId })
            assertEquals("[]", repository { repo -> repo.dao.draft(first.id)!!.tagIds })
        }
    }
}
