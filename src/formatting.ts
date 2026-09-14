import TurndownService from "turndown";

export type Format = "bold" | "italic" | "bullet" | "number" | "quote";
export function formatSelection(
  text: string,
  start: number,
  end: number,
  kind: Format,
) {
  if (kind === "bold" || kind === "italic") {
    const marker = kind === "bold" ? "**" : "_";
    const value = text.slice(start, end);
    if (
      text.slice(start - marker.length, start) === marker &&
      text.slice(end, end + marker.length) === marker
    ) {
      return {
        text:
          text.slice(0, start - marker.length) +
          value +
          text.slice(end + marker.length),
        start: start - marker.length,
        end: end - marker.length,
      };
    }
    return {
      text: text.slice(0, start) + marker + value + marker + text.slice(end),
      start: start + marker.length,
      end: end + marker.length,
    };
  }
  const from = start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const to = text.indexOf("\n", last);
  const until = to < 0 ? text.length : to;
  const lines = text.slice(from, until).split("\n");
  const pattern =
    kind === "bullet" ? /^- / : kind === "number" ? /^\d+\. / : /^> /;
  const remove = lines.every((line) => pattern.test(line));
  const value = lines
    .map((line, i) =>
      remove
        ? line.replace(pattern, "")
        : (kind === "bullet" ? "- " : kind === "number" ? `${i + 1}. ` : "> ") +
          line.replace(/^(?:- |\d+\. |> )/, ""),
    )
    .join("\n");
  return {
    text: text.slice(0, from) + value + text.slice(until),
    start: from,
    end: from + value.length,
  };
}

export function safeWebUrl(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

const converter = new TurndownService({
  bulletListMarker: "-",
  emDelimiter: "_",
  strongDelimiter: "**",
  headingStyle: "atx",
});
converter.remove((node) =>
  [
    "SCRIPT",
    "STYLE",
    "IFRAME",
    "OBJECT",
    "IMG",
    "SVG",
    "NOSCRIPT",
    "TEMPLATE",
  ].includes(node.nodeName),
);
converter.addRule("noMedia", { filter: "img", replacement: () => "" });
converter.addRule("styledEmphasis", {
  filter: (node) =>
    node.nodeName === "SPAN" &&
    /(?:font-weight|font-style)\s*:/i.test(node.getAttribute("style") || ""),
  replacement: (content, node) => {
    const style = (node as HTMLElement).getAttribute("style") || "";
    let value = content;
    if (/font-weight\s*:\s*(?:bold|[6-9]00)\b/i.test(style))
      value = `**${value}**`;
    if (/font-style\s*:\s*italic\b/i.test(style)) value = `_${value}_`;
    return value;
  },
});
converter.addRule("semanticLinks", {
  filter: "a",
  replacement: (content, node) => {
    const href = safeWebUrl((node as HTMLElement).getAttribute("href") || "");
    return href ? `[${content}](<${href}>)` : content;
  },
});
converter.addRule("definition", {
  filter: ["dt", "dd"],
  replacement: (content, node) =>
    node.nodeName === "DT"
      ? `\n\n**${content.trim()}**\n\n`
      : `\n\n${content.trim()}\n\n`,
});
// Source headings use the same modest emphasis as the rest of a thought.
converter.addRule("headings", {
  filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
  replacement: (content) => `\n\n**${content.trim()}**\n\n`,
});
export function formattedPaste(html: string) {
  return converter.turndown(html);
}
