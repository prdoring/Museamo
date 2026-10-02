package com.prdoring.museamo

import android.content.Context
import android.net.wifi.WifiManager
import androidx.work.*
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Foreground sync keeps discovery alive. Background work is bounded and scheduled by Android. */
object SyncRuntime {
    val executor = Executors.newSingleThreadExecutor()
    @Volatile private var foreground = false
    private var started = false
    private var multicast: WifiManager.MulticastLock? = null
    private var discovery: LanDiscovery? = null
    private var sharingDiscovery: LanDiscovery? = null
    private var lastError: String? = null
    private var app: Context? = null

    fun resume(context: Context) {
        app = context.applicationContext; foreground = true
        executor.execute { runCatching { ensureStarted(context.applicationContext); schedule(context.applicationContext) }.onFailure { lastError = it.message } }
    }
    fun pause() {
        foreground = false
        executor.execute { if (!foreground) stop() }
    }
    /** A native commit wakes foreground sync; replicated notifications never call this. */
    fun localDataChanged() {
        executor.execute {
            if (started) runCatching { SyncCore.command("localDataChanged") }.onFailure { lastError = it.message }
        }
    }
    private fun ensureStarted(context: Context) {
        if (started) return
        check(SyncCore.available()) { "The shared sync core is missing. Install a complete Museamo build to link devices." }
        val wifi = context.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val lock = wifi.createMulticastLock("museamo-lan-sync").apply { setReferenceCounted(false); acquire() }
        try {
            val state = SyncCore.start(SyncPlatform(context)); multicast = lock; started = true; lastError = null
            lateinit var service: LanDiscovery
            service = LanDiscovery(context, state) { hint -> executor.execute { if (started && discovery === service) runCatching { SyncCore.command("discoveryHint", hint) } } }
            discovery = service; service.start()
            lateinit var shared: LanDiscovery
            shared = LanDiscovery(context, state.getJSONObject("sharing"), true) { hint -> executor.execute { if (started && sharingDiscovery === shared) runCatching { SyncCore.command("shareDiscoveryHint", hint) } } }
            sharingDiscovery = shared; shared.start()
        }
        catch (error: Exception) { if (lock.isHeld) lock.release(); throw error }
    }
    private fun stop() {
        discovery?.stop(); discovery = null
        sharingDiscovery?.stop(); sharingDiscovery = null
        if (started) runCatching { SyncCore.stop() }.onFailure { lastError = it.message }
        started = false; multicast?.let { if (it.isHeld) it.release() }; multicast = null
    }
    fun command(context: Context, method: String, input: JSONObject): JSONObject {
        ensureStarted(context.applicationContext)
        return SyncCore.command(method, input).also { schedule(context.applicationContext) }
    }
    fun state(context: Context): JSONObject = try {
        ensureStarted(context.applicationContext); SyncCore.command("getSyncState").also { result ->
            result.put("backgroundMode", "battery-friendly").put("backgroundMayBeDelayed", true)
            lastError?.let { result.put("lastError", it) }; schedule(context.applicationContext)
        }
    } catch (error: Throwable) { lastError = error.message; JSONObject().put("enabled", false).put("phase", "error").put("devices", org.json.JSONArray()).put("nearby", org.json.JSONArray()).put("lastError", error.message ?: "Native sync is unavailable") }
    private fun schedule(context: Context) {
        if (!started || SyncCore.command("getSyncState").isNull("groupId")) return
        val request = PeriodicWorkRequest.Builder(LanSyncWorker::class.java, 15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).setRequiresBatteryNotLow(true).build()).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork("museamo-local-sync", ExistingPeriodicWorkPolicy.KEEP, request)
    }
    internal fun backgroundRun(context: Context): Boolean {
        val future = executor.submit<Boolean> {
                if (foreground) { SyncCore.command("syncNow"); return@submit true }
                try {
                    ensureStarted(context)
                    SyncCore.command("syncNow")
                    // A bounded discovery opportunity; jobs never keep the phone listening all day.
                    repeat(20) { if (foreground || Thread.currentThread().isInterrupted) return@repeat; Thread.sleep(1000) }
                    SyncCore.command("syncNow")
                    Thread.sleep(3000)
                    true
                } finally { if (!foreground) stop() }
            }
        return try { future.get(45, TimeUnit.SECONDS) } catch (_: Exception) { future.cancel(true); false }
    }
}

class LanSyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = if (SyncRuntime.backgroundRun(applicationContext)) Result.success() else Result.retry()
}
