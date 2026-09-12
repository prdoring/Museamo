package com.prdoring.museamo

import android.os.Bundle
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import androidx.core.content.ContextCompat
import android.content.res.Configuration
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.appcompat.app.AppCompatActivity

abstract class NativeScreen : AppCompatActivity() {
    lateinit var body: LinearLayout
    lateinit var error: TextView
    val accent get() = if (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES) Color.rgb(163, 199, 165) else Color.rgb(65, 104, 79)
    fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val scroll = ScrollView(this).apply { isFillViewport = true }
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), dp(20), dp(22), dp(20)) }
        scroll.addView(body)
        setContentView(scroll)
        window.setLayout((resources.displayMetrics.widthPixels * .95).toInt().coerceAtMost(dp(540)), ViewGroup.LayoutParams.WRAP_CONTENT)
        window.setBackgroundDrawable(GradientDrawable().apply { setColor(ContextCompat.getColor(this@NativeScreen, R.color.widget_background)); cornerRadius = dp(22).toFloat() })
        window.setDimAmount(.24f)
        window.setGravity(Gravity.BOTTOM)
        error = TextView(this).apply { setTextColor(Color.rgb(190, 80, 65)); visibility = View.GONE; setPadding(0, dp(10), 0, dp(10)); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
    }
    fun title(text: String) { body.addView(TextView(this).apply { this.text = text; textSize = 25f; setTextColor(ContextCompat.getColor(this@NativeScreen, R.color.widget_text)); setTypeface(Typeface.SERIF); setPadding(0, 0, 0, dp(14)) }) }
    fun note(text: String) { body.addView(TextView(this).apply { this.text = text; textSize = 14f; setPadding(0, dp(6), 0, dp(12)) }) }
    fun button(text: String, action: () -> Unit): Button = Button(this).apply {
        this.text = text; textSize = 14f; isAllCaps = false; minHeight = dp(48); minimumHeight = dp(48)
        setPadding(dp(12), dp(8), dp(12), dp(8)); setTextColor(accent); elevation = 0f
        backgroundTintList = null
        background = GradientDrawable().apply { setColor(ContextCompat.getColor(this@NativeScreen, R.color.widget_soft)); cornerRadius = dp(12).toFloat() }
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6); bottomMargin = dp(6) }
        setOnClickListener { action() }
    }
    fun row(): LinearLayout = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    fun showError(e: Exception) { error.text = e.message ?: "Please try again. Your thought has not been discarded."; error.visibility = View.VISIBLE }
    fun <T> work(block: (Repository) -> T, done: (T) -> Unit) {
        Store.executor.execute {
            try { val result = block(Store.get(this)); runOnUiThread { if (!isDestroyed) done(result) } }
            catch (e: Exception) { runOnUiThread { if (!isDestroyed) { showError(e); onWorkError() } } }
        }
    }
    open fun onWorkError() {}
}
