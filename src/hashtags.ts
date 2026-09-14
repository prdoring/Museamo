export interface Hashtag {
  name: string;
  start: number;
  end: number;
}
const pattern =
  /(?<!\S)#(?:"([^"\r\n]{1,80})"|([\p{L}\p{N}_-]{1,80})(?![\p{L}\p{N}_-]))/gu;
export function hashtags(text: string): Hashtag[] {
  // Ignore opening emphasis delimiters without changing token offsets.
  const source = text
    .replace(
      /(^|\s)_(#(?:"[^"\r\n]+"|[\p{L}\p{N}_-]+))_/gu,
      (_, space: string, tag: string) => space + " " + tag + " ",
    )
    .replace(/(^|\s)(?:\*\*|_)+(?=#)/gu, (value) => " ".repeat(value.length));
  return [...source.matchAll(pattern)]
    .map((m) => ({
      name: (m[1] || m[2]).trim(),
      start: m.index!,
      end: m.index! + m[0].length,
    }))
    .filter((t) => !!t.name);
}
export function hashtagText(name: string) {
  return /^[\p{L}\p{N}_-]+$/u.test(name)
    ? `#${name}`
    : `#"${name.replaceAll('"', "")}"`;
}
export function removeHashtag(text: string, name: string) {
  return hashtags(text)
    .filter((t) => t.name.toLowerCase() === name.toLowerCase())
    .reverse()
    .reduce((s, t) => s.slice(0, t.start) + s.slice(t.end), text);
}
export function activeHashtag(text: string, cursor: number) {
  const match = /(?<!\S)#(?:"([^"\r\n]{0,80})|([\p{L}\p{N}_-]{0,80}))$/u.exec(
    text.slice(0, cursor),
  );
  if (!match) return undefined;
  let end = cursor;
  if (match[1] !== undefined) {
    while (end < text.length && !['"', "\n", "\r"].includes(text[end])) end++;
    if (text[end] === '"') end++;
  } else {
    while (end < text.length && /[\p{L}\p{N}_-]/u.test(text[end])) end++;
  }
  return { start: match.index, end, query: match[1] ?? match[2] };
}
