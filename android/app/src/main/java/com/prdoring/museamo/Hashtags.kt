package com.prdoring.museamo

import java.util.Locale

object Hashtags {
    private fun source(text: String) = text.replace(Regex("(^|\\s)_(#(?:\"[^\"\\r\\n]+\"|[\\p{L}\\p{N}_-]+))_")) { it.groupValues[1] + " " + it.groupValues[2] + " " }.replace(Regex("(^|\\s)(?:\\*\\*|_)+(?=#)")) { " ".repeat(it.value.length) }
    private val pattern = Regex("(?<!\\S)#(?:\"([^\"\\r\\n]{1,80})\"|([\\p{L}\\p{N}_-]{1,80})(?![\\p{L}\\p{N}_-]))")
    fun names(text: String): List<String> = pattern.findAll(source(text)).map { (it.groupValues[1].ifEmpty { it.groupValues[2] }).trim() }.filter { it.isNotEmpty() }.distinctBy { it.lowercase(Locale.ROOT) }.toList()
    fun token(name: String): String = if (Regex("[\\p{L}\\p{N}_-]+").matches(name)) "#$name" else "#\"${name.replace("\"", "") }\""
    fun remove(text: String, name: String): String {
        var result = text
        pattern.findAll(source(text)).filter { (it.groupValues[1].ifEmpty { it.groupValues[2] }).trim().equals(name, true) }.toList().asReversed().forEach { result = result.removeRange(it.range) }
        return result
    }
    data class Token(val start: Int, val end: Int, val query: String)
    fun active(text: String, cursor: Int): Token? {
        if (cursor !in 0..text.length) return null
        val match = Regex("(?<!\\S)#(?:\"([^\"\\r\\n]{0,80})|([\\p{L}\\p{N}_-]{0,80}))$").find(text.substring(0, cursor)) ?: return null
        var end = cursor
        val quoted = match.value.startsWith("#\"")
        if (quoted) { while (end < text.length && text[end] !in "\"\r\n") end++; if (end < text.length && text[end] == '"') end++ }
        else { while (end < text.length && (text[end].isLetterOrDigit() || text[end] in "_-")) end++ }
        return Token(match.range.first, end, if (quoted) match.groupValues[1] else match.groupValues[2])
    }
}
