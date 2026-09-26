package com.prdoring.museamo

import org.junit.Assert.*
import org.junit.Test

class MediaRangeTest {
    @Test fun videoSeekingSupportsClosedOpenAndSuffixRanges() {
        assertNull(MediaRange.parse(null, 100))
        assertEquals(10L..19L, MediaRange.parse("bytes=10-19", 100))
        assertEquals(50L..99L, MediaRange.parse("bytes=50-", 100))
        assertEquals(90L..99L, MediaRange.parse("bytes=-10", 100))
        assertEquals(0L..99L, MediaRange.parse("bytes=0-999", 100))
    }
    @Test fun invalidOrUnsatisfiableRangesFail() {
        listOf("bytes=100-", "bytes=20-10", "bytes=-0", "bytes=-", "bytes=1-2,4-5", "bytes=9999999999999999999999999-").forEach {
            try { MediaRange.parse(it, 100); fail(it) } catch (_: IllegalArgumentException) {}
        }
    }
}
