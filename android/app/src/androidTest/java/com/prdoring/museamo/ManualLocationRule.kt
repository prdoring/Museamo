package com.prdoring.museamo

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.rules.ExternalResource

/** Keep unrelated activity tests clear of the first-open system permission dialog. */
class ManualLocationRule : ExternalResource() {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private var enabled = true
    override fun before() {
        enabled = LocationCapture.enabled(context)
        LocationCapture.setEnabled(context, false)
    }
    override fun after() { LocationCapture.setEnabled(context, enabled) }
}
