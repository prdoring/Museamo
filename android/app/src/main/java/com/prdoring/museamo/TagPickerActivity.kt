package com.prdoring.museamo

import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.widget.EditText
import android.widget.LinearLayout

class TagPickerActivity : NativeScreen() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        title("Follow a thread")
        val search = EditText(this).apply { hint = "Find a tag…"; contentDescription = "Search available tags"; setSingleLine(true) }
        body.addView(search); body.addView(error)
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; body.addView(list)
        val profileId = intent.getStringExtra("profileId") ?: run { finish(); return }
        work({ repo -> repo.dao.tags() to requireNotNull(repo.dao.profile(profileId)) { "Configure this widget again." } }) { (tags, profile) ->
            fun render() {
                list.removeAllViews()
                fun option(id: String?, name: String) { list.addView(button((if (id == profile.selectedTagId) "✓  " else "") + name) {
                    list.isEnabled = false
                    work({ repo -> val current = requireNotNull(repo.dao.profile(profileId)); repo.saveProfile(current.copy(selectedTagId = id)); Store.changed(this) }) { finish() }
                }) }
                option(null, "No tag")
                tags.filter { it.name.contains(search.text.toString(), ignoreCase = true) }.forEach { option(it.id, it.name) }
            }
            search.addTextChangedListener(object : TextWatcher { override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}; override fun afterTextChanged(s: Editable?) { render() }; override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {} })
            render()
        }
    }
}
