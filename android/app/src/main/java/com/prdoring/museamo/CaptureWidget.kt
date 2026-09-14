package com.prdoring.museamo

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
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
            return viewsForWidth(context, widgetId, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 180))
        }
        internal fun viewsForWidth(context: Context, widgetId: Int, width: Int): RemoteViews {
            val dao = Store.get(context).dao
            val profile = dao.binding(widgetId)?.let { dao.profile(it.profileId) }
            val views = RemoteViews(context.packageName, R.layout.capture_widget)
            views.setViewVisibility(R.id.widget_capture_icon, if (profile?.mode == "picker" && width < 260) View.GONE else View.VISIBLE)
            val pendingDraft = profile?.let { dao.draft(it.id)?.text?.isNotBlank() == true } == true
            val label = if (profile == null) "Tap to set up" else if (pendingDraft) "Continue draft" else profile.label
            views.setTextViewText(R.id.widget_label, label)
            views.setContentDescription(R.id.widget_capture, label)
            views.setTextViewText(R.id.widget_prompt, if (profile == null) "Tap to set up" else "A thought…")
            fun intent(target: Class<*>, action: String): PendingIntent {
                val i = Intent(context, target).putExtra("profileId", profile?.id).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                    .setData(Uri.parse("museamo://widget/$widgetId/$action")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                return PendingIntent.getActivity(context, widgetId, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            }
            val openApp = PendingIntent.getActivity(context, widgetId, Intent(context, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setData(Uri.parse("museamo://widget/$widgetId/open-app")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            views.setOnClickPendingIntent(R.id.widget_open_app, openApp)
            val capture = intent(if (profile == null) WidgetConfigActivity::class.java else CaptureActivity::class.java, "capture")
            views.setOnClickPendingIntent(R.id.widget_capture, capture)
            views.setOnClickPendingIntent(R.id.widget_label, capture)
            views.setViewVisibility(R.id.widget_picker, if (profile?.mode == "picker") View.VISIBLE else View.GONE)
            if (profile?.mode == "picker") {
                views.setTextViewText(R.id.widget_picker_text, if (width < 260) "#" else profile.selectedTagId?.let { dao.tag(it)?.name } ?: "No tag")
                views.setInt(R.id.widget_picker_text, "setMaxWidth", (((width - 40) * .35f - 36).coerceAtLeast(18f) * context.resources.displayMetrics.density).toInt())
                views.setContentDescription(R.id.widget_picker, "Choose tag. Current: " + (profile.selectedTagId?.let { dao.tag(it)?.name } ?: "No tag"))
                views.setOnClickPendingIntent(R.id.widget_picker, intent(TagPickerActivity::class.java, "picker"))
            }
            return views
        }
    }
}
