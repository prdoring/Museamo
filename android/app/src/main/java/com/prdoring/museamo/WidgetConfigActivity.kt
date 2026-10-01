package com.prdoring.museamo

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import android.widget.*
import androidx.appcompat.app.AlertDialog

class WidgetConfigActivity : NativeScreen() {
    override val floatingSurface = false
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID
    private var profileId = uid()
    private var tags: List<TagRow> = emptyList()
    private var selected = mutableSetOf<String>()
    private var pickerTag: String? = null
    private lateinit var labelInput: EditText
    private lateinit var modes: RadioGroup
    private lateinit var tagsButton: Button
    private lateinit var save: Button
    private var editing = false
    private lateinit var preview: TextView
    private lateinit var modeHelp: TextView
    private var saving = false
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID && intent.getStringExtra("profileId") == null) { finish(); return }
        window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        title("Make this widget yours")
        note("A shortcut for sending yourself thoughts. Everything saves to Museamo on this phone.")
        body.addView(label("Homescreen preview", 14))

        preview = label("Message yourself…", 17).apply { setPadding(dp(16), dp(16), dp(16), dp(16)); typeface = android.graphics.Typeface.DEFAULT; background = PaperSurface(this@WidgetConfigActivity) }
        body.addView(preview)
        note("Tap the message area to write. The ↗ button opens the app.")
        body.addView(label("Label on your homescreen", 17))
        note("For example: Shower thoughts or Words to remember.")
        labelInput = EditText(this).apply { hint = "Widget name"; contentDescription = "Widget name"; setSingleLine(true); filters = arrayOf(android.text.InputFilter.LengthFilter(80)) }
        body.addView(labelInput)
        labelInput.typeface = font; styleField(labelInput)
        labelInput.addTextChangedListener(object : android.text.TextWatcher { override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}; override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { updateTags() }; override fun afterTextChanged(s: android.text.Editable?) {} })
        body.addView(label("How should tags work?", 17).apply { setPadding(0, dp(20), 0, dp(8)) })
        modes = RadioGroup(this)
        modes.addView(RadioButton(this).apply { id = R.id.mode_fixed; text = "Use the same tags each time"; typeface = font; minHeight = dp(48) })
        modes.addView(RadioButton(this).apply { id = R.id.mode_picker; text = "Choose a tag on the widget"; typeface = font; minHeight = dp(48) })
        modes.check(R.id.mode_fixed); body.addView(modes)
        modeHelp = label("", 14).apply { setTextColor(androidx.core.content.ContextCompat.getColor(this@WidgetConfigActivity, R.color.widget_muted)); setPadding(0, dp(8), 0, dp(12)) }
        body.addView(modeHelp)
        modes.setOnCheckedChangeListener { _, _ -> updateTags() }
        tagsButton = button("No tag") { chooseTags() }; body.addView(tagsButton)
        body.addView(button("＋ Create a new tag") {
            val name = EditText(this).apply { hint = "Tag name"; contentDescription = "New tag name"; setSingleLine(true); typeface = font; filters = arrayOf(android.text.InputFilter.LengthFilter(80)) }
            styleField(name)
            val dialog = AlertDialog.Builder(this).setTitle("New tag").setView(name).setNegativeButton("Cancel", null).setPositiveButton("Create", null).create()
            dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                work({ repo -> runCatching { val tag = repo.saveTag(null, name.text.toString()); Store.changed(this); tag to repo.dao.tags() } }) { result ->
                    result.fold(onSuccess = { (tag, all) -> tags = all; if (modes.checkedRadioButtonId == R.id.mode_picker) pickerTag = tag.id else selected.add(tag.id); updateTags(); dialog.dismiss() }, onFailure = { name.error = it.message; dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true })
                }
            } }; dialog.show()
        })
        body.addView(error)
        save = button("Add widget") { saveConfiguration() }; save.isEnabled = false; primary(save)
        val actions = row()
        actions.addView(button("Cancel") { if (!saving) finish() }, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(8) })
        actions.addView(save, LinearLayout.LayoutParams(0, -2, 1f))
        val screen = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        (contentScroll.parent as? android.view.ViewGroup)?.removeView(contentScroll)
        screen.addView(contentScroll, LinearLayout.LayoutParams(-1, 0, 1f))
        screen.addView(actions, LinearLayout.LayoutParams(-1, -2).apply { marginStart = dp(16); marginEnd = dp(16); bottomMargin = dp(12) })
        setContentView(screen)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(contentScroll) { _, insets -> insets }
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(screen) { view, insets ->
            val bars = insets.getInsets(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, if (insets.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime())) 0 else bars.bottom)
            insets
        }
        work({ repo -> Triple(repo.dao.tags(), intent.getStringExtra("profileId")?.let { repo.dao.profile(it) } ?: repo.dao.binding(widgetId)?.let { repo.dao.profile(it.profileId) }, repo.dao.profiles()) }) { (allTags, current, profiles) ->
            tags = allTags
            if (current != null) { editing = true; save.text = "Save changes"; profileId = current.id; applyProfile(current) } else labelInput.setText("Message yourself…")
            if (state != null) { profileId = state.getString("profileId") ?: profileId; labelInput.setText(state.getString("label")); selected = ids(state.getString("tags") ?: "[]").toMutableSet(); pickerTag = state.getString("pickerTag"); modes.check(state.getInt("mode", R.id.mode_fixed)) }
            if (!editing && profiles.isNotEmpty()) {
                val copy = button("Copy settings from another widget…") { AlertDialog.Builder(this).setTitle("Copy settings from which widget?").setItems(profiles.map { it.label }.toTypedArray()) { _, which -> applyProfile(profiles[which]) }.show() }
                body.addView(copy)
            }
            updateTags(); save.isEnabled = true
        }
    }
    private fun applyProfile(p: ProfileRow) { labelInput.setText(p.label); selected = ids(p.tagIds).toMutableSet(); pickerTag = p.selectedTagId; modes.check(if (p.mode == "picker") R.id.mode_picker else R.id.mode_fixed); updateTags() }
    private fun updateTags() {
        if (!::tagsButton.isInitialized) return
        modeHelp.text = if (modes.checkedRadioButtonId == R.id.mode_picker) "Adds a tag picker to the widget. Choose one tag on your homescreen before writing. You can add or change tags in the composer." else "New thoughts start with the tags below. Choose none for a general-purpose widget. You can still change tags while writing."
        val startingTag = tags.find { it.id == pickerTag }
        preview.text = android.text.TextUtils.concat(labelInput.text, if (modes.checkedRadioButtonId == R.id.mode_picker) android.text.TextUtils.concat("     # ", startingTag?.displayLabel(this) ?: "No tag", " ▾") else "", "     ↗")
        val defaults = tags.filter { it.id in selected }
        tagsButton.text = if (modes.checkedRadioButtonId == R.id.mode_picker) android.text.TextUtils.concat("Starting tag: ", startingTag?.displayLabel(this) ?: "No tag")
            else android.text.TextUtils.concat("Default tags: ", if (defaults.isEmpty()) "None — choose tags" else android.text.TextUtils.concat(*defaults.flatMapIndexed { index, tag -> listOf<CharSequence>(if (index > 0) ", " else "", tag.displayLabel(this)) }.toTypedArray()))
    }
    private fun chooseTags() {
        if (modes.checkedRadioButtonId == R.id.mode_picker) {
            AlertDialog.Builder(this).setTitle("Tag selected when this widget is added").setSingleChoiceItems((listOf<CharSequence>("No tag") + tags.map { it.displayLabel(this) }).toTypedArray(), tags.indexOfFirst { it.id == pickerTag } + 1) { dialog, index -> pickerTag = if (index == 0) null else tags[index - 1].id; updateTags(); dialog.dismiss() }.setNegativeButton("Cancel", null).show()
        } else {
            val draftTags = selected.toMutableSet()
            AlertDialog.Builder(this).setTitle("Tags for new thoughts").setMultiChoiceItems(tags.map { it.displayLabel(this) }.toTypedArray(), tags.map { it.id in selected }.toBooleanArray()) { _, index, checked -> if (checked) draftTags.add(tags[index].id) else draftTags.remove(tags[index].id) }.setPositiveButton("Done") { _, _ -> selected = draftTags; updateTags() }.setNegativeButton("Cancel", null).setNeutralButton("No tag") { _, _ -> selected.clear(); updateTags() }.show()
        }
    }
    private fun saveConfiguration() {
        if (saving) return
        saving = true; save.isEnabled = false
        val profile = ProfileRow(profileId, labelInput.text.toString(), if (modes.checkedRadioButtonId == R.id.mode_picker) "picker" else "fixed", jsonIds(selected.toList()), pickerTag)
        work({ repo -> repo.db.runInTransaction { repo.saveProfile(profile); if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) repo.dao.putBinding(BindingRow(widgetId, profile.id)) }; if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) CaptureWidget.render(this, widgetId); Store.changed(this) }) {
            androidx.core.view.WindowCompat.getInsetsController(window, body).hide(androidx.core.view.WindowInsetsCompat.Type.ime())
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)); finish()
        }
    }
    override fun onWorkError() { saving = false; if (::save.isInitialized) save.isEnabled = true }
    override fun onSaveInstanceState(outState: Bundle) { if (!::labelInput.isInitialized) { super.onSaveInstanceState(outState); return }; outState.putString("profileId", profileId); outState.putString("label", labelInput.text.toString()); outState.putString("tags", jsonIds(selected.toList())); outState.putString("pickerTag", pickerTag); outState.putInt("mode", modes.checkedRadioButtonId); super.onSaveInstanceState(outState) }
}
