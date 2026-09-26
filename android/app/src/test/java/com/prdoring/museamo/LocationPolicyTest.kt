package com.prdoring.museamo

import org.junit.Assert.*
import org.junit.Test

class LocationPolicyTest {
    @Test fun firstOpenRequestsPermissionWithoutASettingsVisit() {
        assertTrue(LocationPolicy.askOnOpen(true, false, false, true))
        assertFalse(LocationPolicy.askOnOpen(true, false, true, true))
        assertFalse(LocationPolicy.askOnOpen(true, true, false, true))
        assertFalse(LocationPolicy.askOnOpen(false, false, false, true))
        assertFalse(LocationPolicy.askOnOpen(true, false, false, false))
    }
    @Test fun acceptsRecentOsFixButRejectsOldOrFuturePositions() {
        val now = 120_000_000_000L
        assertTrue(LocationPolicy.recent(now - 5_000_000_000L, now))
        assertTrue(LocationPolicy.recent(now - 60_000_000_000L, now))
        assertFalse(LocationPolicy.recent(now - 60_000_000_001L, now))
        assertFalse(LocationPolicy.recent(now + 1, now))
        assertFalse(LocationPolicy.recent(0, now))
    }
}
