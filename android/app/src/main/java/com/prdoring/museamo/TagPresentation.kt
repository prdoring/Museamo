package com.prdoring.museamo

import android.content.Context
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ImageSpan
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.DrawableCompat

/** Presentation only: never insert this label into hashtag text or persistence. */
fun TagRow.displayLabel(context: Context, tint: Int = R.color.widget_text): CharSequence {
    if (type != "checklist") return name
    val label = SpannableString("$name  Checklist")
    val icon = ContextCompat.getDrawable(context, R.drawable.tag_checklist)!!.mutate()
    DrawableCompat.setTint(icon, ContextCompat.getColor(context, tint))
    val size = (18 * context.resources.displayMetrics.density).toInt()
    icon.setBounds(0, 0, size, size)
    label.setSpan(ImageSpan(icon, ImageSpan.ALIGN_BASELINE), name.length + 2, label.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    return label
}

fun TagRow.accessibleLabel(): String = name + if (type == "checklist") ", Checklist" else ""
