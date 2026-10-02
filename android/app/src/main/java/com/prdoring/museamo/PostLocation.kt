package com.prdoring.museamo

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Address
import android.location.Geocoder
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.Executors

/** Portable metadata; the token also prevents stale enrichment after refresh/removal. */
object PostLocation {
    fun parse(value: Any?): String? {
        if (value == null || value == JSONObject.NULL) return null
        require(value is JSONObject) { "Invalid location." }
        fun number(key: String, min: Double, max: Double): Double {
            val n = value.get(key)
            require(n is Number && n.toDouble().isFinite() && n.toDouble() in min..max) { "Invalid location $key." }
            return n.toDouble()
        }
        val capturedAt = number("capturedAt", 0.0, Backup.MAX_TIMESTAMP.toDouble()); require(capturedAt == capturedAt.toLong().toDouble()) { "Invalid location capturedAt." }
        val result = JSONObject().put("latitude", number("latitude", -90.0, 90.0))
            .put("longitude", number("longitude", -180.0, 180.0))
            .put("capturedAt", capturedAt.toLong())
        if (!value.isNull("accuracy")) result.put("accuracy", number("accuracy", 0.0, Double.MAX_VALUE))
        for (key in listOf("token", "name", "address", "locality", "userLabel", "city", "region", "country", "countryCode")) {
            if (!value.isNull(key)) {
                val s = value.get(key); require(s is String && s.length <= 500) { "Invalid location $key." }
                result.put(key, s.trim())
            }
        }
        require(result.optString("token").isNotBlank()) { "Missing location identity." }
        return result.toString()
    }
    fun search(value: String?): String {
        val o = value?.let { JSONObject(it) } ?: return ""
        return listOf("userLabel", "name", "address", "locality", "city", "region", "country", "countryCode").map { o.optString(it) }.joinToString(" ")
    }
    fun label(value: String?): String {
        val o = value?.let { JSONObject(it) } ?: return "No location"
        return LocationLabels.format(name = o.optString("name"), address = o.optString("address"), locality = o.optString("locality"), userLabel = o.optString("userLabel"), city = o.optString("city"), region = o.optString("region"), country = o.optString("country"), countryCode = o.optString("countryCode"))
    }
    fun enrich(value: String, address: Address?): String {
        if (address == null) return value
        val o = JSONObject(value)
        val street = listOfNotNull(address.subThoroughfare, address.thoroughfare).joinToString(" ")
        val excludedNames = listOfNotNull(street, address.thoroughfare, address.locality, address.subThoroughfare, address.adminArea, address.countryName, address.postalCode, address.getAddressLine(0))
        val feature = address.featureName?.takeIf { it.isNotBlank() && it.any(Char::isLetter) && excludedNames.none { other -> it.trim().equals(other.trim(), true) } }
        feature?.let { o.put("name", it.take(500)) }
        address.getAddressLine(0)?.takeIf { it.isNotBlank() }?.let { o.put("address", it.take(500)) }
        listOfNotNull(address.locality ?: address.subAdminArea, address.adminArea).distinct().joinToString(", ").takeIf { it.isNotBlank() }?.let { o.put("locality", it.take(500)) }
        mapOf("city" to (address.locality ?: address.subAdminArea), "region" to address.adminArea, "country" to address.countryName, "countryCode" to address.countryCode).forEach { (key, text) ->
            text?.takeIf { it.isNotBlank() }?.let { o.put(key, it.trim().take(500)) }
        }
        return o.toString()
    }
}

