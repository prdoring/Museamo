package com.prdoring.museamo

import org.junit.Assert.*
import org.junit.Test

class HashtagsTest {
    @Test fun sharedFixtures() {
        val fixtures = com.google.gson.JsonParser.parseString(java.io.File("../../test-fixtures/hashtags.json").readText()).asJsonArray
        fixtures.forEach { item -> val row = item.asJsonObject; assertEquals(row.getAsJsonArray("names").map { it.asString }, Hashtags.names(row.get("text").asString)) }
    }

    @Test fun extractsAndDeduplicatesWithoutTreatingFragmentsAsTags() {
        assertEquals(listOf("words", "café", "shower-thoughts"), Hashtags.names("#words #WORDS #café #shower-thoughts https://example.com/#fragment email#part"))
    }
    @Test fun detectsCursorTokenAndReplacesWholeToken() {
        assertEquals(Hashtags.Token(6, 12, "wo"), Hashtags.active("Hello #words later", 9))
        assertNull(Hashtags.active("url#words", 9))
        assertEquals("", Hashtags.active("Hello #", 7)!!.query)
    }
    @Test fun doesNotTruncateOversizedHashtags() { assertTrue(Hashtags.names("#" + "a".repeat(81)).isEmpty()) }
}

