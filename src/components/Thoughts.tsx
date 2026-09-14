import { PaperIcon } from "./PaperIcon";
import { FormattedText, copyFormatted } from "./FormattedText";
import { type Format } from "../formatting";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { createPortal } from "react-dom";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Bold, Italic, List, ListOrdered, Quote,
  Copy,
  Hash,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import { bridge, isNative, type Entry, type Tag } from "../data";
import {
  activeHashtag,
  hashtags,
  hashtagText,
  removeHashtag,
} from "../hashtags";

export function Sheet({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const previousInert = shell?.inert || false;
    if (shell) shell.inert = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) || [],
      );
    (
      ref.current?.querySelector<HTMLElement>("[autofocus],textarea,input") ||
      focusable()[0]
    )?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const list = focusable(),
          first = list[0],
          last = list.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    const back = (event: Event) => {
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener("museamoBack", back);
    document.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("museamoBack", back);
      document.removeEventListener("keydown", key);
      document.body.style.overflow = previousOverflow;
      if (shell) shell.inert = previousInert;
      before?.focus();
    };
  }, []);
  return createPortal(
    <div
      className="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="sheet"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="sheet-heading">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="Close" onClick={close}>
            <PaperIcon name="close" size={21} />
          </button>
        </div>
        {children}
      </section>
    </div>,
    document.body,
  );
}
export function Post({
  entry,
  tags,
  star,
  edit,
  remove,
  openTag,
  report,
}: {
  entry: Entry;
  tags: Tag[];
  star: () => void;
  edit: () => void;
  remove: () => void;
  openTag: (id: string) => void;
  report: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false),
    [overflows, setOverflows] = useState(false),
    [menu, setMenu] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    const check = () => {
      if (!expanded) setOverflows(el.scrollHeight > el.clientHeight + 2);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [entry.text, expanded]);

  return (
    <article className="post">
      <div className="post-top">
        <time dateTime={new Date(entry.createdAt).toISOString()}>
          {new Date(entry.createdAt).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
          {entry.updatedAt > entry.createdAt + 1000 && " · edited"}
        </time>
        <button
          className={
            "icon-button star-button " + (entry.starred ? "starred" : "")
          }
          aria-pressed={entry.starred}
          aria-label={entry.starred ? "Remove from Gems" : "Save to Gems"}
          onClick={star}
        >
          <Star size={19} fill={entry.starred ? "currentColor" : "none"} />
        </button>
        <button
          className="icon-button"
          aria-label="Thought actions"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          <MoreHorizontal size={21} />
        </button>
      </div>
      <div
        ref={body}
        className={"post-text rich-text " + (expanded ? "" : "clamped")}
      >
        <FormattedText
          text={entry.text}
          tags={tags.filter((t) => entry.tagIds.includes(t.id))}
          openTag={openTag}
          report={report}
        />
      </div>
      {overflows && (
        <button className="text-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {!!entry.tagIds.length && (
        <div className="chips post-tags">
          {entry.tagIds
            .map((id) => tags.find((t) => t.id === id))
            .filter((t): t is Tag => !!t)
            .map((t) => (
              <button className="chip" key={t.id} onClick={() => openTag(t.id)}>
                # {t.name}
              </button>
            ))}
        </div>
      )}
      {menu && (
        <Sheet title="Thought actions" close={() => setMenu(false)}>
          <button
            className="menu-row"
            onClick={() => {
              setMenu(false);
              edit();
            }}
          >
            <Pencil size={19} />
            Edit
          </button>
          <button
            className="menu-row"
            onClick={() =>
              void copyFormatted(entry.text)
                .then(() => {
                  setMenu(false);
                  report("Copied text.");
                })
                .catch(() => report("Could not copy text. Please try again."))
            }
          >
            <Copy size={19} />
            Copy text
          </button>
          <button
            className="menu-row danger"
            onClick={() => {
              setMenu(false);
              remove();
            }}
          >
            <Trash2 size={19} />
            Delete
          </button>
        </Sheet>
      )}
    </article>
  );
}
export function Editor({
  initial,
  tags,
  capture = false,
  change,
  save,
  close,
  refreshTags,
  discard,
}: {
  initial: { text: string; tagIds: string[] };
  tags: Tag[];
  capture?: boolean;
  change?: (text: string, ids: string[]) => void;
  save: (text: string, ids: string[]) => Promise<void>;
  close: () => void;
  refreshTags: () => Promise<void>;
  discard?: () => Promise<void>;
}) {
  const [text, setText] = useState(initial.text),
    [selected, setSelected] = useState(() =>
      capture
        ? initial.tagIds
        : initial.tagIds.filter(
            (id) =>
              !tags.some(
                (t) =>
                  t.id === id &&
                  hashtags(initial.text).some(
                    (h) => h.name.toLowerCase() === t.name.toLowerCase(),
                  ),
              ),
          ),
    ),
    [tagSearch, setTagSearch] = useState(""),
    [showTags, setShowTags] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [cursorText, setCursorText] = useState({ text: "", offset: 0 }),
    [showFormatting, setShowFormatting] = useState(false);
  const pending = useRef(false);
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false, protocols: ["http", "https"] } }), Markdown],
    content: initial.text,
    contentType: "markdown",
    autofocus: "end",
    editorProps: { attributes: { class: "composer-input rich-text", role: "textbox", "aria-label": "Thought text", "aria-multiline": "true", "data-placeholder": "What’s on your mind?" } },
    onUpdate: ({ editor: current }) => {
      const value = current.getMarkdown();
      setText(value);
      change?.(value, selected);
      setCursorText({ text: current.state.selection.$from.parent.textContent, offset: current.state.selection.$from.parentOffset });
    },
    onSelectionUpdate: ({ editor: current }) => setCursorText({ text: current.state.selection.$from.parent.textContent, offset: current.state.selection.$from.parentOffset }),
  });
  useEffect(() => { editor?.setEditable(!busy); }, [editor, busy]);
  const inline = hashtags(text), active = activeHashtag(cursorText.text, cursorText.offset);
  function update(value: string, ids = selected) {
    setText(value);
    setSelected(ids);
    if (editor && editor.getMarkdown() !== value) editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    change?.(value, ids);
  }
  function applyFormat(kind: Format) {
    if (!editor || busy) return;
    const chain = editor.chain().focus();
    if (kind === "bold") chain.toggleBold().run();
    else if (kind === "italic") chain.toggleItalic().run();
    else if (kind === "bullet") chain.toggleBulletList().run();
    else if (kind === "number") chain.toggleOrderedList().run();
    else chain.toggleBlockquote().run();
  }
  function remove(tag: Tag) {
    update(
      removeHashtag(text, tag.name),
      selected.filter((id) => id !== tag.id),
    );
  }
  function requestClose() {
    if (pending.current) return;
    if (
      !capture &&
      (text !== initial.text ||
        [
          ...new Set([
            ...selected,
            ...tags
              .filter((t) =>
                hashtags(text).some(
                  (h) => h.name.toLowerCase() === t.name.toLowerCase(),
                ),
              )
              .map((t) => t.id),
          ]),
        ]
          .sort()
          .join() !== [...initial.tagIds].sort().join())
    )
      setConfirm(true);
    else close();
  }
  function insert(name: string) {
    if (!active || !editor) return;
    const to = editor.state.selection.from;
    editor.chain().focus().insertContentAt({ from: to - (cursorText.offset - active.start), to: to + active.end - cursorText.offset }, hashtagText(name) + " ").run();
  }
  async function submit() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await save(text, selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function create() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await bridge.saveTag({ name: tagSearch });
      const lib = await bridge.library();
      const tag = lib.tags.find(
        (t) => t.name.toLowerCase() === tagSearch.trim().toLowerCase(),
      );
      if (tag) update(text, [...selected, tag.id]);
      await refreshTags();
      setTagSearch("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create tag.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={capture ? "Message yourself" : "Edit thought"}
      close={requestClose}
    >
      {confirm ? (
        <div className="confirm">
          <p>Discard your unsaved changes?</p>
          <div className="action-row">
            <button className="secondary" onClick={() => setConfirm(false)}>
              Keep editing
            </button>
            <button className="danger secondary" onClick={close}>
              Discard changes
            </button>
          </div>
        </div>
      ) : (
        <>
          <EditorContent editor={editor} />
          <div className="composer-tools">
            <button type="button" aria-label="Text formatting" aria-expanded={showFormatting}
              disabled={busy} onMouseDown={(e) => e.preventDefault()}
              onClick={() => setShowFormatting(!showFormatting)}>Aa</button>
          </div>
          {showFormatting && (
            <div className="format-toolbar" role="group" aria-label="Formatting options">
              {([
                ["bold", "Bold", Bold], ["italic", "Italic", Italic],
                ["bullet", "Bulleted list", List], ["number", "Numbered list", ListOrdered],
                ["quote", "Quote", Quote],
              ] as const).map(([kind, label, Icon]) => (
                <button key={kind} type="button" aria-label={label} title={label} disabled={busy}
                  aria-pressed={editor?.isActive(({ bold: "bold", italic: "italic", bullet: "bulletList", number: "orderedList", quote: "blockquote" } as const)[kind]) ?? false}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { applyFormat(kind); setShowFormatting(false); }}>
                  <Icon size={20} aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
          {active && (
            <div className="suggestions" aria-label="Hashtag suggestions">
              {tags
                .filter((t) =>
                  t.name.toLowerCase().startsWith(active.query.toLowerCase()),
                )
                .slice(0, 8)
                .map((t) => (
                  <button
                    className="menu-row"
                    key={t.id}
                    onClick={() => insert(t.name)}
                  >
                    # {t.name}
                  </button>
                ))}
              {active.query.trim() &&
                !tags.some(
                  (t) =>
                    t.name.toLowerCase() === active.query.trim().toLowerCase(),
                ) && (
                  <button
                    className="menu-row"
                    onClick={() => insert(active.query.trim())}
                  >
                    <PaperIcon name="plus" size={17} />
                    Use new tag “{active.query.trim()}”
                  </button>
                )}
            </div>
          )}
          <div className="chips">
            {tags
              .filter(
                (t) =>
                  selected.includes(t.id) ||
                  inline.some(
                    (h) => h.name.toLowerCase() === t.name.toLowerCase(),
                  ),
              )
              .map((t) => (
                <button
                  disabled={busy}
                  className="chip selected"
                  key={t.id}
                  aria-label={`Remove tag ${t.name}`}
                  onClick={() => remove(t)}
                >
                  # {t.name}
                  <PaperIcon name="close" size={14} />
                </button>
              ))}
            {inline
              .filter(
                (h, i) =>
                  !tags.some(
                    (t) => t.name.toLowerCase() === h.name.toLowerCase(),
                  ) &&
                  inline.findIndex(
                    (v) => v.name.toLowerCase() === h.name.toLowerCase(),
                  ) === i,
              )
              .map((h) => (
                <button
                  key={h.name}
                  className="chip selected"
                  onClick={() => update(removeHashtag(text, h.name))}
                >
                  # {h.name}
                  <small>new</small>
                  <PaperIcon name="close" size={14} />
                </button>
              ))}
            <button
              disabled={busy}
              className="chip"
              aria-expanded={showTags}
              onClick={() => setShowTags(!showTags)}
            >
              <PaperIcon name="plus" size={15} />
              Add tag
            </button>
          </div>
          {showTags && (
            <div className="tag-selector">
              <input
                aria-label="Find or create tag"
                placeholder="Find or create a tag…"
                maxLength={80}
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
              />
              <div className="tag-results">
                {tags
                  .filter((t) =>
                    t.name.toLowerCase().includes(tagSearch.toLowerCase()),
                  )
                  .map((t) => {
                    const chosen =
                      selected.includes(t.id) ||
                      inline.some(
                        (h) => h.name.toLowerCase() === t.name.toLowerCase(),
                      );
                    return (
                      <button
                        disabled={busy}
                        aria-pressed={chosen}
                        className="menu-row"
                        key={t.id}
                        onClick={() =>
                          chosen ? remove(t) : update(text, [...selected, t.id])
                        }
                      >
                        <Hash size={16} />
                        {t.name}
                        {chosen && <PaperIcon name="check" size={17} />}
                      </button>
                    );
                  })}
                {tagSearch.trim() &&
                  !tags.some(
                    (t) =>
                      t.name.toLowerCase() === tagSearch.trim().toLowerCase(),
                  ) && (
                    <button
                      disabled={busy}
                      className="menu-row"
                      onClick={() => void create()}
                    >
                      <PaperIcon name="plus" size={17} />
                      Create “{tagSearch.trim()}”
                    </button>
                  )}
              </div>
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {error}{" "}
              <button onClick={() => void submit()} disabled={busy}>
                Retry save
              </button>
            </p>
          )}
          <div className="action-row">
            {capture && discard ? (
              <details>
                <summary aria-label="Draft actions">
                  <MoreHorizontal size={22} />
                </summary>
                <button
                  className="danger secondary"
                  onClick={() => {
                    if (window.confirm("Discard this draft?"))
                      void discard()
                        .then(close)
                        .catch((e) => setError(String(e)));
                  }}
                >
                  Discard draft
                </button>
              </details>
            ) : (
              <button
                disabled={busy}
                className="secondary"
                onClick={requestClose}
              >
                Cancel
              </button>
            )}
            <button
              disabled={busy || !text.trim()}
              className="primary"
              onClick={() => void submit()}
            >
              {busy ? "Saving…" : capture ? "Send" : "Save"}
              {capture && <PaperIcon name="send" size={20} />}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
export function TagEditor({
  tag,
  close,
  done,
}: {
  tag: Tag | "new";
  close: () => void;
  done: () => Promise<void>;
}) {
  const [name, setName] = useState(tag === "new" ? "" : tag.name),
    [confirm, setConfirm] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(remove = false) {
    setBusy(true);
    try {
      if (remove && tag !== "new") await bridge.deleteTag({ id: tag.id });
      else
        await bridge.saveTag({ id: tag === "new" ? undefined : tag.id, name });
      await done();
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={tag === "new" ? "New tag" : "Edit tag"}
      close={() => {
        if (!busy) close();
      }}
    >
      <label className="field-label">
        Tag name
        <input
          autoFocus
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {confirm && (
        <p>
          Remove this tag from thoughts, drafts, and widget defaults? Your
          thoughts remain. A picker using it switches to No tag.
        </p>
      )}
      <div className="action-row">
        {tag !== "new" && (
          <button
            disabled={busy}
            className="secondary danger"
            onClick={() => (confirm ? void run(true) : setConfirm(true))}
          >
            {confirm ? "Confirm deletion" : "Delete tag"}
          </button>
        )}
        <button
          disabled={busy || !name.trim()}
          className="primary"
          onClick={() => void run()}
        >
          Save tag
        </button>
      </div>
    </Sheet>
  );
}
