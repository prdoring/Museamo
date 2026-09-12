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

@CapacitorPlugin(name = "Museamo")
class MuseamoPlugin : Plugin() {
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
    @PluginMethod fun queryEntries(call: PluginCall) = task(call) { repo ->
        val limit = (call.getInt("limit") ?: 50).coerceIn(1, Int.MAX_VALUE - 1)
        val tag = call.getString("tagId")?.let { "\"$it\"" } ?: ""
        val rows = repo.dao.query(call.getString("search") ?: "", call.getBoolean("starred") ?: false, tag, limit + 1, (call.getInt("offset") ?: 0).coerceAtLeast(0))
        JSObject().put("entries", JSONArray(rows.take(limit).map { it.json() })).put("hasMore", rows.size > limit)
    }
    @PluginMethod fun library(call: PluginCall) = task(call) { repo -> JSObject().put("tags", JSONArray(repo.dao.tags().map { it.json() })).put("profiles", JSONArray(repo.dao.profiles().map { it.json() })) }
    @PluginMethod fun updateEntry(call: PluginCall) = task(call, true) { repo -> repo.edit(requireNotNull(call.getString("id")), requireNotNull(call.getString("text")), ids(requireNotNull(call.getArray("tagIds")).toString())); JSObject() }
    @PluginMethod fun setStar(call: PluginCall) = task(call, true) { repo -> val row = requireNotNull(repo.dao.entry(requireNotNull(call.getString("id")))) { "This thought no longer exists." }; repo.dao.updateEntry(row.copy(starred = call.getBoolean("starred") ?: false, updatedAt = System.currentTimeMillis())); JSObject() }
    @PluginMethod fun deleteEntry(call: PluginCall) = task(call, true) { repo -> repo.dao.deleteEntry(requireNotNull(call.getString("id"))); JSObject() }
    @PluginMethod fun restoreEntry(call: PluginCall) = task(call, true) { repo -> repo.restore(Backup.entry(requireNotNull(call.getObject("entry")))); JSObject() }
    @PluginMethod fun saveTag(call: PluginCall) = task(call, true) { repo -> repo.saveTag(call.getString("id"), requireNotNull(call.getString("name"))); JSObject() }
    @PluginMethod fun deleteTag(call: PluginCall) = task(call, true) { repo -> repo.removeTag(requireNotNull(call.getString("id"))); JSObject() }
    @PluginMethod fun saveProfile(call: PluginCall) = task(call, true) { repo -> repo.saveProfile(Backup.profile(requireNotNull(call.getObject("profile")))); JSObject() }
    @PluginMethod fun getDraft(call: PluginCall) = task(call) { repo ->
        val profile = call.getString("profileId")?.let { requireNotNull(repo.dao.profile(it)) { "Unknown capture profile." } }
        val tag = call.getString("tagId")
        val draft = repo.draft(profile?.id ?: "app:${tag ?: "general"}", profile, tag)
        JSObject().put("draft", draft.json())
    }
    @PluginMethod fun updateDraft(call: PluginCall) = task(call) { repo ->
        val draft = requireNotNull(repo.dao.draft(requireNotNull(call.getString("profileKey")))) { "Open a draft before editing it." }
        repo.saveDraft(draft.copy(text = requireNotNull(call.getString("text")), tagIds = requireNotNull(call.getArray("tagIds")).toString())); JSObject()
    }
    @PluginMethod fun discardDraft(call: PluginCall) = task(call) { repo -> repo.dao.deleteDraft(requireNotNull(call.getString("profileKey"))); JSObject() }
    @PluginMethod fun compose(call: PluginCall) { activity.startActivity(Intent(context, CaptureActivity::class.java).putExtra("initialTag", call.getString("tagId"))); call.resolve() }
    @PluginMethod fun configureWidget(call: PluginCall) { activity.startActivity(Intent(context, WidgetConfigActivity::class.java).putExtra("profileId", call.getString("profileId"))); call.resolve() }
    @PluginMethod fun exportBackup(call: PluginCall) {
        val date = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())
        startActivityForResult(call, Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/json").putExtra(Intent.EXTRA_TITLE, "museamo-$date.json"), "exportResult")
    }
    @ActivityCallback private fun exportResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        if (result.resultCode != Activity.RESULT_OK) { call.resolve(JSObject().put("cancelled", true)); return }
        task(call) { repo ->
            val uri = requireNotNull(result.data?.data) { "No export file was selected." }
            requireNotNull(context.contentResolver.openOutputStream(uri, "wt")) { "Cannot write this file." }.use { it.write(Backup.export(repo).toByteArray(Charsets.UTF_8)) }
            JSObject().put("cancelled", false)
        }
    }
    @PluginMethod fun importBackup(call: PluginCall) {
        startActivityForResult(call, Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/plain", "application/octet-stream")), "importResult")
    }
    @ActivityCallback private fun importResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        if (result.resultCode != Activity.RESULT_OK) { call.resolve(JSObject().put("cancelled", true)); return }
        task(call, true) { repo ->
            val uri = requireNotNull(result.data?.data) { "No backup file was selected." }
            val bytes = requireNotNull(context.contentResolver.openInputStream(uri)) { "Cannot read this file." }.use { input ->
                val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (true) { val n = input.read(buffer); if (n == -1) break; require(output.size() + n <= Backup.MAX_BYTES) { "Choose a backup smaller than 25 MB." }; output.write(buffer, 0, n) }
                output.toByteArray()
            }
            Backup.import(repo, bytes.toString(Charsets.UTF_8)); JSObject().put("cancelled", false)
        }
    }
}
