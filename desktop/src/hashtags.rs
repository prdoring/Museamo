use regex::Regex;
use std::{collections::BTreeSet, sync::LazyLock};

static ITALIC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(^|\s)_(#(?:"[^"\r\n]+"|[\p{L}\p{N}_-]+))_"#).unwrap());
static OPENING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|\s)(?:\*\*|_)+#").unwrap());
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{L}\p{N}_-]+").unwrap());

/// Saved hashtags follow the shared Android/browser fixtures. URLs and partial tokens
/// are excluded; Store resolves names and records any created categories atomically.
pub fn names(text: &str) -> Vec<String> {
    let italic = ITALIC.replace_all(text, "$1 $2 ");
    let source = OPENING.replace_all(&italic, "$1#");
    let mut seen = BTreeSet::new();
    let mut names = Vec::new();
    for (index, character) in source.char_indices() {
        if character != '#'
            || (index != 0
                && !source[..index]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace))
        {
            continue;
        }
        let rest = &source[index + 1..];
        let candidate = if let Some(quoted) = rest.strip_prefix('"') {
            let Some(end) = quoted.find('"') else {
                continue;
            };
            let candidate = &quoted[..end];
            if candidate.contains(['\r', '\n']) {
                continue;
            }
            candidate
        } else {
            let Some(word) = WORD.find(rest) else {
                continue;
            };
            word.as_str()
        };
        // Native category names use the same UTF-16 limit as the editor and Android.
        if candidate.encode_utf16().count() > 80 {
            continue;
        }
        let candidate = candidate.trim();
        if !candidate.is_empty() && seen.insert(museamo_sync_core::normalize_tag(candidate)) {
            names.push(candidate.to_owned());
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_android_browser_fixtures() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../test-fixtures/hashtags.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let expected: Vec<String> = serde_json::from_value(case["names"].clone()).unwrap();
            assert_eq!(names(case["text"].as_str().unwrap()), expected);
        }
    }

    #[test]
    fn complete_tokens_and_native_name_limits() {
        assert!(names(&format!("#{}", "a".repeat(81))).is_empty());
        assert!(names(&format!("#\"{}\"", "🧠".repeat(41))).is_empty());
        assert_eq!(names(&format!("#{}", "a".repeat(80))), ["a".repeat(80)]);
        assert_eq!(
            names("mail#word https://example.com/#part #real #\"broken\nname\""),
            ["real"]
        );
        assert_eq!(names("#\" Café \" #\"Cafe\u{301}\""), ["Café"]);
    }
}
