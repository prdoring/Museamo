import { describe, expect, it } from "vitest";
import { webLinks } from "./links";
describe("plain-text URL linking", () => {
  it("recognizes web addresses without swallowing sentence punctuation", () => {
    const text = "Try https://example.com/a?q=1#part, or www.example.org.";
    const links = webLinks(text);
    expect(links.map((l) => text.slice(l.start, l.end))).toEqual([
      "https://example.com/a?q=1#part",
      "www.example.org",
    ]);
    expect(links[1].href).toBe("https://www.example.org/");
  });
  it("keeps balanced URL parentheses and trims enclosing punctuation", () => {
    const text = "(https://example.org/wiki/Name_(word)).";
    expect(webLinks(text).map((l) => text.slice(l.start, l.end))).toEqual([
      "https://example.org/wiki/Name_(word)",
    ]);
  });
  it("does not link executable schemes, emails or malformed URLs", () => {
    expect(
      webLinks(
        "javascript:alert(1) data:text/html,test me@www.example.org https://",
      ),
    ).toEqual([]);
  });
  it("handles multiple lines and uppercase schemes", () =>
    expect(webLinks("HTTPS://example.com\nhttp://example.org")).toHaveLength(
      2,
    ));
});
