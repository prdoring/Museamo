import { Presence, Disclosure, useExiting, lockOverlay, reducedMotion } from "./Motion";
import { MediaGallery, AttachmentEditor } from "./Media";
import { type Attachment } from "../media";
import { PaperIcon } from "./PaperIcon";
import { ChecklistToggle } from "./Checklist";
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
  Bold, Italic, List, ListOrdered, Quote, MapPin, LoaderCircle,
  Copy,
  Hash,
  MoreHorizontal,
  Pencil,
  Star,
  Trash2,
} from "lucide-react";
import { bridge, isNative, isChecklistEntry, locationLabel, locationStatusMessage, type PostLocation, type Entry, type Tag } from "../data";
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
  const exiting = useExiting();
  const ref = useRef<HTMLElement>(null);
  // Capture before an autoFocus field mounts and replaces the original trigger.
  const trigger = useRef(document.activeElement as HTMLElement | null);
  const exitingRef = useRef(exiting);
  exitingRef.current = exiting;
  const closeRef = useRef(close);
  closeRef.current = exiting ? () => {} : close;
  useEffect(() => {
    const unlock = lockOverlay(trigger.current);
    const focusable = () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
        ) || [],
      );
    (
      ref.current?.querySelector<HTMLElement>("[autofocus],textarea,input") ||
      focusable()[0]
    )?.focus();
    const key = (e: KeyboardEvent) => {
      if (exitingRef.current) return;
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
      unlock();
    };
  }, []);
  return createPortal(
    <div
      className="sheet-backdrop"
      data-exiting={exiting}
      inert={exiting}
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
  checklistCategoryId,
  complete,
  completionPending,
  star,
  edit,
  remove,
  openTag,
  report,
  openLocation,
}: {
  entry: Entry;
  openLocation?: (entry: Entry) => void;
  tags: Tag[];
  checklistCategoryId?: string;
  complete: (entry: Entry) => void;
  completionPending: boolean;
  star: () => void;
  edit: () => void;
  remove: () => void;
  openTag: (id: string) => void;
  report: (message: string) => void;
}) {
  const checklist = isChecklistEntry(entry, tags);
  const compact = checklist && !!checklistCategoryId;
  const visibleTags = tags.filter(t => entry.tagIds.includes(t.id) && (!compact || t.id !== checklistCategoryId));
  const [expanded, setExpanded] = useState(false),
    [overflows, setOverflows] = useState(false),
    [menu, setMenu] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const previousHeight = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = copy.current, from = previousHeight.current;
    if (!el || from === undefined || reducedMotion()) return;
    const animation = el.animate(
      [{ height: `${from}px`, overflow: "hidden" }, { height: `${el.clientHeight}px`, overflow: "hidden" }],
      { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)" },
    );
    return () => animation.cancel();
  }, [expanded]);
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

  const actions = <button
    className="icon-button post-actions"
    aria-label={compact && entry.starred ? "Thought actions, saved to Gems" : "Thought actions"}
    aria-expanded={menu}
    onClick={() => setMenu(!menu)}
  >
    <MoreHorizontal size={21} />
    {compact && entry.starred && <Star className="post-gem-marker" size={10} fill="currentColor" aria-hidden="true" />}
  </button>;

  return (
    <article className={"post" + (checklist ? " post-checklist" : "") + (compact ? " post-compact" : "") + (compact && !entry.text.trim() ? " post-attachment-only" : "")} data-entry-id={entry.id}>
      {!compact && <div className="post-top">
        <time dateTime={new Date(entry.createdAt).toISOString()}>
          {new Date(entry.createdAt).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
          {entry.updatedAt > entry.createdAt + 1000 && " · edited"}
        </time>
        {checklist && <ChecklistToggle entry={entry} pending={completionPending} change={complete} />}
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
        {actions}
      </div>}
      {compact && <ChecklistToggle entry={entry} pending={completionPending} change={complete} />}
      <div className="post-copy" ref={copy}>
      <div
        ref={body}
        className={"post-text rich-text " + (expanded ? "" : "clamped ") + (checklist && entry.completed ? "checklist-completed" : "")}
      >
        <FormattedText
          text={entry.text}
          tags={tags.filter((t) => entry.tagIds.includes(t.id))}
          openTag={openTag}
          report={report}
        />
      </div>
      </div>
      {compact && actions}
      {overflows && (
        <button className="text-button" onClick={() => { previousHeight.current = copy.current?.getBoundingClientRect().height; setExpanded(!expanded); }}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {!compact && entry.location && <button className="location-label" onClick={() => openLocation?.(entry)}>⌖ {locationLabel(entry.location)}</button>}
      <MediaGallery attachments={entry.attachments} text={entry.text} />
      {!!visibleTags.length && (
        <div className="chips post-tags">
          {visibleTags.map((t) => (
              <button className="chip" key={t.id} onClick={() => openTag(t.id)}>
                # {t.name}
              </button>
            ))}
        </div>
      )}
      <Presence>{menu && (
        <Sheet title="Thought actions" close={() => setMenu(false)}>
          {compact && <>
            <p className="post-details"><time dateTime={new Date(entry.createdAt).toISOString()}>
              {new Date(entry.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
              {entry.updatedAt > entry.createdAt + 1000 && " · edited"}
            </time></p>
            <button className="menu-row" onClick={() => { setMenu(false); star(); }}>
              <Star size={19} fill={entry.starred ? "currentColor" : "none"} />
              {entry.starred ? "Remove from Gems" : "Save to Gems"}
            </button>
            {entry.location && <button className="menu-row" onClick={() => { setMenu(false); openLocation?.(entry); }}>
              <MapPin size={19} />
              {locationLabel(entry.location)}
            </button>}
          </>}
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
      )}</Presence>
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
  initial: { text: string; tagIds: string[]; attachments?: Attachment[]; location?: PostLocation | null };
  tags: Tag[];
  capture?: boolean;
  change?: (text: string, ids: string[], attachments: Attachment[], location?: PostLocation | null) => void;
  save: (text: string, ids: string[], attachments: Attachment[], location?: PostLocation | null) => Promise<void>;
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
  const [location, setLocation] = useState(initial.location);
  const [locating, setLocating] = useState(false);
  const [showLocation, setShowLocation] = useState(false);
  const [locationMessage, setLocationMessage] = useState("");
  const locationRequest = useRef(0);
  useEffect(() => () => { ++locationRequest.current; }, []);
  const locationEdited = useRef(false);
  function changeLocation(next: PostLocation | null) { ++locationRequest.current; setLocating(false); locationEdited.current = true; setLocationMessage(""); setLocation(next); change?.(text, selected, attachments, next); }
  async function requestLocation() {
    const request = ++locationRequest.current; setLocating(true); setLocationMessage("");
    try {
      const result = await bridge.currentLocation();
      if (request !== locationRequest.current || pending.current) return;
      if (result.location) { changeLocation(result.location); setShowLocation(false); }
      else setLocationMessage(locationStatusMessage(result.status));
    } catch (e) { if (request === locationRequest.current) setLocationMessage(String(e)); }
    finally { if (request === locationRequest.current) setLocating(false); }
  }
  const [attachments, setAttachments] = useState(initial.attachments || []);
  const [importing, setImporting] = useState(false);
  const [mediaToolbar, setMediaToolbar] = useState<HTMLSpanElement | null>(null);
  // Pins belong to the entire edit session, including the discard-confirmation screen.
  const stagedMedia = useRef<string[]>([]);
  useEffect(() => () => { void bridge.releaseMedia({ ids: stagedMedia.current }); }, []);
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
      change?.(value, selected, attachments);
      setCursorText({ text: current.state.selection.$from.parent.textContent, offset: current.state.selection.$from.parentOffset });
    },
    onSelectionUpdate: ({ editor: current }) => setCursorText({ text: current.state.selection.$from.parent.textContent, offset: current.state.selection.$from.parentOffset }),
  });
  // Editability changes are UI state, not draft edits (especially during exit).
  useEffect(() => { editor?.setEditable(!busy && !importing, false); }, [editor, busy, importing]);
  const inline = hashtags(text), active = activeHashtag(cursorText.text, cursorText.offset);
  function update(value: string, ids = selected) {
    setText(value);
    setSelected(ids);
    if (editor && editor.getMarkdown() !== value) editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    change?.(value, ids, attachments);
  }
  function applyFormat(kind: Format) {
    if (!editor || busy || importing) return;
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
    if (pending.current || importing) return;
    if (
      !capture &&
      (locationEdited.current || text !== initial.text || attachments.map(a => a.id).join() !== (initial.attachments || []).map(a => a.id).join() ||
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
      ++locationRequest.current;
      await save(text, selected, attachments, locationEdited.current ? location ?? null : undefined);
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
          {(location || locating || locationMessage) && <p className="composer-location-status" role="status">{locating ? "Finding location…" : locationMessage || (location ? locationLabel(location) : "")}</p>}
          <Presence>{showLocation && location && <Disclosure><div className="location-editor">
            <label>Place name <input maxLength={500} disabled={busy} value={location.userLabel || ""} placeholder="Optional place name" onChange={e => changeLocation({ ...location, userLabel: e.target.value })} /></label>
            <button disabled={busy || locating} onClick={() => void requestLocation()}>Refresh location</button>
            <button disabled={busy} onClick={() => { changeLocation(null); setShowLocation(false); }}>Remove location</button>
          </div></Disclosure>}</Presence>
          <AttachmentEditor toolbar={mediaToolbar} attachments={attachments} disabled={busy || importing} report={setError} importing={setImporting} retain={ids => stagedMedia.current.push(...ids)} change={items => { setAttachments(items); change?.(text, selected, items); }} />
          {importing && <p role="status">Importing media… Keep this screen open.</p>}
          <Presence>{showFormatting && (
            <Disclosure>
            <div className="format-toolbar" role="group" aria-label="Formatting options">
              {([
                ["bold", "Bold", Bold], ["italic", "Italic", Italic],
                ["bullet", "Bulleted list", List], ["number", "Numbered list", ListOrdered],
                ["quote", "Quote", Quote],
              ] as const).map(([kind, label, Icon]) => (
                <button key={kind} type="button" aria-label={label} title={label} disabled={busy || importing}
                  aria-pressed={editor?.isActive(({ bold: "bold", italic: "italic", bullet: "bulletList", number: "orderedList", quote: "blockquote" } as const)[kind]) ?? false}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { applyFormat(kind); setShowFormatting(false); }}>
                  <Icon size={20} aria-hidden="true" />
                </button>
              ))}
            </div>
            </Disclosure>
          )}</Presence>
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
                  disabled={busy || importing}
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
          </div>
          <Presence>{showTags && (
            <Disclosure>
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
                        disabled={busy || importing}
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
                      disabled={busy || importing}
                      className="menu-row"
                      onClick={() => void create()}
                    >
                      <PaperIcon name="plus" size={17} />
                      Create “{tagSearch.trim()}”
                    </button>
                  )}
              </div>
            </div>
            </Disclosure>
          )}</Presence>
          {error && (
            <p className="error" role="alert">
              {error}{" "}
              <button onClick={() => void submit()} disabled={busy || importing}>
                Retry save
              </button>
            </p>
          )}
          <div className="composer-bar">
            <span className="composer-media-action" ref={setMediaToolbar} />
            <button className="composer-icon" type="button" aria-label="Text formatting" aria-expanded={showFormatting} disabled={busy || importing} onMouseDown={e => e.preventDefault()} onClick={() => { setShowFormatting(!showFormatting); setShowTags(false); setShowLocation(false); }}>Aa</button>
            <button className="composer-icon" type="button" aria-label="Add tag" aria-expanded={showTags} disabled={busy || importing} onClick={() => { setShowTags(!showTags); setShowFormatting(false); setShowLocation(false); }}><Hash size={22} /></button>
            <button className={"composer-icon location-toggle" + (location ? " has-location" : "")} type="button" aria-label={locating ? "Finding location" : "Post location"} aria-expanded={showLocation} disabled={busy || importing || locating} onClick={() => {
              setShowFormatting(false); setShowTags(false);
              if (location) setShowLocation(!showLocation); else void requestLocation();
            }}>{locating ? <LoaderCircle className="location-spinner" size={22} /> : <MapPin size={22} />}</button>
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
            ) : null}
            <span className="composer-spacer" />
            <button
              disabled={busy || importing || (!text.trim() && !attachments.length)}
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
    [type, setType] = useState<Tag["type"]>(tag === "new" ? "standard" : tag.type),
    [confirm, setConfirm] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(remove = false) {
    setBusy(true);
    try {
      if (remove && tag !== "new") await bridge.deleteTag({ id: tag.id });
      else
        await bridge.saveTag({ id: tag === "new" ? undefined : tag.id, name, type });
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
      <button
        type="button"
        className="checklist-setting"
        role="switch"
        aria-checked={type === "checklist"}
        aria-label="Checklist"
        aria-describedby="checklist-setting-description"
        disabled={busy}
        onClick={() => setType(type === "checklist" ? "standard" : "checklist")}
      >
        <span><strong>Checklist</strong><span id="checklist-setting-description">Check off thoughts with this tag.</span></span>
        <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      </button>
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
