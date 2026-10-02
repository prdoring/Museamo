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
    private lateinit var locationButton: Button
    private lateinit var locationStatus: TextView
    private var findingLocation = false
    private var locationMessage = ""
    private var manualLocationRequest = false
    private var permissionGrantedPending = false
    private val locationPermission = LocationPermission(this) { granted ->
        val manual = manualLocationRequest; manualLocationRequest = false
        if (granted) {
            if (draft == null) permissionGrantedPending = true else if (!committing && !finished) captureLocation(manual)
        } else if (manual) locationFeedback(if (!LocationCapture.servicesOn(this)) "Device location is off." else "Location permission was not granted. Allow it in Android app settings.")
    }
    private fun locationFeedback(message: String) {
        locationMessage = message; findingLocation = false; showLocation()
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }
    private fun locationAction() {
        if (committing || importingMedia) return
        if (findingLocation) {
            AlertDialog.Builder(this).setTitle("Adding location automatically")
                .setItems(arrayOf("Skip location for this post")) { _, _ -> removeLocation() }.show()
        } else if (draft?.location != null) locationMenu() else requestManualLocation()
    }
    private fun requestManualLocation() {
        manualLocationRequest = true
        locationPermission.request()
    }
    private var cancelLocation: (() -> Unit)? = null
    private var locationGeneration = 0
    private val resolvedLocations = mutableMapOf<String, String>()
    private fun showLocation() {
        if (!::locationButton.isInitialized) return
        locationButton.isEnabled = !committing && !importingMedia
        locationButton.contentDescription = if (findingLocation) "Adding location automatically. Tap to skip for this post" else "Post location"
        glyph(locationButton, R.drawable.paper_location, if (draft?.location != null) R.color.widget_accent else R.color.widget_muted)
        locationStatus.text = if (findingLocation) "Adding location automatically…" else if (locationMessage.isNotEmpty()) locationMessage else draft?.location?.let { PostLocation.label(it) } ?: ""
        locationStatus.visibility = if (locationStatus.text.isEmpty()) View.GONE else View.VISIBLE
    }
    private fun applyResolvedLocation() {
        val current = draft ?: return
        val next = current.location?.let { resolvedLocations[it] } ?: return
        draft = current.copy(location = next); persist(); showLocation()
    }
    private fun captureLocation(manual: Boolean = false) {
        val current = draft ?: return
        cancelLocation?.invoke()
        val generation = ++locationGeneration
        findingLocation = (manual || LocationCapture.enabled(this)) && LocationCapture.permitted(this) && LocationCapture.servicesOn(this); locationMessage = ""; showLocation()
        cancelLocation = LocationCapture.requestResult(this, automatic = !manual) { result ->
            if (generation != locationGeneration) return@requestResult
            findingLocation = false; showLocation()
            val value = result.location
            if (manual && value == null && result.status != "cancelled" && !committing && !finished) locationFeedback(when (result.status) {
                "services-off" -> "Device location is off."
                "permission-denied" -> "Location permission was not granted."
                "timeout" -> "Couldn’t find your location. Tap the pin to retry."
                else -> "Location is unavailable. Tap the pin to retry."
            })
            if (value != null && generation == locationGeneration && !committing && !finished && !isFinishing && draft?.entryId == current.entryId) {
                draft = draft?.copy(location = value, locationAttempted = true)
                persist(); showLocation()
                LocationCapture.resolve(applicationContext, value) { enriched ->
                    resolvedLocations[value] = enriched
                    if (!committing && !finished && !isDestroyed && !importingMedia) applyResolvedLocation()
                    // Serialize after any commit, and compare the whole original value. Edits/removal win.
                    val app = applicationContext
                    Store.executor.execute {
                        val repo = Store.get(app)
                        if (repo.enrichLocation(current.entryId, value, enriched)) Store.changed(app)
                    }
                }
            }
        }
    }
    private fun removeLocation() {
        ++locationGeneration
        cancelLocation?.invoke(); cancelLocation = null
        draft = draft?.copy(location = null, locationAttempted = true)
        locationMessage = "Location skipped for this post"
        findingLocation = false
        persist(); showLocation()
    }
    private fun locationMenu() {
        if (committing || importingMedia) return
        val options = if (draft?.location == null) arrayOf("Use current location") else arrayOf("Refresh location", "Edit name", "Remove location")
        AlertDialog.Builder(this).setTitle("Location").setItems(options) { _, which ->
            when (which) {
                0 -> requestManualLocation()
                1 -> {
                    val field = EditText(this).apply { hint = "Place name"; setSingleLine(); filters = arrayOf(android.text.InputFilter.LengthFilter(500)); setText(draft?.location?.let { org.json.JSONObject(it).optString("userLabel") }) }
                    AlertDialog.Builder(this).setTitle("Place name").setView(field).setNegativeButton("Cancel", null).setPositiveButton("Save") { _, _ ->
                        draft?.location?.let { value -> draft = draft?.copy(location = org.json.JSONObject(value).put("userLabel", field.text.toString().trim()).toString()); persist(); showLocation() }
                    }.show()
                }
                2 -> removeLocation()
            }
        }.show()
    }
    private var draft: DraftRow? = null
    private var committing = false
    private var finished = false
    private var selecting = false
    private var importingMedia = false
    private lateinit var mediaStrip: LinearLayout
    private lateinit var attachButton: Button
    private var pendingMedia: List<android.net.Uri>? = null
    private val pickMedia = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia(10)) { receiveMedia(it) }
    private fun receiveMedia(uris: List<android.net.Uri>) {
        val current = draft
        if (current == null) { pendingMedia = uris; return }
        if (uris.isEmpty()) { importingMedia = false; refreshMedia(); return }
        importingMedia = true; input.isEnabled = false; send.isEnabled = false; attachButton.isEnabled = false
        error.text = "Importing media…"; error.visibility = View.VISIBLE
        work({ repo ->
            val files = MediaFiles(this, repo)
            val live = requireNotNull(repo.dao.draft(current.profileKey)) { "This draft was discarded." }
            val added = files.import(uris, 10 - ids(live.mediaIds).size)
            try {
                val next = live.copy(mediaIds = jsonIds(ids(live.mediaIds) + added.map { it.id }))
                repo.saveDraft(next)
                added.forEach { repo.mediaPins.remove(it.id) }
                next
            } catch (e: Exception) { added.forEach { repo.mediaPins.remove(it.id) }; files.cleanup(); throw e }
        }) { saved ->
            draft = saved.copy(location = draft?.location, locationAttempted = true); importingMedia = false; applyResolvedLocation(); showLocation(); input.isEnabled = true; error.visibility = View.GONE; refreshMedia()
        }
    }
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
        heading.addView(heading("Message yourself").apply { textSize = 20f }, LinearLayout.LayoutParams(0, -2, 1f))
        heading.addView(button("···") { draftMenu() }.apply { contentDescription = "Draft actions"; background = android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT) }, LinearLayout.LayoutParams(dp(44), dp(48)))
        heading.addView(button("") { if (!committing) finish() }.apply { contentDescription = "Close and keep draft"; glyph(this, R.drawable.paper_close); background = android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT) }, LinearLayout.LayoutParams(dp(44), dp(48)))
        body.addView(heading)
        input = VisualThoughtInput(this).apply {
            selectionChanged = { if (::suggestionScroll.isInitialized) refreshSuggestions() }
            hint = "What’s on your mind?"; contentDescription = "Thought text"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            minLines = 5; maxLines = 10; textSize = 17f; gravity = android.view.Gravity.TOP
            setPadding(dp(4), dp(12), dp(4), dp(12)); background = PaperSurface(this@CaptureActivity, reading = true, radiusDp = 4f); typeface = writingFont; setTextColor(color(R.color.widget_thought)); setHintTextColor(color(R.color.widget_muted)); setLineSpacing(0f, 1.15f); isEnabled = false
        }
        body.addView(input)
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
        attachButton = quietControl(button("") {
            if (!committing && !importingMedia && draft != null) {
                persist(); importingMedia = true; attachButton.isEnabled = false
                pickMedia.launch(androidx.activity.result.PickVisualMediaRequest(androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia.ImageAndVideo))
            }
        }).apply { isEnabled = false; contentDescription = "Attach photos/videos"; glyph(this, R.drawable.paper_photo) }
        mediaStrip = row()
        body.addView(HorizontalScrollView(this).apply { addView(mediaStrip); isHorizontalScrollBarEnabled = false })
        suggestions = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        suggestionScroll = ScrollView(this).apply { addView(suggestions); visibility = View.GONE }
        body.addView(suggestionScroll, LinearLayout.LayoutParams(-1, dp(144)))
        chips = row()
        body.addView(HorizontalScrollView(this).apply { addView(chips); isHorizontalScrollBarEnabled = false })
        locationStatus = label("", 12).apply { visibility = View.GONE; maxLines = 2; setTextColor(color(R.color.widget_muted)); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        body.addView(locationStatus)
        locationButton = quietControl(button("") { locationAction() }).apply { contentDescription = "Post location"; glyph(this, R.drawable.paper_location, R.color.widget_muted) }
        body.addView(error)
        val actions = row()
        actions.addView(attachButton, LinearLayout.LayoutParams(dp(48), dp(48)))
        actions.addView(formatButton, LinearLayout.LayoutParams(dp(48), dp(48)))
        actions.addView(quietControl(button("#") { chooseTags() }).apply { contentDescription = "Add tag"; textSize = 22f }, LinearLayout.LayoutParams(dp(48), dp(48)))
        actions.addView(locationButton, LinearLayout.LayoutParams(dp(48), dp(48)))
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
        work({ repo -> val profile = profileId?.let { requireNotNull(repo.dao.profile(it)) { "Configure this widget again." } }; repo.prepareCaptureDraft(key, profile, initialTag, resuming = state != null) to repo.dao.tags() }) { (opening, allTags) ->
            val saved = opening.draft
            tags = allTags
            draft = saved.copy(text = state?.getString("text") ?: saved.text, tagIds = jsonIds(ids(state?.getString("tagIds") ?: saved.tagIds).filter { id -> allTags.any { it.id == id } }))
            draft = draft!!.copy(locationAttempted = true)
            persist(); showLocation()
            if (opening.captureLocation || permissionGrantedPending) {
                permissionGrantedPending = false
                if (LocationCapture.available(this)) captureLocation() else locationPermission.onOpen()
            }
            input.setMarkdown(draft!!.text)
            input.setSelection((state?.getInt("cursor", input.length()) ?: input.length()).coerceIn(0, input.length()))
            input.isEnabled = true; send.isEnabled = hasContent()
            input.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) { draft = draft?.copy(text = input.markdown()); send.isEnabled = !committing && !importingMedia && hasContent(); persist(); input.post { updateChips(); refreshSuggestions() } }
            })
            updateChips(); refreshMedia(); input.requestFocus()
            pendingMedia?.let { pendingMedia = null; receiveMedia(it) }
            input.post { WindowCompat.getInsetsController(window, input).show(WindowInsetsCompat.Type.ime()) }
        }
    }
    private fun hasContent() = draft?.let { it.text.isNotBlank() || ids(it.mediaIds).isNotEmpty() } == true
    private fun refreshMedia() {
        if (!::mediaStrip.isInitialized) return
        val current = draft ?: return
        attachButton.isEnabled = !committing && !importingMedia && ids(current.mediaIds).size < 10
        send.isEnabled = !committing && !importingMedia && hasContent()
        work({ repo -> ids(current.mediaIds).mapNotNull { repo.dao.media(it) }.map { row ->
            row to android.graphics.BitmapFactory.decodeFile(MediaFiles(this, repo).thumbnail(row.id).path)
        } }) { items ->
            mediaStrip.removeAllViews()
            items.forEach { (item, bitmap) ->
                val panel = FrameLayout(this)
                panel.addView(ImageView(this).apply { setImageBitmap(bitmap); contentDescription = item.filename; scaleType = ImageView.ScaleType.CENTER_CROP; background = PaperSurface(this@CaptureActivity, reading = true, radiusDp = 8f); clipToOutline = true }, FrameLayout.LayoutParams(-1, -1))
                if (item.kind == "video") panel.addView(TextView(this).apply { text = "Video"; textSize = 11f; setTextColor(android.graphics.Color.WHITE); setBackgroundColor(0x99000000.toInt()); setPadding(dp(4), dp(2), dp(4), dp(2)) }, FrameLayout.LayoutParams(-2, -2, android.view.Gravity.BOTTOM or android.view.Gravity.START))
                panel.addView(button("×") {
                    if (!committing && !importingMedia) { draft = draft?.copy(mediaIds = jsonIds(ids(draft!!.mediaIds) - item.id)); persist(); refreshMedia() }
                }.apply { contentDescription = "Remove "+item.filename; isEnabled = !committing && !importingMedia; textSize = 24f; minWidth = 0; minimumWidth = 0; setPadding(0, 0, 0, 0); setTextColor(android.graphics.Color.WHITE); background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(0xBB000000.toInt()) } }, FrameLayout.LayoutParams(dp(44), dp(44), android.view.Gravity.TOP or android.view.Gravity.END))
                mediaStrip.addView(panel, LinearLayout.LayoutParams(dp(88), dp(88)).apply { marginEnd = dp(8); topMargin = dp(8); bottomMargin = dp(8) })
            }
        }
    }
    private fun refreshSuggestions() {
        if (!::input.isInitialized || committing) return
        suggestions.removeAllViews()
        val token = Hashtags.active(input.text.toString(), input.selectionStart)
        suggestionScroll.visibility = if (token == null) View.GONE else View.VISIBLE
        if (token == null) return
        tags.filter { it.name.startsWith(token.query, true) }.take(8).forEach { tag -> suggestions.addView(button(android.text.TextUtils.concat("# ", tag.displayLabel(this))) { complete(tag.name, token) }.apply { contentDescription = tag.accessibleLabel() }) }
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
        names.forEach { name ->
            val displayTag = tags.find { it.name.equals(name, true) }
            chips.addView(button(android.text.TextUtils.concat("# ", displayTag?.displayLabel(this, R.color.widget_selection_text) ?: name)) {
            if (!committing) {
                val tag = tags.find { it.name.equals(name, true) }
                draft = draft?.copy(tagIds = jsonIds(explicit - listOfNotNull(tag?.id)))
                val position = input.selectionStart
                input.removeHashtag(name); input.setSelection(position.coerceIn(0, input.length())); updateChips(); persist()
            }
        }.apply { contentDescription = "Remove tag ${displayTag?.accessibleLabel() ?: name}"; selected(this); glyph(this, R.drawable.paper_close, R.color.widget_selection_text); isEnabled = !committing }, LinearLayout.LayoutParams(-2, dp(48)).apply { marginEnd = dp(4) }) }
        (chips.parent as View).visibility = if (names.isEmpty()) View.GONE else View.VISIBLE
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
                    list.addView(button(android.text.TextUtils.concat(if (checked) "✓  " else "#  ", tag.displayLabel(this, if (checked) R.color.widget_selection_text else R.color.widget_text))) {
                        draft = draft?.copy(tagIds = jsonIds(if (checked) selected - tag.id else selected + tag.id))
                        if (checked) { input.removeHashtag(tag.name); input.setSelection(input.length()) }
                        updateChips(); persist(); render()
                    }.apply { contentDescription = tag.accessibleLabel() + if (checked) ", selected" else ""; if (checked) { selected(this); glyph(this, R.drawable.paper_check, R.color.widget_selection_text) } })
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
            work({ repo -> repo.dao.deleteDraft(current.profileKey); MediaFiles(this, repo).cleanup(); CaptureWidget.refresh(this) }) { finished = true; finish() }
        }.show() }.show()
    }
    private fun persist() {
        val current = draft ?: return
        if (committing || finished || importingMedia) return
        work({ it.saveDraft(current) }) {}
    }
    private fun commit() {
        applyResolvedLocation()
        val current = draft ?: return
        if (committing || importingMedia || !hasContent()) return
        committing = true; setFinishOnTouchOutside(false); error.visibility = View.GONE; send.isEnabled = false; input.isEnabled = false; updateChips(); suggestionScroll.visibility = View.GONE
        work({ repo -> repo.commitDraft(current).also { Store.changed(this) } }) { saved ->
            finished = true
            send.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
            setResult(Activity.RESULT_OK, Intent().putExtra("entryId", saved.id)); finish()
        }
    }
    override fun onWorkError() { setFinishOnTouchOutside(true); committing = false; selecting = false; importingMedia = false; if (::input.isInitialized) input.isEnabled = true; if (::send.isInitialized) { send.text = "Retry"; send.isEnabled = hasContent() }; if (::chips.isInitialized) updateChips(); if (::attachButton.isInitialized) attachButton.isEnabled = true }
    override fun onPause() { ++locationGeneration; cancelLocation?.invoke(); cancelLocation = null; findingLocation = false; showLocation(); persist(); CaptureWidget.refresh(this); super.onPause() }
    override fun onSaveInstanceState(out: Bundle) { draft?.let { out.putString("text", it.text); out.putString("tagIds", it.tagIds); out.putInt("cursor", input.selectionStart) }; super.onSaveInstanceState(out) }
}
