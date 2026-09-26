package com.prdoring.museamo

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.SizeF
import android.view.View
import android.widget.RemoteViews

class CaptureWidget : AppWidgetProvider() {
    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, widgetId: Int, options: android.os.Bundle) { onUpdate(context, manager, intArrayOf(widgetId)) }
    override fun onUpdate(context: Context, manager: AppWidgetManager, widgetIds: IntArray) {
        val pending = goAsync()
        Store.executor.execute { try { widgetIds.forEach { render(context, it) } } finally { pending.finish() } }
    }
    override fun onDeleted(context: Context, widgetIds: IntArray) {
        val pending = goAsync()
        Store.executor.execute { try { val repo = Store.get(context); repo.db.runInTransaction { widgetIds.forEach { id -> repo.dao.binding(id)?.let { repo.dao.deleteDraft(it.profileId) }; repo.dao.deleteBinding(id) } }; Store.changed(context) } finally { pending.finish() } }
    }
    override fun onRestored(context: Context, oldWidgetIds: IntArray, newWidgetIds: IntArray) {
        val pending = goAsync()
        Store.executor.execute { try { val dao = Store.get(context).dao; oldWidgetIds.zip(newWidgetIds.toList()).forEach { (old, new) -> dao.binding(old)?.let { dao.putBinding(BindingRow(new, it.profileId)); dao.deleteBinding(old) } }; newWidgetIds.forEach { render(context, it) } } finally { pending.finish() } }
    }
    companion object {
        fun refresh(context: Context) { Store.executor.execute { AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, CaptureWidget::class.java)).forEach { render(context, it) } } }
        fun render(context: Context, widgetId: Int) {
            AppWidgetManager.getInstance(context).updateAppWidget(widgetId, views(context, widgetId))
        }
        fun views(context: Context, widgetId: Int): RemoteViews {
            val options = AppWidgetManager.getInstance(context).getAppWidgetOptions(widgetId)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                return RemoteViews(linkedMapOf(
                    SizeF(40f, 40f) to viewsForSize(context, widgetId, 40, 40),
                    SizeF(260f, 40f) to viewsForSize(context, widgetId, 260, 40),
                    SizeF(100f, 120f) to viewsForSize(context, widgetId, 100, 120),
                    SizeF(260f, 120f) to viewsForSize(context, widgetId, 260, 120),
                    SizeF(100f, 180f) to viewsForSize(context, widgetId, 100, 180),
                    SizeF(260f, 180f) to viewsForSize(context, widgetId, 260, 180),
                ))
            }
            // Before Android 12, launchers provide portrait/landscape bounds.
            val minWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 180).coerceAtLeast(40)
            val minHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 40).coerceAtLeast(40)
            val maxWidth = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, minWidth).coerceAtLeast(minWidth)
            val maxHeight = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, minHeight).coerceAtLeast(minHeight)
            return RemoteViews(viewsForSize(context, widgetId, maxWidth, minHeight), viewsForSize(context, widgetId, minWidth, maxHeight))
        }
        internal fun viewsForWidth(context: Context, widgetId: Int, width: Int): RemoteViews = viewsForSize(context, widgetId, width, 40)
        internal fun viewsForSize(context: Context, widgetId: Int, width: Int, height: Int): RemoteViews {
            val dao = Store.get(context).dao
            val profile = dao.binding(widgetId)?.let { dao.profile(it.profileId) }
            return buildViews(context, widgetId, width, height, profile,
                profile?.let { dao.draft(it.id)?.text?.isNotBlank() == true } == true,
                profile?.selectedTagId?.let { dao.tag(it)?.name } ?: "No tag")
        }
        internal fun buildViews(context: Context, widgetId: Int, width: Int, height: Int, profile: ProfileRow?, pendingDraft: Boolean, tagName: String): RemoteViews {
            val card = width >= 100 && height >= 120
            // Keep one- and two-cell rows free of squeezed labels and picker controls.
            val compact = width < 260 && !card
            val views = RemoteViews(context.packageName, if (card) R.layout.capture_widget_card else if (compact) R.layout.capture_widget_compact else R.layout.capture_widget)
            val label = if (profile == null) "Tap to set up" else if (pendingDraft) "Continue draft" else profile.label
            views.setContentDescription(R.id.widget_capture, if (compact && profile != null) "Message yourself. $label" else label)
            if (!compact) {
                views.setTextViewText(R.id.widget_label, label)
                views.setTextViewText(R.id.widget_prompt, if (profile == null) "Tap to set up" else "A thought…")
                if (card) views.setInt(R.id.widget_label, "setMaxLines", if (height < 180) 1 else 2)
                views.setViewVisibility(R.id.widget_capture_icon, if ((card && height < 180) || (!card && profile?.mode == "picker" && width < 260)) View.GONE else View.VISIBLE)
            }
            fun intent(target: Class<*>, action: String): PendingIntent {
                val i = Intent(context, target).putExtra("profileId", profile?.id).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                    .setData(Uri.parse("museamo://widget/$widgetId/$action")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                return PendingIntent.getActivity(context, widgetId, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }
            val openApp = PendingIntent.getActivity(context, widgetId, Intent(context, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setData(Uri.parse("museamo://widget/$widgetId/open-app")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            views.setOnClickPendingIntent(R.id.widget_open_app, openApp)
            val capture = intent(if (profile == null) WidgetConfigActivity::class.java else CaptureActivity::class.java, "capture")
            views.setOnClickPendingIntent(R.id.widget_capture, capture)
            if (compact) return views
            views.setOnClickPendingIntent(R.id.widget_label, capture)
            views.setViewVisibility(R.id.widget_picker, if (profile?.mode == "picker" && !compact) View.VISIBLE else View.GONE)
            if (profile?.mode == "picker") {
                views.setTextViewText(R.id.widget_picker_text, if (width < 260) "#" else tagName)
                views.setInt(R.id.widget_picker_text, "setMaxWidth", ((if (card) width - 84f else (width - 40) * .35f - 36).coerceAtLeast(18f) * context.resources.displayMetrics.density).toInt())
                views.setContentDescription(R.id.widget_picker, "Choose tag. Current: " + (tagName))
                views.setOnClickPendingIntent(R.id.widget_picker, intent(TagPickerActivity::class.java, "picker"))
            }
            return views
        }
    }
}
