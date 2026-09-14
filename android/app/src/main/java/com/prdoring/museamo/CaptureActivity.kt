package com.prdoring.museamo

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.WindowManager
import android.widget.*
import androidx.appcompat.app.AlertDialog
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class CaptureActivity : NativeScreen() {
    private var draft: DraftRow? = null
    private var committing = false
    private var finished = false
    private var selecting = false
    private lateinit var input: VisualThoughtInput
    private lateinit var send: Button
    private lateinit var chips: LinearLayout
    private lateinit var suggestions: LinearLayout
    private lateinit var suggestionScroll: ScrollView
    private var tags: List<TagRow> = emptyList()

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setResult(Activity.RESULT_CANCELED)
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (committing) return
                val insets = androidx.core.view.ViewCompat.getRootWindowInsets(window.decorView)
                if (insets?.isVisible(WindowInsetsCompat.Type.ime()) == true) WindowCompat.getInsetsController(window, window.decorView).hide(WindowInsetsCompat.Type.ime()) else finish()
            }
        })
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        val heading = row()
        heading.addView(heading("Message yourself"), LinearLayout.LayoutParams(0, -2, 1f))
        heading.addView(button("") { if (!committing) finish() }.apply { contentDescription = "Close and keep draft"; glyph(this, R.drawable.paper_close) }, LinearLayout.LayoutParams(dp(48), dp(48)))
        body.addView(heading)
        input = VisualThoughtInput(this).apply {
            selectionChanged = { if (::suggestionScroll.isInitialized) refreshSuggestions() }
            hint = "What’s on your mind?"; contentDescription = "Thought text"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            minLines = 2; maxLines = 6; textSize = 17f; gravity = android.view.Gravity.TOP
            setPadding(dp(4), dp(12), dp(4), dp(12)); background = PaperSurface(this@CaptureActivity, reading = true, radiusDp = 4f); typeface = writingFont; setTextColor(color(R.color.widget_thought)); setHintTextColor(color(R.color.widget_muted)); setLineSpacing(0f, 1.15f); isEnabled = false
        }
        body.addView(input)
        val formatting = row()
        fun quietControl(control: Button): Button = control.apply {
            background = android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT)
            setTextColor(color(R.color.widget_muted)); minWidth = dp(48); minimumWidth = dp(48)
        }
        val formatButton = quietControl(button("Aa") {}).apply {
            textSize = 18f; contentDescription = "Text formatting"
            setOnClickListener { anchor ->
                if (!committing && input.isEnabled && input.visibility == View.VISIBLE) {
                    val start = input.selectionStart.coerceAtLeast(0)
                    val end = input.selectionEnd.coerceAtLeast(0)
                    val options = listOf("bold" to "Bold", "italic" to "Italic", "bullet" to "Bulleted list", "number" to "Numbered list", "quote" to "Quote")
                    PopupMenu(this@CaptureActivity, anchor).apply {
                        options.forEachIndexed { index, (_, title) -> menu.add(0, index, index, title) }
                        setOnMenuItemClickListener { item ->
                            if (!committing && input.isEnabled) {
                                input.setSelection(start, end)
                                input.applyFormat(options[item.itemId].first); input.requestFocus()
                                draft = draft?.copy(text = input.markdown()); persist()
                            }
                            true
                        }
                        show()
                    }
                }
            }
        }
        formatting.addView(formatButton, LinearLayout.LayoutParams(dp(48), dp(48)))
        formatting.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        body.addView(formatting, LinearLayout.LayoutParams(-1, -2))
        suggestions = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        suggestionScroll = ScrollView(this).apply { addView(suggestions); visibility = View.GONE }
        body.addView(suggestionScroll, LinearLayout.LayoutParams(-1, dp(144)))
        chips = row()
        body.addView(HorizontalScrollView(this).apply { addView(chips); isHorizontalScrollBarEnabled = false })
        body.addView(error)
        val actions = row()
        actions.addView(button("···") { draftMenu() }.apply { contentDescription = "Draft actions" }, LinearLayout.LayoutParams(dp(48), dp(48)))
        actions.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        send = button("Send") { commit() }.apply { isEnabled = false; contentDescription = "Send thought"; primary(this); glyph(this, R.drawable.paper_send, R.color.widget_action_text) }
        actions.addView(send, LinearLayout.LayoutParams(-2, dp(48)))
        body.removeView(heading)
        val composer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        (contentScroll.parent as? android.view.ViewGroup)?.removeView(contentScroll)
        composer.addView(heading, LinearLayout.LayoutParams(-1, -2).apply { marginStart = dp(16); marginEnd = dp(16); topMargin = dp(8) })
        composer.addView(View(this).apply { setBackgroundColor(color(R.color.widget_text)) }, LinearLayout.LayoutParams(-1, dp(2)).apply { marginStart = dp(16); marginEnd = dp(16) })
        composer.addView(contentScroll, LinearLayout.LayoutParams(-1, -2, 1f))
        composer.addView(actions, LinearLayout.LayoutParams(-1, -2).apply { marginStart = dp(16); marginEnd = dp(16); bottomMargin = dp(16) })
        setContentView(composer)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(composer) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, 0, bars.right, if (insets.isVisible(WindowInsetsCompat.Type.ime())) 0 else bars.bottom)
            insets
        }
        val profileId = intent.getStringExtra("profileId")
        val initialTag = intent.getStringExtra("initialTag")
        val key = profileId ?: "app:${initialTag ?: "general"}"
        work({ repo -> val profile = profileId?.let { requireNotNull(repo.dao.profile(it)) { "Configure this widget again." } }; repo.draft(key, profile, initialTag) to repo.dao.tags() }) { (saved, allTags) ->
            tags = allTags
            draft = saved.copy(text = state?.getString("text") ?: saved.text, tagIds = jsonIds(ids(state?.getString("tagIds") ?: saved.tagIds).filter { id -> allTags.any { it.id == id } }))
            input.setMarkdown(draft!!.text)
            input.setSelection((state?.getInt("cursor", input.length()) ?: input.length()).coerceIn(0, input.length()))
            input.isEnabled = true; send.isEnabled = !input.text.isNullOrBlank()
            input.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) { draft = draft?.copy(text = input.markdown()); send.isEnabled = !committing && !s.isNullOrBlank(); persist(); input.post { updateChips(); refreshSuggestions() } }
            })
            updateChips(); input.requestFocus()
            input.post { WindowCompat.getInsetsController(window, input).show(WindowInsetsCompat.Type.ime()) }
        }
    }
    private fun refreshSuggestions() {
        if (!::input.isInitialized || committing) return
        suggestions.removeAllViews()
        val token = Hashtags.active(input.text.toString(), input.selectionStart)
        suggestionScroll.visibility = if (token == null) View.GONE else View.VISIBLE
        if (token == null) return
        tags.filter { it.name.startsWith(token.query, true) }.take(8).forEach { tag -> suggestions.addView(button("# ${tag.name}") { complete(tag.name, token) }) }
        if (token.query.isNotBlank() && tags.none { it.name.equals(token.query.trim(), true) }) suggestions.addView(button("Use new tag “${token.query.trim()}”") { complete(token.query.trim(), token) })
    }
    private fun complete(name: String, token: Hashtags.Token) {
        if (committing) return
        val value = Hashtags.token(name) + " "
        input.text?.replace(token.start, token.end, value); input.setSelection(token.start + value.length); input.requestFocus()
    }
    private fun updateChips() {
        chips.removeAllViews()
        val explicit = ids(draft?.tagIds ?: "[]")
        val inline = Hashtags.names(input.text.toString())
        val names = (tags.filter { it.id in explicit }.map { it.name } + inline).distinctBy { it.lowercase(java.util.Locale.ROOT) }
        names.forEach { name -> chips.addView(button("# $name") {
            if (!committing) {
                val tag = tags.find { it.name.equals(name, true) }
                draft = draft?.copy(tagIds = jsonIds(explicit - listOfNotNull(tag?.id)))
                val position = input.selectionStart
                input.removeHashtag(name); input.setSelection(position.coerceIn(0, input.length())); updateChips(); persist()
            }
        }.apply { contentDescription = "Remove tag $name"; selected(this); glyph(this, R.drawable.paper_close, R.color.widget_selection_text); isEnabled = !committing }, LinearLayout.LayoutParams(-2, dp(48)).apply { marginEnd = dp(4) }) }
        chips.addView(button("Add tag") { chooseTags() }.apply { glyph(this, R.drawable.paper_plus); isEnabled = !committing }, LinearLayout.LayoutParams(-2, dp(48)))
    }
    private fun chooseTags() {
        if (committing || selecting) return
        selecting = true
        work({ it.dao.tags() }) { allTags ->
            tags = allTags
            val panel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), 0, dp(16), 0) }
            val search = EditText(this).apply { hint = "Find or create a tag…"; contentDescription = "Find or create tag"; setSingleLine(true); typeface = font; filters = arrayOf(android.text.InputFilter.LengthFilter(80)) }
            styleField(search); panel.addView(search)
            val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            panel.addView(ScrollView(this).apply { addView(list) }, LinearLayout.LayoutParams(-1, dp(240)))
            val dialog = AlertDialog.Builder(this).setTitle("Tags").setView(panel).setPositiveButton("Done", null).create()
            dialog.setOnDismissListener { selecting = false; input.requestFocus() }
            fun render() {
                list.removeAllViews()
                val selected = ids(draft?.tagIds ?: "[]")
                val inline = Hashtags.names(input.text.toString())
                tags.filter { it.name.contains(search.text.toString(), true) }.forEach { tag ->
                    val checked = tag.id in selected || inline.any { it.equals(tag.name, true) }
                    list.addView(button((if (checked) "✓  " else "#  ") + tag.name) {
                        draft = draft?.copy(tagIds = jsonIds(if (checked) selected - tag.id else selected + tag.id))
                        if (checked) { input.removeHashtag(tag.name); input.setSelection(input.length()) }
                        updateChips(); persist(); render()
                    }.apply { if (checked) { selected(this); glyph(this, R.drawable.paper_check, R.color.widget_selection_text) } })
                }
                val name = search.text.toString().trim()
                if (name.isNotEmpty() && tags.none { it.name.equals(name, true) }) list.addView(button("Create “$name”") {
                    search.isEnabled = false; list.visibility = View.GONE
                    work({ repo -> runCatching { val tag = repo.dao.tags().find { it.name.equals(name, true) } ?: repo.saveTag(null, name); Store.changed(this); tag to repo.dao.tags() } }) { result ->
                        val pair = result.getOrElse { search.isEnabled = true; list.visibility = View.VISIBLE; search.error = it.message ?: "Could not create tag. Try again."; return@work }
                        val (tag, all) = pair
                        tags = all; draft = draft?.copy(tagIds = jsonIds(ids(draft!!.tagIds) + tag.id)); updateChips(); persist(); search.isEnabled = true; list.visibility = View.VISIBLE; search.setText(""); render()
                    }
                })
            }
            search.addTextChangedListener(object : TextWatcher { override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}; override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}; override fun afterTextChanged(s: Editable?) { render() } })
            render(); dialog.show()
        }
    }
    private fun draftMenu() {
        if (committing) return
        AlertDialog.Builder(this).setItems(arrayOf("Discard draft")) { _, _ -> AlertDialog.Builder(this).setTitle("Discard this draft?").setNegativeButton("Keep writing", null).setPositiveButton("Discard") { _, _ ->
            val current = draft ?: return@setPositiveButton
            committing = true
            work({ repo -> repo.dao.deleteDraft(current.profileKey); CaptureWidget.refresh(this) }) { finished = true; finish() }
        }.show() }.show()
    }
    private fun persist() {
        val current = draft ?: return
        if (committing || finished) return
        work({ it.saveDraft(current) }) {}
    }
    private fun commit() {
        val current = draft ?: return
        if (committing || current.text.isBlank()) return
        committing = true; setFinishOnTouchOutside(false); error.visibility = View.GONE; send.isEnabled = false; input.isEnabled = false; updateChips(); suggestionScroll.visibility = View.GONE
        work({ repo -> repo.commitDraft(current).also { Store.changed(this) } }) { saved ->
            finished = true
            send.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            setResult(Activity.RESULT_OK, Intent().putExtra("entryId", saved.id)); finish()
        }
    }
    override fun onWorkError() { setFinishOnTouchOutside(true); committing = false; selecting = false; if (::input.isInitialized) input.isEnabled = true; if (::send.isInitialized) { send.text = "Retry"; send.isEnabled = draft?.text?.isNotBlank() == true }; if (::chips.isInitialized) updateChips() }
    override fun onPause() { persist(); CaptureWidget.refresh(this); super.onPause() }
    override fun onSaveInstanceState(out: Bundle) { draft?.let { out.putString("text", it.text); out.putString("tagIds", it.tagIds); out.putInt("cursor", input.selectionStart) }; super.onSaveInstanceState(out) }
}