object LocationCapture {
    private val geocoding = Executors.newFixedThreadPool(2)
    private val main = Handler(Looper.getMainLooper())
    fun enabled(context: Context) = context.getSharedPreferences("location", Context.MODE_PRIVATE).getBoolean("enabled", true)
    fun setEnabled(context: Context, enabled: Boolean) { context.getSharedPreferences("location", Context.MODE_PRIVATE).edit().putBoolean("enabled", enabled).apply() }
    fun permissionAsked(context: Context) = context.getSharedPreferences("location", Context.MODE_PRIVATE).getBoolean("permissionAsked", false)
    fun markPermissionAsked(context: Context) { context.getSharedPreferences("location", Context.MODE_PRIVATE).edit().putBoolean("permissionAsked", true).apply() }
    fun servicesOn(context: Context) = runCatching { LocationManagerCompat.isLocationEnabled(context.getSystemService(LocationManager::class.java)) }.getOrDefault(false)
    fun permitted(context: Context) = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    fun available(context: Context): Boolean = enabled(context) && permitted(context) && servicesOn(context)

    data class Result(val location: String?, val status: String)
    fun request(context: Context, complete: (String?) -> Unit): () -> Unit = requestResult(context) { complete(it.location) }
    /** Never reads even a cached position with services off. Call on the main thread. */
    @SuppressLint("MissingPermission")
    fun requestResult(context: Context, automatic: Boolean = true, complete: (Result) -> Unit): () -> Unit {
        val unavailable = when {
            !servicesOn(context) -> "services-off"
            !permitted(context) -> "permission-denied"
            automatic && !enabled(context) -> "disabled"
            else -> null
        }
        if (unavailable != null) { complete(Result(null, unavailable)); return {} }
        val manager = context.getSystemService(LocationManager::class.java)
        var done = false
        lateinit var listener: LocationListener
        lateinit var timeout: Runnable
        fun finish(location: Location?, status: String) {
            if (done) return
            done = true
            main.removeCallbacks(timeout)
            runCatching { manager.removeUpdates(listener) }
            val value = runCatching {
                location?.takeIf { (!automatic || enabled(context)) && permitted(context) && servicesOn(context) && LocationPolicy.recent(it.elapsedRealtimeNanos, android.os.SystemClock.elapsedRealtimeNanos()) }?.let {
                    PostLocation.parse(JSONObject().put("latitude", it.latitude).put("longitude", it.longitude)
                        .put("accuracy", it.accuracy.toDouble()).put("capturedAt", it.time).put("token", uid()))
                }
            }.getOrNull()
            complete(Result(value, if (value != null) "available" else if (!servicesOn(context)) "services-off" else status))
        }
        listener = object : LocationListener {
            override fun onLocationChanged(location: Location) { if (LocationPolicy.recent(location.elapsedRealtimeNanos, android.os.SystemClock.elapsedRealtimeNanos())) finish(location, "unavailable") }
            override fun onProviderDisabled(provider: String) { if (!servicesOn(context)) finish(null, "services-off") }
            override fun onProviderEnabled(provider: String) {}
            @Deprecated("Legacy callback") override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        }
        timeout = Runnable { finish(null, "timeout") }
        val providers = listOf("fused", LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER).filter { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
        // Keep immediate capture useful when Android already has a recent fix (including approximate fixes).
        val recent = providers.mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
            .filter { LocationPolicy.recent(it.elapsedRealtimeNanos, android.os.SystemClock.elapsedRealtimeNanos()) }
            .maxByOrNull { it.elapsedRealtimeNanos }
        if (recent != null) { finish(recent, "unavailable"); return {} }
        main.postDelayed(timeout, 10_000)
        var subscribed = false
        providers.forEach { provider -> if (runCatching { manager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper()) }.isSuccess) subscribed = true }
        if (!subscribed) finish(null, "unavailable")
        return { finish(null, "cancelled") }
    }
    @Suppress("DEPRECATION")
    fun resolve(context: Context, value: String, complete: (String) -> Unit) {
        val app = context.applicationContext
        geocoding.execute {
            val enriched = runCatching {
                val o = JSONObject(value)
                val address = if (Geocoder.isPresent()) Geocoder(app, Locale.getDefault()).getFromLocation(o.getDouble("latitude"), o.getDouble("longitude"), 1)?.firstOrNull() else null
                PostLocation.enrich(value, address)
            }.getOrDefault(value)
            main.post { complete(enriched) }
        }
    }
}
