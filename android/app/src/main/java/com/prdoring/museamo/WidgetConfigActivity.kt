package com.prdoring.museamo

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.widget.*
import androidx.appcompat.app.AlertDialog

class WidgetConfigActivity : NativeScreen() {
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID
    private var profileId = uid()
    private var tags: List<TagRow> = emptyList()
    private var selected = mutableSetOf<String>()
    private var pickerTag: String? = null
    private lateinit var label: EditText
    private lateinit var modes: RadioGroup
    private lateinit var tagsButton: Button
    private lateinit var save: Button
    private var editing = false
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setResult(RESULT_CANCELED)
        widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        title("Your little shortcut")
        note("Give this widget a name and a starting place for your thoughts.")
        label = EditText(this).apply { hint = "Widget name"; contentDescription = "Widget name"; setSingleLine(true); filters = arrayOf(android.text.InputFilter.LengthFilter(80)) }
        body.addView(label)
        modes = RadioGroup(this)
        modes.addView(RadioButton(this).apply { id = R.id.mode_fixed; text = "Fixed tags"; minHeight = dp(48) })
        modes.addView(RadioButton(this).apply { id = R.id.mode_picker; text = "Tag picker"; minHeight = dp(48) })
        modes.check(R.id.mode_fixed); body.addView(modes)
        modes.setOnCheckedChangeListener { _, _ -> updateTags() }
        tagsButton = button("No tag") { chooseTags() }; body.addView(tagsButton)
        body.addView(button("Create a tag") {
            val name = EditText(this).apply { hint = "Tag name"; contentDescription = "New tag name"; setSingleLine(true) }
            val dialog = AlertDialog.Builder(this).setTitle("New tag").setView(name).setNegativeButton("Cancel", null).setPositiveButton("Create", null).create()
            dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                work({ repo -> val tag = repo.saveTag(null, name.text.toString()); Store.changed(this); tag to repo.dao.tags() }) { (tag, all) -> tags = all; if (modes.checkedRadioButtonId == R.id.mode_picker) pickerTag = tag.id else selected.add(tag.id); updateTags(); dialog.dismiss() }
            } }; dialog.show()
        })
        body.addView(error)
        save = button("Save widget") { saveConfiguration() }; save.isEnabled = false; body.addView(save)
        work({ repo -> Triple(repo.dao.tags(), intent.getStringExtra("profileId")?.let { repo.dao.profile(it) } ?: repo.dao.binding(widgetId)?.let { repo.dao.profile(it.profileId) }, repo.dao.profiles()) }) { (allTags, current, profiles) ->
            tags = allTags
            if (current != null) { editing = true; profileId = current.id; applyProfile(current) } else label.setText("A thought")
            if (state != null) { profileId = state.getString("profileId") ?: profileId; label.setText(state.getString("label")); selected = ids(state.getString("tags") ?: "[]").toMutableSet(); pickerTag = state.getString("pickerTag"); modes.check(state.getInt("mode", R.id.mode_fixed)) }
            if (!editing && profiles.isNotEmpty()) {
                val copy = button("Copy an existing profile") { AlertDialog.Builder(this).setTitle("Start from a profile").setItems(profiles.map { it.label }.toTypedArray()) { _, which -> applyProfile(profiles[which]) }.show() }
                body.addView(copy, body.childCount - 1)
            }
            updateTags(); save.isEnabled = true
        }
    }
    private fun applyProfile(p: ProfileRow) { label.setText(p.label); selected = ids(p.tagIds).toMutableSet(); pickerTag = p.selectedTagId; modes.check(if (p.mode == "picker") R.id.mode_picker else R.id.mode_fixed); updateTags() }
    private fun updateTags() {
        if (!::tagsButton.isInitialized) return
        tagsButton.text = if (modes.checkedRadioButtonId == R.id.mode_picker) "Start with: " + (tags.find { it.id == pickerTag }?.name ?: "No tag") else tags.filter { it.id in selected }.joinToString(", ") { it.name }.ifEmpty { "No tag · choose tags" }
    }
    private fun chooseTags() {
        if (modes.checkedRadioButtonId == R.id.mode_picker) {
            AlertDialog.Builder(this).setTitle("Initial tag").setSingleChoiceItems((listOf("No tag") + tags.map { it.name }).toTypedArray(), tags.indexOfFirst { it.id == pickerTag } + 1) { dialog, index -> pickerTag = if (index == 0) null else tags[index - 1].id; updateTags(); dialog.dismiss() }.setNegativeButton("Cancel", null).show()
        } else {
            val draftTags = selected.toMutableSet()
            AlertDialog.Builder(this).setTitle("Default tags").setMultiChoiceItems(tags.map { it.name }.toTypedArray(), tags.map { it.id in selected }.toBooleanArray()) { _, index, checked -> if (checked) draftTags.add(tags[index].id) else draftTags.remove(tags[index].id) }.setPositiveButton("Done") { _, _ -> selected = draftTags; updateTags() }.setNegativeButton("Cancel", null).setNeutralButton("No tag") { _, _ -> selected.clear(); updateTags() }.show()
        }
    }
    private fun saveConfiguration() {
        save.isEnabled = false
        val profile = ProfileRow(profileId, label.text.toString(), if (modes.checkedRadioButtonId == R.id.mode_picker) "picker" else "fixed", jsonIds(selected.toList()), pickerTag)
        work({ repo -> repo.db.runInTransaction { repo.saveProfile(profile); if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) repo.dao.putBinding(BindingRow(widgetId, profile.id)) }; Store.changed(this) }) {
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)); finish()
        }
    }
    override fun onWorkError() { if (::save.isInitialized) save.isEnabled = true }
    override fun onSaveInstanceState(outState: Bundle) { outState.putString("profileId", profileId); outState.putString("label", label.text.toString()); outState.putString("tags", jsonIds(selected.toList())); outState.putString("pickerTag", pickerTag); outState.putInt("mode", modes.checkedRadioButtonId); super.onSaveInstanceState(outState) }
}
