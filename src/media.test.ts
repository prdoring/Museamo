import { describe, expect, it } from "vitest";
import { mediaLink, mediaLinks } from "./media";

describe("media link previews", () => {
  it("recognizes signed file URLs without modifying their query", () => {
    expect(mediaLink("https://example.com/photo.JPG?token=a%2Bb#view")?.kind).toBe("image");
    expect(mediaLink("https://example.com/clip.mp4?token=secret")?.url).toBe("https://example.com/clip.mp4?token=secret");
  });
  it("only embeds supported HTTPS hosts and paths", () => {
    for (const url of ["http://example.com/a.jpg", "javascript:alert(1)", "https://youtube.com.evil.test/watch?v=abcdefghijk", "https://user:secret@example.com/a.jpg", "https://example.com/page", "https://youtube.com/watch?v=bad"]) expect(mediaLink(url)).toBeUndefined();
  });
  it("normalizes YouTube variants and preserves Vimeo access hashes", () => {
    for (const url of ["https://youtu.be/abcdefghijk", "https://www.youtube.com/watch?v=abcdefghijk", "https://youtube.com/shorts/abcdefghijk", "https://youtube.com/embed/abcdefghijk"])
      expect(mediaLink(url)?.url).toBe("https://www.youtube.com/embed/abcdefghijk?playsinline=1");
    expect(mediaLink("https://vimeo.com/12345/abc123")?.url).toBe("https://player.vimeo.com/video/12345?h=abc123");
    expect(mediaLink("https://player.vimeo.com/video/12345?h=abc123")?.url).toBe("https://player.vimeo.com/video/12345?h=abc123");
  });
  it("parses Markdown references and excludes code, HTML and unused definitions", () => {
    const text = "![photo](https://a.test/a.jpg)\n[clip][v]\n\n[v]: https://a.test/a.mp4\n[unused]: https://a.test/no.jpg\n\n`https://a.test/code.jpg`\n\n```\nhttps://a.test/fenced.mp4\n```\n\n    https://a.test/indent.jpg\n\n<img src=\"https://a.test/html.jpg\">";
    expect(mediaLinks(text).map(m => m.kind)).toEqual(["image", "video"]);
  });
  it("deduplicates repeated URLs and provider variants", () => {
    expect(mediaLinks("https://a.test/a.jpg [again](https://a.test/a.jpg) https://youtu.be/abcdefghijk https://youtube.com/watch?v=abcdefghijk")).toHaveLength(2);
  });
});
