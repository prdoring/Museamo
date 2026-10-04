import Foundation

enum Hashtags {
    static func normalized(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping.lowercased()
    }

    static func names(_ text: String) -> [String] {
        // Match the editor's emphasis preprocessing and Unicode hashtag boundaries.
        var source = text
        let emphasis = try! NSRegularExpression(pattern: #"(^|\s)_(#(?:"[^"\r\n]+"|[\p{L}\p{N}_-]+))_"#)
        source = emphasis.stringByReplacingMatches(in: source, range: NSRange(source.startIndex..., in: source), withTemplate: "$1 $2 ")
        let opening = try! NSRegularExpression(pattern: #"(^|\s)(?:\*\*|_)+(?=#)"#)
        source = opening.stringByReplacingMatches(in: source, range: NSRange(source.startIndex..., in: source), withTemplate: " ")
        let pattern = try! NSRegularExpression(pattern: #"(?<!\S)#(?:"([^"\r\n]{1,80})"|([\p{L}\p{N}_-]{1,80})(?![\p{L}\p{N}_-]))"#)
        var seen = Set<String>()
        return pattern.matches(in: source, range: NSRange(source.startIndex..., in: source)).compactMap { match in
            let group = match.range(at: 1).location == NSNotFound ? 2 : 1
            guard let range = Range(match.range(at: group), in: source) else { return nil }
            let name = String(source[range]).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, seen.insert(normalized(name)).inserted else { return nil }
            return name
        }
    }
}
