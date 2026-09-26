import { webLinks } from "./links";
import { unified } from "unified";
import remarkParse from "remark-parse";

export interface Attachment {
  id: string;
  kind: "image" | "video";
  mimeType: string;
  filename: string;
  byteSize: number;
  width: number;
  height: number;
  /** Milliseconds; absent/null for still images. */
  duration?: number | null;
}
export interface MediaLink { kind: "image" | "video" | "embed"; url: string; source: string }
export const MEDIA_LIMIT = 10;
export function mediaLink(raw: string): MediaLink | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return;
    const host = u.hostname.toLowerCase();
    let id: string | null | undefined;
    if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host)) {
      id = u.pathname === "/watch" ? u.searchParams.get("v") : /^\/(?:shorts|embed)\/([^/]+)\/?$/.exec(u.pathname)?.[1];
    } else if (host === "youtu.be") id = u.pathname.slice(1).replace(/\/$/, "");
    if (id && /^[\w-]{11}$/.test(id)) {
      const player = new URL(`https://www.youtube.com/embed/${id}`);
      player.searchParams.set("playsinline", "1");
      const start = u.searchParams.get("start") || u.searchParams.get("t");
      if (start && /^\d+$/.test(start)) player.searchParams.set("start", start);
      return { kind: "embed", url: player.href, source: u.href };
    }
    if (["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host)) {
      const match = /^\/(?:video\/)?(\d+)(?:\/([a-zA-Z0-9]+))?\/?$/.exec(u.pathname);
      if (match) {
        const player = new URL(`https://player.vimeo.com/video/${match[1]}`);
        const hash = u.searchParams.get("h") || match[2];
        if (hash && /^[a-zA-Z0-9]+$/.test(hash)) player.searchParams.set("h", hash);
        return { kind: "embed", url: player.href, source: u.href };
      }
    }
    if (/\.(?:jpe?g|png|gif|webp|avif|heic|heif)$/i.test(u.pathname)) return { kind: "image", url: u.href, source: u.href };
    if (/\.(?:mp4|webm|m4v|mov|ogv)$/i.test(u.pathname)) return { kind: "video", url: u.href, source: u.href };
  } catch { /* Not a supported media URL. */ }
}

/** Parse Markdown so code and reference definitions never accidentally load media. */
export function mediaLinks(text: string): MediaLink[] {
  const tree = unified().use(remarkParse).parse(text);
  const found = new Map<string, MediaLink>();
  type Node = { type: string; value?: string; url?: string; identifier?: string; children?: Node[] };
  const definitions = new Map<string, string>();
  function definitionsIn(node: Node) {
    if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier, node.url);
    node.children?.forEach(definitionsIn);
  }
  function add(url: string) { const media = mediaLink(url); if (media) found.set(media.url, media); }
  function visit(node: Node) {
    if (["code", "inlineCode", "html", "definition"].includes(node.type)) return;
    if (node.type === "link" || node.type === "image") { if (node.url) add(node.url); return; }
    if (node.type === "linkReference" || node.type === "imageReference") { const url = definitions.get(node.identifier || ""); if (url) add(url); return; }
    if (node.type === "text" && node.value) webLinks(node.value).forEach(l => add(l.href));
    node.children?.forEach(visit);
  }
  definitionsIn(tree); visit(tree);
  return [...found.values()];
}
