import { Children, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import { bridge, isNative, type Tag } from "../data";
import { hashtags } from "../hashtags";
import { webLinks } from "../links";
import { safeWebUrl } from "../formatting";
import { ChecklistMark, SharedMark } from "./Sharing";

export function FormattedText({
  text,
  tags = [],
  openTag,
  report = () => {},
}: {
  text: string;
  tags?: Tag[];
  openTag?: (id: string) => void;
  report?: (message: string) => void;
}) {
  function link(href: string, children: ReactNode, key?: number) {
    return (
      <a
        key={key}
        className="inline-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (isNative) {
            e.preventDefault();
            void bridge
              .openExternal({ url: href })
              .catch(() => report("Could not open this link. Try again."));
          }
        }}
      >
        {children}
      </a>
    );
  }
  function decorate(children: ReactNode) {
    return Children.map(children, (child) => {
      if (typeof child !== "string") return child;
      const tagTokens = hashtags(child);
      const tokens = [
        ...tagTokens.map((t) => ({ ...t, kind: "tag" as const })),
        ...webLinks(child)
          .filter(
            (l) => !tagTokens.some((t) => l.start < t.end && l.end > t.start),
          )
          .map((l) => ({ ...l, kind: "url" as const })),
      ].sort((a, b) => a.start - b.start);
      const result: ReactNode[] = [];
      let from = 0;
      for (const token of tokens) {
        result.push(child.slice(from, token.start));
        const label = child.slice(token.start, token.end);
        const tag =
          token.kind === "tag"
            ? tags.find(
                (t) => t.name.toLowerCase() === token.name.toLowerCase(),
              )
            : undefined;
        result.push(
          token.kind === "url" ? (
            link(token.href, label, token.start)
          ) : tag && openTag ? (
            <button
              key={token.start}
              className="inline-tag"
              onClick={() => openTag(tag.id)}
            >
              {label}
              {tag.sharing && tag.type === "checklist" && <ChecklistMark />}{tag.sharing && <SharedMark />}
            </button>
          ) : (
            label
          ),
        );
        from = token.end;
      }
      result.push(child.slice(from));
      return result;
    });
  }
  return (
    <Markdown
      remarkPlugins={[remarkBreaks]}
      unwrapDisallowed
      allowedElements={[
        "p",
        "br",
        "strong",
        "em",
        "ul",
        "ol",
        "li",
        "blockquote",
        "a",
        "code",
        "pre",
        "hr",
      ]}
      urlTransform={safeWebUrl}
      components={{
        p: ({ children }) => <p>{decorate(children)}</p>,
        strong: ({ children }) => <strong>{decorate(children)}</strong>,
        em: ({ children }) => <em>{decorate(children)}</em>,
        li: ({ children }) => <li>{decorate(children)}</li>,
        a: ({ href, children }) =>
          href ? link(href, children) : <>{children}</>,
      }}
    >
      {text}
    </Markdown>
  );
}

export async function copyFormatted(text: string) {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(<FormattedText text={text} />);
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("li")
    .forEach((el) =>
      el.prepend(
        el.parentElement?.tagName === "OL"
          ? `${Array.from(el.parentElement.children).indexOf(el) + Number(el.parentElement.getAttribute("start") || 1)}. `
          : "• ",
      ),
    );
  doc.querySelectorAll("p,li,blockquote,pre").forEach((el) => el.append("\n"));
  doc.querySelectorAll("br").forEach((el) => el.replaceWith("\n"));
  const plain = doc.body.textContent?.trim() || text;
  if (isNative) return bridge.copyFormatted({ text: plain, html });
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([plain], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return;
    } catch {
      /* Plain-text fallback for browsers without HTML clipboard support. */
    }
  }
  await navigator.clipboard.writeText(plain);
}
