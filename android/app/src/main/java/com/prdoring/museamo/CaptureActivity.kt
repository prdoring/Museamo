package com.prdoring.museamo

import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.text.InputType
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.content.Context
import android.widget.*
import androidx.appcompat.app.AlertDialog

class CaptureActivity : NativeScreen() {
    private var draft: DraftRow? = null
    private var committing = false
    private var finished = false
    private lateinit var input: EditText
    private lateinit var send: Button
    private lateinit var tagButton: Button
    private var tags: List<TagRow> = emptyList()

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE or WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
        title("A thought…")
        input = EditText(this).apply {
            id = View.generateViewId(); hint = "What crossed your mind?"; contentDescription = "Thought text"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            minLines = 3; maxLines = 8; textSize = 19f; gravity = android.view.Gravity.TOP
            setPadding(dp(6), dp(10), dp(6), dp(10)); isEnabled = false
        }
        body.addView(input)
        tagButton = button("No tag") { chooseTags() }; tagButton.isEnabled = false; body.addView(tagButton)
        body.addView(error)
        val actions = row()
        actions.addView(button("Discard") { AlertDialog.Builder(this).setTitle("Discard this draft?").setMessage("Your saved thoughts will remain.").setNegativeButton("Keep writing", null).setPositiveButton("Discard") { _, _ ->
            val current = draft ?: return@setPositiveButton
            committing = true
            work({ it.dao.deleteDraft(current.profileKey) }) { finished = true; finish() }
        }.show() }, LinearLayout.LayoutParams(0, -2, 1f))
        send = button("Send ↑") { commit() }.apply {
            isEnabled = false; contentDescription = "Send thought and return"
            backgroundTintList = android.content.res.ColorStateList(arrayOf(intArrayOf(android.R.attr.state_enabled), intArrayOf()), intArrayOf(android.graphics.Color.rgb(65, 104, 79), android.graphics.Color.rgb(162, 178, 161)))
            setTextColor(android.graphics.Color.WHITE)
        }
        actions.addView(send, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = dp(10) }); body.addView(actions)
        val profileId = intent.getStringExtra("profileId")
        val initialTag = intent.getStringExtra("initialTag")
        val key = profileId ?: "app:${initialTag ?: "general"}"
        work({ repo ->
            val profile = profileId?.let { requireNotNull(repo.dao.profile(it)) { "This widget needs to be configured again." } }
            Triple(repo.draft(key, profile, initialTag), repo.dao.tags(), profile)
        }) { (saved, allTags, _) ->
            tags = allTags
            // Saved-instance state closes the small lifecycle window before a queued draft write.
            draft = saved.copy(text = state?.getString("text") ?: saved.text, tagIds = state?.getString("tagIds")?.let { jsonIds(ids(it).filter { id -> allTags.any { t -> t.id == id } }) } ?: saved.tagIds)
            input.setText(draft!!.text); input.setSelection(input.length()); input.isEnabled = true; tagButton.isEnabled = true; updateTags()
            send.isEnabled = input.text.isNotBlank()
            input.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { draft = draft?.copy(text = s.toString()); send.isEnabled = !committing && !s.isNullOrBlank(); persist() }
                override fun afterTextChanged(s: Editable?) {}
            })
            input.requestFocus()
            input.postDelayed({ (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(input, InputMethodManager.SHOW_IMPLICIT) }, 120)
        }
    }
    private fun updateTags() {
        val selected = ids(draft?.tagIds ?: "[]")
        tagButton.text = tags.filter { it.id in selected }.joinToString("   ") { "# ${it.name}" }.ifEmpty { "No tag · change" }
        tagButton.contentDescription = "Edit tags: ${tagButton.text}"
    }
    private fun chooseTags() {
        work({ it.dao.tags() }) { available ->
            tags = available
            val selected = ids(draft?.tagIds ?: "[]").toMutableSet()
            AlertDialog.Builder(this).setTitle("Tags for this thought")
                .setMultiChoiceItems(tags.map { it.name }.toTypedArray(), tags.map { it.id in selected }.toBooleanArray()) { _, index, checked -> if (checked) selected.add(tags[index].id) else selected.remove(tags[index].id) }
                .setNeutralButton("No tag") { _, _ -> draft = draft?.copy(tagIds = "[]"); updateTags(); persist() }
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Done") { _, _ -> draft = draft?.copy(tagIds = jsonIds(selected.toList())); updateTags(); persist() }.show()
        }
    }
    private fun persist() {
        val current = draft ?: return
        if (committing || finished) return
        work({ it.saveDraft(current) }) {}
    }
    private fun commit() {
        val current = draft ?: return
        if (committing || current.text.isBlank()) return
        committing = true; send.isEnabled = false; input.isEnabled = false; tagButton.isEnabled = false
        work({ repo -> repo.commitDraft(current); Store.changed(this) }) {
            finished = true
            send.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            finish()
        }
    }
    override fun onWorkError() { committing = false; if (::input.isInitialized) input.isEnabled = true; if (::send.isInitialized) send.isEnabled = draft?.text?.isNotBlank() == true; if (::tagButton.isInitialized) tagButton.isEnabled = true }
    override fun onPause() { persist(); super.onPause() }
    override fun onSaveInstanceState(outState: Bundle) { draft?.let { outState.putString("text", it.text); outState.putString("tagIds", it.tagIds) }; super.onSaveInstanceState(outState) }
}
