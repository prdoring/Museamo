package com.prdoring.museamo

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import com.getcapacitor.*
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray

@CapacitorPlugin(name = "Museamo", permissions = [com.getcapacitor.annotation.Permission(alias = "location", strings = [android.Manifest.permission.ACCESS_COARSE_LOCATION, android.Manifest.permission.ACCESS_FINE_LOCATION])])
class MuseamoPlugin : Plugin() {
    private var cancelLocation: (() -> Unit)? = null
    @PluginMethod fun openLocation(call: PluginCall) {
        val lat = call.getDouble("latitude"); val lng = call.getDouble("longitude")
        if (lat == null || lng == null || !lat.isFinite() || !lng.isFinite() || lat !in -90.0..90.0 || lng !in -180.0..180.0) { call.reject("Invalid map coordinates."); return }
        activity.runOnUiThread {
            try {
                try { activity.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("geo:0,0?q=$lat,$lng"))) }
                catch (_: android.content.ActivityNotFoundException) { activity.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://www.google.com/maps/search/?api=1&query=$lat,$lng"))) }
                call.resolve()
            } catch (e: Exception) { call.reject("No app could open this location.", e) }
        }
    }
    @PluginMethod fun locationSettings(call: PluginCall) { call.resolve(JSObject().put("enabled", LocationCapture.enabled(context)).put("permitted", LocationCapture.permitted(context))) }
    @PluginMethod fun setLocationEnabled(call: PluginCall) {
        if (call.getBoolean("enabled") != true) { LocationCapture.setEnabled(context, false); call.resolve(JSObject().put("enabled", false)); return }
        if (LocationCapture.permitted(context)) { LocationCapture.setEnabled(context, true); call.resolve(JSObject().put("enabled", true)) }
        else { LocationCapture.markPermissionAsked(context); requestPermissionForAlias("location", call, "locationPermission") }
    }
    @com.getcapacitor.annotation.PermissionCallback private fun locationPermission(call: PluginCall) {
        val enabled = LocationCapture.permitted(context)
        LocationCapture.setEnabled(context, enabled)
        call.resolve(JSObject().put("enabled", enabled))
    }
    private fun locationResult(call: PluginCall, result: LocationCapture.Result) {
        call.resolve(JSObject().put("location", result.location?.let { org.json.JSONObject(it) } ?: org.json.JSONObject.NULL).put("status", result.status))
    }
    private fun captureCurrentLocation(call: PluginCall) {
        activity.runOnUiThread {
            cancelLocation?.invoke()
            cancelLocation = LocationCapture.requestResult(context, automatic = false) { result -> locationResult(call, result) }
        }
    }
    @PluginMethod fun currentLocation(call: PluginCall) {
        activity.runOnUiThread {
            if (!LocationCapture.servicesOn(context)) { locationResult(call, LocationCapture.Result(null, "services-off")); return@runOnUiThread }
            if (LocationCapture.permitted(context)) captureCurrentLocation(call)
            else { LocationCapture.markPermissionAsked(context); requestPermissionForAlias("location", call, "currentLocationPermission") }
        }
    }
    @com.getcapacitor.annotation.PermissionCallback private fun currentLocationPermission(call: PluginCall) {
        if (LocationCapture.permitted(context)) { LocationCapture.setEnabled(context, true); captureCurrentLocation(call) }
        else locationResult(call, LocationCapture.Result(null, "permission-denied"))
    }
    override fun handleOnPause() { cancelLocation?.invoke(); cancelLocation = null }
    private val receiver = object : BroadcastReceiver() { override fun onReceive(context: Context, intent: Intent) { notifyListeners("dataChanged", JSObject()) } }
    override fun load() { ContextCompat.registerReceiver(context, receiver, IntentFilter("com.prdoring.museamo.DATA_CHANGED"), ContextCompat.RECEIVER_NOT_EXPORTED) }
    override fun handleOnDestroy() { context.unregisterReceiver(receiver) }
    override fun handleOnResume() { notifyListeners("dataChanged", JSObject()) }
    private fun task(call: PluginCall, mutate: Boolean = false, block: (Repository) -> JSObject) {
        Store.executor.execute {
            try { val result = block(Store.get(context)); if (mutate) Store.changed(context); call.resolve(result) }
            catch (e: Exception) { call.reject(e.message ?: "Operation failed. Please try again.", e) }
        }
    }
    @PluginMethod fun pickMedia(call: PluginCall) {
        val remaining = call.getInt("remaining") ?: 10
        if (remaining !in 1..10) { call.reject("Choose up to 10 attachments."); return }
        val intent = if (remaining == 1) androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia().createIntent(context, androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageAndVideo))
        else androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia(remaining).createIntent(context, androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageAndVideo))
        startActivityForResult(call, intent, "mediaResult")
    }
    @ActivityCallback private fun mediaResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        if (result.resultCode != Activity.RESULT_OK) { call.resolve(JSObject().put("attachments", JSONArray())); return }
        task(call) { repo ->
            val data = result.data
            val uris = data?.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } } ?: listOfNotNull(data?.data)
            val rows = MediaFiles(context, repo).import(uris.distinct(), call.getInt("remaining") ?: 10)
            JSObject().put("attachments", JSONArray(rows.map { it.json() }))
        }
    }
    @PluginMethod fun resolveMedia(call: PluginCall) = task(call) { repo ->
        val id = requireNotNull(call.getString("id")); requireNotNull(repo.dao.media(id)) { "Media is unavailable." }
        val files = MediaFiles(context, repo); require(files.file(id).isFile) { "Media is unavailable." }
        val url = "https://com.prdoring.museamo/_media/$id"
        JSObject().put("url", url).also { if (files.thumbnail(id).isFile) it.put("thumbnailUrl", "$url/thumbnail") }
    }
    @PluginMethod fun releaseMedia(call: PluginCall) = task(call) { repo ->
        ids(call.getArray("ids")?.toString() ?: "[]").forEach { repo.mediaPins.remove(it) }
        MediaFiles(context, repo).cleanup(); JSObject()
    }
    @PluginMethod fun releaseDeleted(call: PluginCall) = task(call) { repo ->
        repo.deletedPins.remove(call.getString("id")); MediaFiles(context, repo).cleanup(); JSObject()
    }
    @PluginMethod fun copyFormatted(call: PluginCall) {
        activity.runOnUiThread {
            try {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                clipboard.setPrimaryClip(android.content.ClipData.newHtmlText("Thought", call.getString("text") ?: "", call.getString("html") ?: ""))
                call.resolve()
            } catch (e: Exception) { call.reject("Could not copy this thought.", e) }
        }
    }
    @PluginMethod fun openExternal(call: PluginCall) {
        val uri = android.net.Uri.parse(call.getString("url") ?: "")
        if (uri.scheme?.lowercase(java.util.Locale.ROOT) !in listOf("http", "https") || uri.host.isNullOrBlank()) { call.reject("Only web links can be opened."); return }
        activity.runOnUiThread { try { activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); call.resolve() } catch (e: Exception) { call.reject("No app could open this link.", e) } }
    }
    @PluginMethod fun queryEntries(call: PluginCall) = task(call) { repo ->
        val limit = (call.getInt("limit") ?: 50).coerceIn(1, Int.MAX_VALUE - 1)
        val tag = call.getString("tagId")?.let { "\"$it\"" } ?: ""
        val order = call.getString("order") ?: "newest"
        val checklistOnly = call.getBoolean("checklistOnly") ?: false
        require(order in listOf("newest", "checklist")) { "Unknown thought order." }
        val rows = if (order == "checklist") {
            require(call.getString("tagId")?.let { repo.dao.tag(it)?.type } == "checklist") { "Choose a Checklist category." }
            require(call.getLong("beforeTime") == null || call.data.opt("beforeCompleted") is Boolean) { "Reload this checklist before loading more thoughts." }
            repo.dao.checklistPage(call.getString("search") ?: "", call.getBoolean("starred") ?: false, tag, limit + 1, call.getLong("beforeTime"), call.getString("beforeId") ?: "", call.getBoolean("beforeCompleted") ?: false, call.getBoolean("located") ?: false, if (call.getLong("beforeTime") == null) (call.getInt("offset") ?: 0).coerceAtLeast(0) else 0)
        } else if (call.getLong("beforeTime") == null && call.getInt("offset") != null) repo.dao.query(call.getString("search") ?: "", call.getBoolean("starred") ?: false, tag, limit + 1, (call.getInt("offset") ?: 0).coerceAtLeast(0), call.getBoolean("located") ?: false, checklistOnly) else repo.dao.page(call.getString("search") ?: "", call.getBoolean("starred") ?: false, tag, limit + 1, call.getLong("beforeTime"), call.getString("beforeId") ?: "", call.getBoolean("located") ?: false, checklistOnly)
        JSObject().put("entries", JSONArray(rows.take(limit).map { repo.entryJson(it) })).put("hasMore", rows.size > limit)
    }
    @PluginMethod fun getEntry(call: PluginCall) = task(call) { repo -> JSObject().put("entry", repo.dao.entry(requireNotNull(call.getString("id")))?.let { repo.entryJson(it) } ?: org.json.JSONObject.NULL) }
    @PluginMethod fun library(call: PluginCall) = task(call) { repo -> JSObject().put("tags", JSONArray(repo.dao.tags().map { it.json().put("count", repo.dao.tagCount("\"${it.id}\"")) })).put("profiles", JSONArray(repo.dao.profiles().map { it.json() })) }
    @PluginMethod fun updateEntry(call: PluginCall) = task(call, true) { repo ->
        val location = PostLocation.parse(call.data.opt("location"))
        val entryId = requireNotNull(call.getString("id"))
        val before = repo.dao.entry(entryId)?.location
        repo.edit(requireNotNull(call.getString("id")), requireNotNull(call.getString("text")), ids(requireNotNull(call.getArray("tagIds")).toString()), call.getArray("attachmentIds")?.let { ids(it.toString()) }, PostLocation.parse(call.data.opt("location")), call.data.has("location"))
        if (location != null && (before == null || org.json.JSONObject(before).optString("token") != org.json.JSONObject(location).optString("token"))) {
            val app = context.applicationContext
            LocationCapture.resolve(app, location) { enriched -> Store.executor.execute { if (Store.get(app).enrichLocation(entryId, location, enriched)) Store.changed(app) } }
        }
        MediaFiles(context, repo).cleanup(); JSObject()
    }
    @PluginMethod fun setStar(call: PluginCall) = task(call, true) { repo -> val row = requireNotNull(repo.dao.entry(requireNotNull(call.getString("id")))) { "This thought no longer exists." }; repo.dao.updateEntry(row.copy(starred = call.getBoolean("starred") ?: false)); activity.runOnUiThread { activity.window.decorView.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP) }; JSObject() }
    @PluginMethod fun setCompleted(call: PluginCall) = task(call, true) { repo ->
        val completed = call.data.opt("completed")
        require(completed is Boolean) { "Invalid completed state." }
        repo.setCompleted(requireNotNull(call.getString("id")), completed)
        JSObject()
    }
    @PluginMethod fun deleteEntry(call: PluginCall) = task(call, true) { repo -> repo.delete(requireNotNull(call.getString("id"))); JSObject() }
    @PluginMethod fun restoreEntry(call: PluginCall) = task(call, true) { repo -> repo.restore(Backup.entry(requireNotNull(call.getObject("entry")))); JSObject() }
    @PluginMethod fun saveTag(call: PluginCall) = task(call, true) { repo ->
        require(!call.data.has("type") || call.data.opt("type") is String) { "Invalid category type." }
        repo.saveTag(call.getString("id"), requireNotNull(call.getString("name")), call.getString("type")); JSObject()
    }
    @PluginMethod fun deleteTag(call: PluginCall) = task(call, true) { repo -> repo.removeTag(requireNotNull(call.getString("id"))); JSObject() }
    @PluginMethod fun saveProfile(call: PluginCall) = task(call, true) { repo -> repo.saveProfile(Backup.profile(requireNotNull(call.getObject("profile")))); JSObject() }
    @PluginMethod fun getDraft(call: PluginCall) = task(call) { repo ->
        val profile = call.getString("profileId")?.let { requireNotNull(repo.dao.profile(it)) { "Unknown capture profile." } }
        val tag = call.getString("tagId")
        val draft = repo.draft(profile?.id ?: "app:${tag ?: "general"}", profile, tag)
        JSObject().put("draft", repo.draftJson(draft))
    }
    @PluginMethod fun updateDraft(call: PluginCall) = task(call) { repo ->
        val draft = requireNotNull(repo.dao.draft(requireNotNull(call.getString("profileKey")))) { "Open a draft before editing it." }
        repo.saveDraft(draft.copy(location = if (call.data.has("location")) PostLocation.parse(call.data.opt("location")) else draft.location, locationAttempted = call.getBoolean("locationAttempted") ?: draft.locationAttempted, text = requireNotNull(call.getString("text")), tagIds = requireNotNull(call.getArray("tagIds")).toString(), mediaIds = call.getArray("attachmentIds")?.toString() ?: draft.mediaIds)); JSObject()
    }
    @PluginMethod fun discardDraft(call: PluginCall) = task(call) { repo -> repo.dao.deleteDraft(requireNotNull(call.getString("profileKey"))); MediaFiles(context, repo).cleanup(); JSObject() }
    @PluginMethod fun compose(call: PluginCall) { startActivityForResult(call, Intent(context, CaptureActivity::class.java).putExtra("initialTag", call.getString("tagId")), "composeResult") }
    @ActivityCallback private fun composeResult(call: PluginCall?, result: ActivityResult) { call?.resolve(JSObject().put("cancelled", result.resultCode != Activity.RESULT_OK).put("entryId", result.data?.getStringExtra("entryId"))) }
    @PluginMethod fun configureWidget(call: PluginCall) { activity.startActivity(Intent(context, WidgetConfigActivity::class.java).putExtra("profileId", call.getString("profileId"))); call.resolve() }
    @PluginMethod fun exportBackup(call: PluginCall) {
        val date = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())
        startActivityForResult(call, Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/zip").putExtra(Intent.EXTRA_TITLE, "museamo-$date.zip"), "exportResult")
    }
    @ActivityCallback private fun exportResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        if (result.resultCode != Activity.RESULT_OK) { call.resolve(JSObject().put("cancelled", true)); return }
        task(call) { repo ->
            val uri = requireNotNull(result.data?.data) { "No export file was selected." }
            requireNotNull(context.contentResolver.openOutputStream(uri, "wt")) { "Cannot write this file." }.use { MediaBackup.export(context, repo, it) }
            JSObject().put("cancelled", false)
        }
    }
    @PluginMethod fun importBackup(call: PluginCall) {
        startActivityForResult(call, Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/json", "text/plain", "application/octet-stream")), "importResult")
    }
    @ActivityCallback private fun importResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        if (result.resultCode != Activity.RESULT_OK) { call.resolve(JSObject().put("cancelled", true)); return }
        task(call, true) { repo ->
            val uri = requireNotNull(result.data?.data) { "No backup file was selected." }
            requireNotNull(context.contentResolver.openInputStream(uri)) { "Cannot read this file." }.use { MediaBackup.import(context, repo, it) }
            JSObject().put("cancelled", false)
        }
    }
}
