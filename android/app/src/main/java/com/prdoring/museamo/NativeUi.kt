package com.prdoring.museamo

import android.os.Bundle
import android.graphics.drawable.GradientDrawable
import androidx.core.content.ContextCompat
import androidx.core.content.res.ResourcesCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.appcompat.app.AppCompatActivity

abstract class NativeScreen : AppCompatActivity() {
    lateinit var body: LinearLayout
    lateinit var error: TextView
    protected lateinit var contentScroll: ScrollView
    protected open val floatingSurface: Boolean = true
    val accent get() = ContextCompat.getColor(this, R.color.widget_accent)
    val font get() = ResourcesCompat.getFont(this, R.font.dm_sans)
    val headingFont get() = ResourcesCompat.getFont(this, R.font.trailhead_clean)
    val writingFont get() = ResourcesCompat.getFont(this, R.font.source_serif)
    fun color(id: Int) = ContextCompat.getColor(this, id)
    fun heading(text: String) = label(text, 24).apply { typeface = headingFont; letterSpacing = .035f }
    fun styleField(field: EditText) { field.setTextColor(color(R.color.widget_text)); field.setHintTextColor(color(R.color.widget_muted)); field.backgroundTintList = null; field.background = android.graphics.drawable.GradientDrawable().apply { setColor(color(R.color.widget_surface)); setStroke(dp(2), color(R.color.widget_text)); cornerRadius = dp(4).toFloat() }; field.setPadding(dp(12), dp(10), dp(12), dp(10)); field.minHeight = dp(48) }
    fun primary(button: Button) { button.backgroundTintList = null; button.background = GradientDrawable().apply { setColor(color(R.color.widget_action_bg)); cornerRadius = dp(4).toFloat() }; button.setTextColor(color(R.color.widget_action_text)) }
    fun selected(button: Button) { button.backgroundTintList = null; button.background = GradientDrawable().apply { setColor(color(R.color.widget_selection_bg)); cornerRadius = dp(4).toFloat() }; button.setTextColor(color(R.color.widget_selection_text)) }
    fun glyph(button: Button, id: Int, tint: Int = R.color.widget_text) { val icon = ContextCompat.getDrawable(this, id)!!.mutate(); androidx.core.graphics.drawable.DrawableCompat.setTint(icon, color(tint)); icon.setBounds(0, 0, dp(20), dp(20)); button.setCompoundDrawablesRelative(icon, null, null, null); button.compoundDrawablePadding = dp(8) }
    fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val scroll = ScrollView(this).apply { isFillViewport = false; isFocusableInTouchMode = true }
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(8), dp(16), dp(16)) }
        contentScroll = scroll
        scroll.addView(body)
        setContentView(scroll)
        if (floatingSurface) {
        window.setLayout(resources.displayMetrics.widthPixels.coerceAtMost(dp(640)), ViewGroup.LayoutParams.WRAP_CONTENT)
        window.setBackgroundDrawable(PaperSurface(this, radiusDp = 12f, border = true))
        window.setDimAmount(.24f); window.setGravity(Gravity.BOTTOM)
        } else {
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            window.setBackgroundDrawable(PaperSurface(this))
            scroll.isFillViewport = true
        }
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, if (floatingSurface) 0 else bars.top, bars.right, if (insets.isVisible(WindowInsetsCompat.Type.ime())) 0 else bars.bottom)
            insets
        }
        error = label("", 14).apply { setBackgroundColor(color(R.color.widget_surface)); setTextColor(ContextCompat.getColor(this@NativeScreen, R.color.widget_danger)); visibility = View.GONE; setPadding(0, dp(10), 0, dp(10)); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
    }
    fun label(text: String, size: Int = 17): TextView = TextView(this).apply { this.text = text; textSize = size.toFloat(); typeface = font; setTextColor(ContextCompat.getColor(this@NativeScreen, R.color.widget_text)) }
    fun title(text: String) { body.addView(heading(text).apply { setPadding(0, dp(8), 0, dp(16)) }); body.addView(View(this).apply { setBackgroundColor(color(R.color.widget_text)) }, LinearLayout.LayoutParams(-1, dp(2))) }
    fun note(text: String) { body.addView(label(text, 14).apply { setTextColor(ContextCompat.getColor(this@NativeScreen, R.color.widget_muted)); setPadding(0, dp(6), 0, dp(12)) }) }
    fun button(text: String, action: () -> Unit): Button = object : androidx.appcompat.widget.AppCompatButton(this) {
        override fun drawableStateChanged() { super.drawableStateChanged(); alpha = if (isEnabled) 1f else .5f }
    }.apply {
        this.text = text; textSize = 14f; typeface = font; isAllCaps = false; minHeight = dp(48); minimumHeight = dp(48)
        setPadding(dp(12), dp(8), dp(12), dp(8)); setTextColor(color(R.color.widget_text)); elevation = 0f
        backgroundTintList = null
        background = GradientDrawable().apply { setColor(color(R.color.widget_surface)); setStroke(dp(2), color(R.color.widget_text)); cornerRadius = dp(4).toFloat() }
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(4); bottomMargin = dp(4) }
        setOnFocusChangeListener { view, focused -> view.foreground = if (focused) GradientDrawable().apply { setColor(android.graphics.Color.TRANSPARENT); setStroke(dp(3), color(R.color.widget_focus)); cornerRadius = dp(4).toFloat() } else null }
        setOnClickListener { action() }
    }
    fun row(): LinearLayout = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    fun showError(e: Exception) { error.text = "! " + (e.message ?: "Please try again. Your writing is still here."); error.visibility = View.VISIBLE }
    fun <T> work(block: (Repository) -> T, done: (T) -> Unit) {
        Store.executor.execute {
            try { val result = block(Store.get(this)); runOnUiThread { if (!isDestroyed) done(result) } }
            catch (e: Exception) { runOnUiThread { if (!isDestroyed) { showError(e); onWorkError() } } }
        }
    }
    open fun onWorkError() {}
}
