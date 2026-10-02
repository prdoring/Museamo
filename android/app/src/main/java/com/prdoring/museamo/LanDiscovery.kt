package com.prdoring.museamo

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import org.json.JSONObject
import java.net.Inet6Address

/** Android's network-aware NSD supplements portable mDNS when Wi-Fi has no Internet route. */
@Suppress("DEPRECATION")
class LanDiscovery(context: Context, private val state: JSONObject, private val hint: (JSONObject) -> Unit) {
    private val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    @Volatile private var active = false
    private val pending = java.util.ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private val registration = object : NsdManager.RegistrationListener {
        override fun onServiceRegistered(serviceInfo: NsdServiceInfo) {}
        override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
        override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {}
        override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {}
    }
    private val discovery = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(serviceType: String) {}
        override fun onDiscoveryStopped(serviceType: String) {}
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        override fun onServiceLost(serviceInfo: NsdServiceInfo) {}
        override fun onServiceFound(serviceInfo: NsdServiceInfo) {
            if (!active || !serviceInfo.serviceType.startsWith("_museamo._tcp")) return
            synchronized(pending) { if (pending.size < 128) pending.add(serviceInfo); resolveNext() }
        }
    }
    fun start() {
        if (active) return
        active = true
        val id = state.getString("deviceId"); val info = NsdServiceInfo().apply {
            serviceName = "museamo-${id.takeLast(12)}-android"; serviceType = "_museamo._tcp."; port = state.getString("address").substringAfterLast(':').toInt()
            setAttribute("device", id); setAttribute("name", state.getString("name")); setAttribute("protocol", "1")
        }
        runCatching { manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration) }
        runCatching { manager.discoverServices("_museamo._tcp.", NsdManager.PROTOCOL_DNS_SD, discovery) }
    }
    private fun resolveNext() {
        if (!active || resolving || pending.isEmpty()) return
        resolving = true; val next = pending.removeFirst()
        try {
            manager.resolveService(next, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = finished()
                override fun onServiceResolved(info: NsdServiceInfo) {
                    if (active) {
                        val id = info.attributes["device"]?.toString(Charsets.UTF_8) ?: ""
                        val protocol = info.attributes["protocol"]?.toString(Charsets.UTF_8)
                        val hosts = if (android.os.Build.VERSION.SDK_INT >= 34) info.hostAddresses else listOfNotNull(info.host)
                        val host = hosts.firstOrNull { it is java.net.Inet4Address } ?: hosts.firstOrNull(); val address = host?.hostAddress
                        if (protocol == "1" && id.isNotBlank() && id != state.getString("deviceId") && id.length <= 128 && address != null && info.port in 1..65535) {
                            val endpoint = if (host is Inet6Address) "[$address]:${info.port}" else "$address:${info.port}"
                            hint(JSONObject().put("deviceId", id).put("name", info.attributes["name"]?.toString(Charsets.UTF_8)?.take(128) ?: "Nearby device").put("address", endpoint))
                        }
                    }
                    finished()
                }
                private fun finished() { synchronized(pending) { resolving = false; resolveNext() } }
            })
        } catch (_: Exception) { resolving = false; resolveNext() }
    }
    fun stop() {
        active = false; synchronized(pending) { pending.clear() }
        runCatching { manager.stopServiceDiscovery(discovery) }; runCatching { manager.unregisterService(registration) }
    }
}
