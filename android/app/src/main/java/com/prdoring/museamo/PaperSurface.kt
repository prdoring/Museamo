package com.prdoring.museamo

import android.content.Context
import android.content.res.Configuration
import android.graphics.*
import android.graphics.drawable.Drawable
import androidx.core.content.ContextCompat

/** Neutral texture tiles are bundled at mdpi; the host owns its ink color. */
class PaperSurface(context: Context, private val reading: Boolean = false, radiusDp: Float = 0f, private val border: Boolean = false) : Drawable() {
    private val density = context.resources.displayMetrics.density
    private val radius = radiusDp * density
    private val night = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    private val ground = ContextCompat.getColor(context, if (reading) R.color.widget_surface else R.color.widget_background)
    private val ink = ContextCompat.getColor(context, R.color.widget_text)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()
    private val texture = BitmapShader(BitmapFactory.decodeResource(context.resources,
        if (reading) R.drawable.paper_grain else if (night) R.drawable.ink_shading else R.drawable.paper_shading,
        BitmapFactory.Options().apply { inScaled = false }), Shader.TileMode.REPEAT, Shader.TileMode.REPEAT).apply {
        setLocalMatrix(Matrix().apply { setScale(density, density) })
    }
    override fun draw(canvas: Canvas) {
        val rect = RectF(bounds)
        path.reset(); path.addRoundRect(rect, radius, radius, Path.Direction.CW)
        val saved = canvas.save(); canvas.clipPath(path)
        paint.shader = null; paint.style = Paint.Style.FILL; paint.color = ground; paint.alpha = 255
        canvas.drawRect(rect, paint)
        paint.shader = texture; paint.alpha = if (reading) 10 else 255
        canvas.drawRect(rect, paint)
        canvas.restoreToCount(saved)
        if (border) {
            paint.shader = null; paint.alpha = 255; paint.color = ink; paint.style = Paint.Style.STROKE; paint.strokeWidth = 2 * density
            rect.inset(density, density); canvas.drawRoundRect(rect, radius, radius, paint)
        }
    }
    override fun setAlpha(alpha: Int) { }
    override fun setColorFilter(filter: ColorFilter?) { }
    @Deprecated("Deprecated in Android") override fun getOpacity() = PixelFormat.TRANSLUCENT
}
