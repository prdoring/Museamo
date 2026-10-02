package com.prdoring.museamo

import org.json.JSONObject

/** Internal shared-core bridge. Loading failure never selects preview or destructive fallback. */
object SyncCore {
    private val loaded = runCatching { System.loadLibrary("museamo_sync_core") }
    @JvmStatic private external fun evaluate(input: String): String
    @JvmStatic private external fun startCoordinator(callback: Any, bind: String): String
    @JvmStatic private external fun coordinatorCommand(method: String, input: String): String
    @JvmStatic private external fun stopCoordinator(): String
    fun available(): Boolean = loaded.isSuccess
    fun request(input: JSONObject): JSONObject {
        loaded.getOrThrow()
        return unwrap(evaluate(input.toString()))
    }
    fun start(platform: SyncPlatform): JSONObject { loaded.getOrThrow(); return unwrap(startCoordinator(platform, "0.0.0.0:0")) }
    fun command(method: String, input: JSONObject = JSONObject()): JSONObject { loaded.getOrThrow(); return unwrap(coordinatorCommand(method, input.toString())) }
    fun stop(): JSONObject { loaded.getOrThrow(); return unwrap(stopCoordinator()) }
    private fun unwrap(raw: String): JSONObject {
        val response = JSONObject(raw)
        check(response.getBoolean("ok")) { response.optString("error", "Sync core is unavailable") }
        return response.getJSONObject("result")
    }
}
