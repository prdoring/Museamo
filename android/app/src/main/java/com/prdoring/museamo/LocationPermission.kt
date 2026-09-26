package com.prdoring.museamo

import android.Manifest
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import java.util.function.Consumer

/** Shared first-open permission flow for the app and standalone widget composer. */
class LocationPermission(private val activity: ComponentActivity, private val complete: Consumer<Boolean>) {
    private val launcher = activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val granted = LocationCapture.permitted(activity)
        // Android permission controls availability, not the user's auto-attach preference.
        complete.accept(granted)
    }
    fun onOpen() {
        if (LocationPolicy.askOnOpen(LocationCapture.enabled(activity), LocationCapture.permitted(activity), LocationCapture.permissionAsked(activity), LocationCapture.servicesOn(activity))) request()
    }
    fun request() {
        if (!LocationCapture.servicesOn(activity)) { complete.accept(false); return }
        if (LocationCapture.permitted(activity)) {
            complete.accept(true); return
        }
        LocationCapture.markPermissionAsked(activity)
        launcher.launch(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION))
    }
}
