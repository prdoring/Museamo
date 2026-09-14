package com.prdoring.museamo

import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode

/** Portable Markdown: the same text survives drafts, backups and future destination adapters. */
object ThoughtFormatting {
    data class Edit(val text: String, val start: Int, val end: Int)
    fun format(text: String, start: Int, end: Int, kind: String): Edit {
        if (kind == "bold" || kind == "italic") {
            val marker = if (kind == "bold") "**" else "_"
            val value = text.substring(start, end)
            if (start >= marker.length && text.substring(start - marker.length, start) == marker && text.substring(end).startsWith(marker))
                return Edit(text.substring(0, start - marker.length) + value + text.substring(end + marker.length), start - marker.length, end - marker.length)
            return Edit(text.substring(0, start) + marker + value + marker + text.substring(end), start + marker.length, end + marker.length)
        }
        val from = if (start == 0) 0 else text.lastIndexOf('\n', start - 1) + 1
        val last = if (end > start && text[end - 1] == '\n') end - 1 else end
        val until = text.indexOf('\n', last).let { if (it < 0) text.length else it }
        val lines = text.substring(from, until).split('\n')
        val pattern = Regex(when (kind) { "bullet" -> "^- "; "number" -> "^\\d+\\. "; else -> "^> " })
        val remove = lines.all { pattern.containsMatchIn(it) }
        val value = lines.mapIndexed { i, line -> if (remove) line.replaceFirst(pattern, "") else (when(kind) { "bullet" -> "- "; "number" -> "${i + 1}. "; else -> "> " }) + line.replaceFirst(Regex("^(?:- |\\d+\\. |> )"), "") }.joinToString("\n")
        return Edit(text.substring(0, from) + value + text.substring(until), from, from + value.length)
    }
    private fun escape(text: String): String = text.replace("\\", "\\\\").replace("*", "\\*").replace("_", "\\_").replace("[", "\\[").replace("]", "\\]").replace("`", "\\`").replace(Regex("(?m)^(\\s*)([#>+-]|\\d+\\.)")) { it.groupValues[1] + "\\" + it.groupValues[2] }
    fun fromHtml(html: String): String {
        val root = Jsoup.parseBodyFragment(html).body()
        root.select("script,style,iframe,object,img,svg,noscript,template").remove()
        fun render(node: Node, depth: Int = 0): String {
            if (depth > 60) return (node as? Element)?.text()?.let(::escape) ?: ""
            if (node is TextNode) return escape(node.text().replace(Regex("\\s+"), " "))
            if (node !is Element) return ""
            val raw = if (node.tagName() in listOf("ul", "ol")) "" else node.childNodes().joinToString("") { render(it, depth + 1) }
            val content = if (node.tagName() in listOf("p", "span", "b", "strong", "i", "em")) raw.replace(Regex("(?<=\\S) {2,}(?=\\S)"), " ") else raw
            return when (node.tagName()) {
                "br" -> "  \n"
                "b", "strong" -> wrap(content, "**")
                "i", "em" -> wrap(content, "_")
                "span" -> {
                    val style = node.attr("style")
                    var value = content
                    if (Regex("font-weight\\s*:\\s*(?:bold|[6-9]00)\\b", RegexOption.IGNORE_CASE).containsMatchIn(style)) value = "**$value**"
                    if (Regex("font-style\\s*:\\s*italic\\b", RegexOption.IGNORE_CASE).containsMatchIn(style)) value = "_${value}_"
                    value
                }
                "h1", "h2", "h3", "h4", "h5", "h6", "dt" -> "\n\n**${content.trim()}**\n\n"
                "p", "div", "dd", "section", "article" -> "\n\n${content.trim()}\n\n"
                "blockquote" -> "\n\n" + content.trim().lines().joinToString("\n") { "> $it" } + "\n\n"
                "ul", "ol" -> "\n\n" + node.children().filter { it.tagName() == "li" }.joinToString("") { render(it, depth + 1) }.trimEnd() + "\n\n"
                "li" -> {
                    val parent = node.parent()
                    val prefix = if (parent?.tagName() == "ol") "${(parent.attr("start").toIntOrNull() ?: 1) + parent.children().filter { it.tagName() == "li" }.indexOf(node)}.  " else "-   "
                    prefix + content.trim().replace(Regex("\n\n(?=(?:- |\\d+\\. ))"), "\n").replace("\n", "\n" + " ".repeat(prefix.length)) + "\n"
                }
                "a" -> {
                    val href = node.attr("href")
                    val uri = runCatching { java.net.URI(href) }.getOrNull()
                    if (uri?.scheme?.lowercase() in listOf("http", "https") && !uri?.host.isNullOrBlank()) "[$content](<$href>)" else content
                }
                "pre" -> "\n\n" + node.wholeText().lines().joinToString("\n") { "    $it" } + "\n\n"
                "code" -> if (node.parent()?.tagName() == "pre") content else "`${node.text()}`"
                "tr" -> "$content\n\n"
                "td", "th" -> "$content "
                else -> content
            }
        }
        return render(root).replace(Regex("\n{3,}"), "\n\n").trim()
    }
    private fun wrap(content: String, marker: String): String {
        if (content.isBlank()) return content
        return content.takeWhile { it.isWhitespace() } + marker + content.trim() + marker + content.takeLastWhile { it.isWhitespace() }
    }
}
