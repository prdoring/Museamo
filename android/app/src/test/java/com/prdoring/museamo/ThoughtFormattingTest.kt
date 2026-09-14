package com.prdoring.museamo

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class ThoughtFormattingTest {
    @Test fun sharedPasteFixtures() {
        val fixtures = JsonParser.parseString(File("../../test-fixtures/formatting.json").readText()).asJsonArray
        fixtures.forEach { value ->
            val fixture = value.asJsonObject
            assertEquals(fixture["name"].asString, fixture["markdown"].asString, ThoughtFormatting.fromHtml(fixture["html"].asString))
        }
    }
    @Test fun emphasisAndToggle() {
        val edit = ThoughtFormatting.format("a good thought", 2, 6, "bold")
        assertEquals("a **good** thought", edit.text)
        assertEquals("a good thought", ThoughtFormatting.format(edit.text, edit.start, edit.end, "bold").text)
    }
    @Test fun lines() { assertEquals("1. one\n2. two\nthree", ThoughtFormatting.format("one\ntwo\nthree", 0, 8, "number").text) }
}
