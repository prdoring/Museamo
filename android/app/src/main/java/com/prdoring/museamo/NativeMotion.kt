package com.prdoring.museamo

import android.animation.LayoutTransition
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import java.util.WeakHashMap

/** Keyed native children avoid replaying transitions for every editor keystroke. */
object NativeMotion {
    private val populated = WeakHashMap<ViewGroup, Boolean>()
    private val visibility = WeakHashMap<View, Boolean>()
    private fun enabled(view: View) = Settings.Global.getFloat(view.context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f
    fun reconcile(group: ViewGroup, keys: List<String>, create: (String) -> View, bind: (View, String) -> Unit, animate: Boolean = true) {
        val existing = (0 until group.childCount).map { group.getChildAt(it) }
        val changed = existing.map { it.tag } != keys
        if (changed) group.layoutTransition = if (animate && populated[group] == true && enabled(group)) LayoutTransition().apply {
            setDuration(200); setDuration(LayoutTransition.APPEARING, 180); setDuration(LayoutTransition.DISAPPEARING, 160)
            setAnimateParentHierarchy(false)
        } else null
        existing.filter { it.tag !in keys }.forEach { group.removeView(it) }
        keys.forEachIndexed { index, key ->
            val view = existing.find { it.tag == key } ?: create(key).apply { tag = key }
            if (view.parent == null) group.addView(view, index)
            else if (group.indexOfChild(view) != index) { group.removeView(view); group.addView(view, index) }
            bind(view, key)
        }
        populated[group] = true
    }
    fun show(view: View, show: Boolean) {
        if (visibility[view] == show) return
        visibility[view] = show
        view.animate().cancel()
        if (!enabled(view)) { view.visibility = if (show) View.VISIBLE else View.GONE; view.alpha = 1f; view.translationY = 0f; view.importantForAccessibility = if (show) View.IMPORTANT_FOR_ACCESSIBILITY_AUTO else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS; return }
        val distance = 4 * view.resources.displayMetrics.density
        if (show) {
            if (view.visibility != View.VISIBLE) { view.alpha = 0f; view.translationY = distance }
            view.visibility = View.VISIBLE
            view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
            view.animate().alpha(1f).translationY(0f).setDuration(180).withEndAction(null).start()
        } else {
            view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            view.animate().alpha(0f).translationY(distance).setDuration(160).withEndAction {
                if (visibility[view] == false) { view.visibility = View.GONE; view.alpha = 1f; view.translationY = 0f }
            }.start()
        }
    }
}
