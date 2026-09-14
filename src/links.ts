export interface WebLink {
  start: number;
  end: number;
  href: string;
}
/** Render-only detection: never rewrites saved text or fetches a link preview. */
export function webLinks(text: string): WebLink[] {
  const links: WebLink[] = [];
  const pattern = /(?<![\p{L}\p{N}_@./:-])(?:https?:\/\/|www\.)[^\s<>"']+/giu;
  for (const match of text.matchAll(pattern)) {
    let label = match[0].replace(/[.,;:!?]+$/, "");
    let trimmed = true;
    while (trimmed) {
      trimmed = false;
      for (const [open, close] of [
        ["(", ")"],
        ["[", "]"],
        ["{", "}"],
      ]) {
        if (
          label.endsWith(close) &&
          label.split(close).length > label.split(open).length
        ) {
          label = label.slice(0, -1).replace(/[.,;:!?]+$/, "");
          trimmed = true;
        }
      }
    }
    try {
      const url = new URL(/^www\./i.test(label) ? `https://${label}` : label);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname)
        continue;
      links.push({
        start: match.index!,
        end: match.index! + label.length,
        href: url.href,
      });
    } catch {
      /* Malformed addresses remain ordinary text. */
    }
  }
  return links;
}
