package com.prdoring.museamo

import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.widget.EditText
import android.widget.LinearLayout

class TagPickerActivity : NativeScreen() {
    private var saving = false
    override fun onWorkError() { saving = false }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        title("Choose tag")
        window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or android.view.WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        val search = EditText(this).apply { hint = "Find a tag…"; contentDescription = "Search available tags"; setSingleLine(true); typeface = font }
        styleField(search); body.addView(search); body.addView(error)
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(list)
        val profileId = intent.getStringExtra("profileId") ?: run { finish(); return }
        work({ repo -> repo.dao.tags() to requireNotNull(repo.dao.profile(profileId)) { "Configure this widget again." } }) { (tags, profile) ->
            fun render() {
                list.removeAllViews()
                fun option(id: String?, name: String) { list.addView(button(name) {
                    if (!saving) {
                    saving = true
                    work({ repo -> val current = requireNotNull(repo.dao.profile(profileId)); repo.saveProfile(current.copy(selectedTagId = id)); Store.changed(this) }) { finish() }
                    }
                }.apply { if (id == profile.selectedTagId) { selected(this); glyph(this, R.drawable.paper_check, R.color.widget_selection_text) } }) }
                option(null, "No tag")
                tags.filter { it.name.contains(search.text.toString(), ignoreCase = true) }.forEach { option(it.id, it.name) }
            }
            search.addTextChangedListener(object : TextWatcher { override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}; override fun afterTextChanged(s: Editable?) { render() }; override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {} })
            render()
        }
    }
}
