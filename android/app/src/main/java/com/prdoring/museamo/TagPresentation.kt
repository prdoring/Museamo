package com.prdoring.museamo

import android.content.Context
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ImageSpan
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.DrawableCompat

/** Presentation only: never insert this label into hashtag text or persistence. */
fun TagRow.displayLabel(context: Context, tint: Int = R.color.widget_text): CharSequence {
    val markers = buildList { if (type == "checklist") add("Checklist" to R.drawable.tag_checklist); if (shared) add("Shared" to R.drawable.tag_shared) }
    val displayName = name + if (ambiguous && !shared) " · Private" else ""
    if (markers.isEmpty()) return displayName
    val label = SpannableString(displayName + markers.joinToString("") { "  ${it.first}" })
    var start = displayName.length
    markers.forEach { (text, drawable) ->
        val icon = ContextCompat.getDrawable(context, drawable)!!.mutate()
        DrawableCompat.setTint(icon, ContextCompat.getColor(context, tint)); val size = (18 * context.resources.displayMetrics.density).toInt(); icon.setBounds(0, 0, size, size)
        label.setSpan(ImageSpan(icon, ImageSpan.ALIGN_BASELINE), start + 2, start + 2 + text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE); start += text.length + 2
    }
    return label
}

fun TagRow.accessibleLabel(): String = name + (if (type == "checklist") ", Checklist" else "") + (if (shared) ", Shared" else if (ambiguous) ", Private" else "")
