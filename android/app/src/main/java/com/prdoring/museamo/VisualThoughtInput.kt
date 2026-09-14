package com.prdoring.museamo

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.text.*
import android.text.style.*
import androidx.appcompat.widget.AppCompatEditText
import org.commonmark.parser.Parser
import org.commonmark.renderer.html.HtmlRenderer
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.nodes.TextNode

/** Editable spans are the document. Markdown exists only at the persistence boundary. */
class VisualThoughtInput(context: Context) : AppCompatEditText(context) {
    var selectionChanged: (() -> Unit)? = null
    private var changing = false
    private var insertedAt = 0
    private var insertedCount = 0
    private var pendingStyle: Int? = null
    private var previousBlock: Block? = null

    private class Block(val kind: String, val firstNumber: Int = 1) : LeadingMarginSpan {
        override fun getLeadingMargin(first: Boolean) = 36
        override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) {
            if (!first) return
            val old = p.style
            p.style = Paint.Style.FILL
            when (kind) {
                "bullet" -> c.drawCircle((x + dir * 12).toFloat(), (baseline - p.textSize * .3f), 4f, p)
                "number" -> {
                    val spans = text as? Spanned
                    val origin = spans?.getSpanStart(this)?.coerceAtLeast(0) ?: start
                    val number = text.subSequence(origin, start).count { it == '\n' } + firstNumber
                    c.drawText("$number.", x.toFloat(), baseline.toFloat(), p)
                }
                else -> c.drawRect(x.toFloat(), top.toFloat(), (x + dir * 4).toFloat(), bottom.toFloat(), p)
            }
            p.style = old
        }
    }

    init {
        addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {
                if (!changing) previousBlock = (s as? Spanned)?.getSpans(start.coerceAtLeast(1) - 1, start, Block::class.java)?.lastOrNull()
            }
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { insertedAt = start; insertedCount = count }
            override fun afterTextChanged(value: Editable?) {
                if (changing || value == null) return
                changing = true
                try {
                    pendingStyle?.let { style ->
                        if (insertedCount > 0 && style != 0) value.setSpan(StyleSpan(style), insertedAt, (insertedAt + insertedCount).coerceAtMost(value.length), Spanned.SPAN_EXCLUSIVE_INCLUSIVE)
                    }
                    // Do not rewrite an IME's uncommitted composition (CJK, accents, dictation).
                    if (android.view.inputmethod.BaseInputConnection.getComposingSpanStart(value) < 0) {
                        if (insertedCount == 1 && insertedAt < value.length && value[insertedAt] == '\n') {
                            previousBlock?.let { block ->
                                val lineStart = if (insertedAt == 0) 0 else value.lastIndexOf('\n', insertedAt - 1) + 1
                                if (lineStart == insertedAt) {
                                    // Enter on an empty item exits the list/quote.
                                    val originalStart = value.getSpanStart(block)
                                    value.removeSpan(block)
                                    if (originalStart >= 0 && originalStart < lineStart) value.setSpan(Block(block.kind, block.firstNumber), originalStart, (lineStart - 1).coerceAtLeast(originalStart), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                                    value.delete(insertedAt, insertedAt + 1)
                                    setSelection(insertedAt)
                                } else {
                                    val originalStart = value.getSpanStart(block)
                                    value.removeSpan(block)
                                    if (originalStart >= 0) value.setSpan(Block(block.kind, block.firstNumber), originalStart, insertedAt, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                                    val next = insertedAt + 1
                                    value.setSpan(Block(block.kind, block.firstNumber + 1), next, next, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
                                }
                            }
                        } else autoFormat(value)
                    }
                } finally { changing = false }
            }
        })
    }

    override fun onSelectionChanged(start: Int, end: Int) {
        super.onSelectionChanged(start, end)
        selectionChanged?.invoke()
    }

    fun setMarkdown(markdown: String) {
        val html = HtmlRenderer.builder().build().render(Parser.builder().build().parse(markdown))
        setRichHtml(html)
    }

    private fun setRichHtml(html: String) {
        changing = true
        try { setText(parseHtml(html)); pendingStyle = null } finally { changing = false }
    }

    private fun parseHtml(html: String): SpannableStringBuilder {
        val out = SpannableStringBuilder()
        fun newline() { if (out.isNotEmpty() && out.last() != '\n') out.append('\n') }
        fun visit(node: org.jsoup.nodes.Node) {
            if (node is TextNode) { if (!node.isBlank || (node.parent() as? Element)?.tagName() in listOf("p", "strong", "em", "code", "pre", "li")) out.append(node.wholeText); return }
            if (node !is Element || node.tagName() in listOf("script", "style", "img", "iframe", "object")) return
            val tag = node.tagName()
            if (tag == "br") { out.append('\n'); return }
            if (tag in listOf("p", "div", "li", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6")) newline()
            val start = out.length
            node.childNodes().forEach(::visit)
            val end = out.length
            val span = when (tag) {
                "b", "strong", "h1", "h2", "h3", "h4", "h5", "h6" -> StyleSpan(Typeface.BOLD)
                "i", "em" -> StyleSpan(Typeface.ITALIC)
                "code", "pre" -> TypefaceSpan("monospace")
                "blockquote" -> Block("quote")
                "li" -> Block(if (node.parent()?.tagName() == "ol") "number" else "bullet", (node.parent()?.attr("start")?.toIntOrNull() ?: 1) + node.elementSiblingIndex())
                "a" -> node.attr("href").takeIf { it.startsWith("https://") || it.startsWith("http://") }?.let { URLSpan(it) }
                else -> null
            }
            if (span != null && end > start) out.setSpan(span, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (tag == "pre" && end > start) out.setSpan(Block("code"), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (tag in listOf("p", "div", "li", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6")) newline()
        }
        Jsoup.parseBodyFragment(html).body().childNodes().forEach(::visit)
        while (out.isNotEmpty() && out.last() == '\n') out.delete(out.length - 1, out.length)
        return out
    }

    fun markdown(): String {
        val value = text ?: return ""
        fun escape(s: String) = s.replace("\\", "\\\\").replace("*", "\\*").replace("_", "\\_").replace("[", "\\[").replace("]", "\\]").replace("`", "\\`")
        fun styleAt(position: Int): Int = value.getSpans(position, position + 1, StyleSpan::class.java).fold(0) { result, span -> result or span.style }
        var offset = 0
        var number = 0
        return value.toString().split('\n').joinToString("\n") { line ->
            val end = offset + line.length
            val block = value.getSpans(offset, end, Block::class.java).firstOrNull { value.getSpanStart(it) < end && value.getSpanEnd(it) > offset }
            number = if (block?.kind == "number") number + 1 else 0
            val prefix = when (block?.kind) { "bullet" -> "- "; "number" -> "$number. "; "quote" -> "> "; else -> "" }
            val rendered = StringBuilder()
            var pos = offset
            while (pos < end) {
                val style = styleAt(pos)
                val link = value.getSpans(pos, pos + 1, URLSpan::class.java).firstOrNull()?.url
                val code = value.getSpans(pos, pos + 1, TypefaceSpan::class.java).isNotEmpty()
                var until = pos + 1
                while (until < end && value.getSpans(until, until + 1, TypefaceSpan::class.java).isNotEmpty() == code && styleAt(until) == style && value.getSpans(until, until + 1, URLSpan::class.java).firstOrNull()?.url == link) until++
                val raw = value.subSequence(pos, until).toString()
                val leading = raw.takeWhile { it.isWhitespace() }
                val trailing = raw.takeLastWhile { it.isWhitespace() }
                var part = escape(raw.trim())
                if (part.isNotEmpty()) {
                    if (code) part = "`" + raw.trim().replace("`", "") + "`"
                    if (style and Typeface.ITALIC != 0) part = "_$part" + "_"
                    if (style and Typeface.BOLD != 0) part = "**$part**"
                    if (link != null) part = "[$part](<$link>)"
                    rendered.append(leading).append(part).append(trailing)
                } else rendered.append(raw)
                pos = until
            }
            offset = end + 1
            if (block?.kind == "code") "    $line" else prefix + if (prefix.isEmpty()) rendered.toString().replace(Regex("^(#{1,6} |>|[-+] |[0-9]+\\. )")) { "\\" + it.value } else rendered.toString()
        }
    }

    fun applyFormat(kind: String) {
        val value = text ?: return
        var start = minOf(selectionStart, selectionEnd).coerceAtLeast(0)
        var end = maxOf(selectionStart, selectionEnd).coerceAtLeast(start)
        if (kind == "bold" || kind == "italic") {
            val flag = if (kind == "bold") Typeface.BOLD else Typeface.ITALIC
            if (start == end) {
                val current = pendingStyle ?: value.getSpans(start, start, StyleSpan::class.java).fold(0) { result, span -> result or span.style }
                pendingStyle = current xor flag
                return
            }
            val spans = value.getSpans(start, end, StyleSpan::class.java)
            val remove = (start until end).all { pos -> value.getSpans(pos, pos + 1, StyleSpan::class.java).any { it.style and flag != 0 } }
            spans.forEach { span ->
                val a = value.getSpanStart(span); val b = value.getSpanEnd(span)
                if (span.style and flag != 0) {
                    value.removeSpan(span)
                    if (a < start) value.setSpan(StyleSpan(span.style), a, start, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    if (b > end) value.setSpan(StyleSpan(span.style), end, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    val remainder = span.style and flag.inv()
                    if (remainder != 0) value.setSpan(StyleSpan(remainder), maxOf(a, start), minOf(b, end), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
            if (!remove) value.setSpan(StyleSpan(flag), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        } else {
            start = if (start == 0) 0 else value.lastIndexOf('\n', start - 1) + 1
            end = value.indexOf('\n', end).let { if (it < 0) value.length else it }
            val spans = value.getSpans(start, end, Block::class.java)
            val remove = spans.any { it.kind == kind }
            spans.forEach { value.removeSpan(it) }
            if (!remove) value.setSpan(Block(kind), start, end, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        }
        invalidate()
    }

    private fun autoFormat(value: Editable) {
        val cursor = selectionStart.coerceIn(0, value.length)
        val before = value.subSequence(0, cursor).toString()
        for ((regex, flag) in listOf(Regex("\\*\\*([^*\\n]+)\\*\\*$") to Typeface.BOLD, Regex("_([^_\\n]+)_$") to Typeface.ITALIC, Regex("(?<!\\*)\\*([^*\\n]+)\\*$") to Typeface.ITALIC)) {
            val match = regex.find(before) ?: continue
            val content = match.groups[1]!!
            value.delete(content.range.last + 1, match.range.last + 1)
            value.delete(match.range.first, content.range.first)
            value.setSpan(StyleSpan(flag), match.range.first, match.range.first + content.value.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            setSelection(match.range.first + content.value.length)
            pendingStyle = 0
            return
        }
        val start = before.lastIndexOf('\n') + 1
        val prefix = before.substring(start)
        val kind = when { prefix in listOf("- ", "* ") -> "bullet"; prefix == "1. " -> "number"; prefix == "> " -> "quote"; else -> null }
        if (kind != null) {
            value.delete(start, cursor)
            value.setSpan(Block(kind), start, start, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
            setSelection(start)
        }
    }

    fun removeHashtag(name: String) {
        val value = text ?: return
        val original = value.toString()
        // Apply each deletion separately so intervening styles are retained.
        val matches = Regex("(?<!\\S)#(?:\"([^\"\\r\\n]{1,80})\"|([\\p{L}\\p{N}_-]{1,80})(?![\\p{L}\\p{N}_-]))").findAll(original)
        matches.filter { (it.groupValues[1].ifEmpty { it.groupValues[2] }).trim().equals(name, true) }
            .toList().asReversed().forEach { value.delete(it.range.first, it.range.last + 1) }

    }

    override fun onTextContextMenuItem(id: Int): Boolean {
        if (id == android.R.id.paste && isEnabled) {
            val item = (context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager).primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)
            val html = item?.htmlText
            if (!html.isNullOrEmpty()) {
                val start = minOf(selectionStart, selectionEnd).coerceAtLeast(0)
                val end = maxOf(selectionStart, selectionEnd).coerceAtLeast(start)
                val rich = parseHtml(html)
                text?.replace(start, end, rich); setSelection(start + rich.length)
                return true
            }
        }
        return super.onTextContextMenuItem(id)
    }
}
