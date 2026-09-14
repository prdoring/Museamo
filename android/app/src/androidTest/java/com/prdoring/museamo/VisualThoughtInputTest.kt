package com.prdoring.museamo

import android.graphics.Typeface
import android.text.style.StyleSpan
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class VisualThoughtInputTest {
    @Test fun visualFormattingAndDraftRoundTrip() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val input = VisualThoughtInput(android.view.ContextThemeWrapper(instrumentation.targetContext, androidx.appcompat.R.style.Theme_AppCompat))
            input.setMarkdown("A **bold** and _gentle_ thought")
            assertEquals("A bold and gentle thought", input.text.toString())
            assertTrue(input.text!!.getSpans(2, 6, StyleSpan::class.java).any { it.style == Typeface.BOLD })
            val restored = VisualThoughtInput(input.context)
            restored.setMarkdown(input.markdown())
            assertEquals(input.text.toString(), restored.text.toString())
            input.setSelection(2, 6); input.applyFormat("bold")
            assertFalse(input.markdown().contains("**bold**"))
            input.applyFormat("italic")
            assertTrue(input.markdown().contains("_bold_"))
            input.setMarkdown("- first\n- second")
            assertEquals("first\nsecond", input.text.toString())
            assertEquals("- first\n- second", input.markdown())
            input.setMarkdown("word #later")
            input.setSelection(0, 4); input.applyFormat("bold"); input.removeHashtag("later")
            assertEquals("**word** ", input.markdown())
            input.setMarkdown("")
            input.setSelection(0)
            "**hello**".forEach { input.text!!.insert(input.selectionStart, it.toString()); input.setSelection(input.length()) }
            assertEquals("hello", input.text.toString())
            assertEquals("**hello**", input.markdown())
            input.setMarkdown("")
            input.setSelection(0)
            fun type(value: String) { value.forEach { input.text!!.insert(input.selectionStart, it.toString()); input.setSelection(input.length()) } }
            type("- first\nsecond\n\nafter")
            assertEquals("first\nsecond\nafter", input.text.toString())
            assertEquals("- first\n- second\nafter", input.markdown())
        }
    }
}
