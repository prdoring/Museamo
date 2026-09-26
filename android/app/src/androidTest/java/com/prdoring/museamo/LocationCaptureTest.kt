package com.prdoring.museamo

import android.content.Context
import android.content.ContextWrapper
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test

class LocationCaptureTest {
    private val app = ApplicationProvider.getApplicationContext<Context>()
    private fun isolated(denied: Boolean = false): Context = object : ContextWrapper(app) {
        private val preferences = "test-location-${uid()}"
        override fun getSharedPreferences(name: String?, mode: Int) = app.getSharedPreferences(preferences, mode)
        override fun checkPermission(permission: String, pid: Int, uid: Int): Int = if (denied) PackageManager.PERMISSION_DENIED else super.checkPermission(permission, pid, uid)
    }
    @Test fun explicitOptOutReturnsImmediatelyWithoutCapturing() {
        val context = isolated()
        assertTrue(LocationCapture.enabled(context))
        LocationCapture.setEnabled(context, false)
        assertFalse(LocationCapture.enabled(context))
        var calls = 0
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val cancel = LocationCapture.request(context) { calls++; assertNull(it) }
            cancel(); cancel()
        }
        assertEquals(1, calls)
    }
    @Test fun deniedPermissionReturnsNoLocationEvenWithOptIn() {
        val context = isolated(denied = true)
        LocationCapture.setEnabled(context, true)
        assertFalse(LocationCapture.permitted(context))
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            var completed = false
            LocationCapture.request(context) { assertNull(it); completed = true }
            assertTrue(completed)
        }
    }
    @Test fun deviceLocationCompletesWithinDeadlineWithoutChangingDeviceSettings() {
        val context = isolated()
        val latch = java.util.concurrent.CountDownLatch(1)
        var result: LocationCapture.Result? = null
        var cancel: (() -> Unit)? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            cancel = LocationCapture.requestResult(context) { result = it; latch.countDown() }
        }
        try {
            assertTrue("Location did not finish within 12 seconds", latch.await(12, java.util.concurrent.TimeUnit.SECONDS))
            assertNotNull(result)
            assertTrue(result!!.status in listOf("available", "services-off", "permission-denied", "timeout", "unavailable"))
            if (result!!.status == "available") assertNotNull(result!!.location) else assertNull(result!!.location)
            // Report availability only, never the device's coordinates.
            println("Device location result: ${result!!.status}")
        } finally { InstrumentationRegistry.getInstrumentation().runOnMainSync { cancel?.invoke() } }
    }
}
