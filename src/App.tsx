import { Presence, PageMotion, Disclosure } from "./components/Motion";
import { PaperIcon } from "./components/PaperIcon";
import { useEffect, useRef, useState } from "react";
import {
  ListChecks,
  MoreHorizontal,
  Search,
} from "lucide-react";
import {
  bridge,
  filterEntries,
  isNative,
  preview,
  type Draft,
  type Entry,
  type Library,
  type Tag,
} from "./data";
import { LocationMap } from "./components/LocationMap";
import { Editor, TagEditor, Sheet } from "./components/Thoughts";

import { Navigation, type Tab } from "./components/Navigation";
import { Feed } from "./components/Feed";
import { Settings } from "./components/Settings";
import { SearchField, TagList } from "./components/LibraryViews";
type View = { tab: Tab; tagId?: string; query: string; settings?: boolean; checklistOnly?: boolean };
export default function App() {
  const [previewTheme, setPreviewTheme] = useState<"system" | "light" | "dark">("system");
  useEffect(() => {
    if (isNative) return;
    if (previewTheme === "system") delete document.documentElement.dataset.previewTheme;
    else document.documentElement.dataset.previewTheme = previewTheme;
    return () => { delete document.documentElement.dataset.previewTheme; };
  }, [previewTheme]);
  const [view, setView] = useState<View>({ tab: "stream", query: "" });
  const [entries, setEntries] = useState<Entry[]>([]),
    [library, setLibrary] = useState<Library>({ tags: [], profiles: [] });
  const [search, setSearch] = useState(false),
    [loading, setLoading] = useState(true),
    [more, setMore] = useState(false),
    [newThoughts, setNewThoughts] = useState(false);
  const [mapFocus, setMapFocus] = useState<Entry>();
  const [editing, setEditing] = useState<Entry>(),
    [draft, setDraft] = useState<Draft>(),
    [tagEditor, setTagEditor] = useState<Tag | "new">();
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [deleted, setDeleted] = useState<Entry[]>([]),
    [showStream, setShowStream] = useState(false);
  const [pendingCompletions, setPendingCompletions] = useState<ReadonlySet<string>>(new Set());
  const completionRequests = useRef(new Set<string>());
  const [retry, setRetry] = useState<() => void>();
  const viewRef = useRef(view);
  viewRef.current = view;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const version = useRef(0),
    selfMutation = useRef(0),
    composing = useRef(false),
    pendingStars = useRef(new Set<string>()),
    loadingRequest = useRef(0);
  const paginationValid = useRef(false);
  const positions = useRef(new Map<string, number>()),
    cache = useRef(new Map<string, { entries: Entry[]; more: boolean }>());
  const key = (v: View) =>
    `${v.settings ? "settings" : v.tab}/${v.tagId || ""}/${v.query}/${v.checklistOnly ? "todos" : "all"}`;
  const tag = library.tags.find((t) => t.id === view.tagId);
  const modal = !!mapFocus || !!editing || !!draft || !!tagEditor;
  async function refreshLibrary() {
    setLibrary(await bridge.library());
  }
  async function load(append = false, keepPosition = false, movedId?: string) {
    if (append && (!paginationValid.current || loadingRequest.current || completionRequests.current.size)) return;
    const request = ++version.current,
      current = viewRef.current;
    loadingRequest.current = request;
    if (!append) { paginationValid.current = false; setMore(false); }
    const last = append ? entriesRef.current.at(-1) : undefined;
    const scroll = window.scrollY;
    const anchor = keepPosition ? [...document.querySelectorAll<HTMLElement>("[data-entry-id]")]
      .find(el => el.dataset.entryId !== movedId && el.getBoundingClientRect().bottom > 0) : undefined;
    const anchorId = anchor?.dataset.entryId, anchorTop = anchor?.getBoundingClientRect().top;
    setLoading(true);
    try {
      // Read the current type before choosing both the order and its cursor.
      const lib = await bridge.library();
      if (version.current !== request) return;
      const checklist = lib.tags.some(t => t.id === current.tagId && t.type === "checklist");
      const page = await bridge.queryEntries({
          order: checklist ? "checklist" : "newest",
          starred: current.tab === "gems",
          checklistOnly: current.tab === "stream" && !!current.checklistOnly,
          tagId: current.tagId,
          search: current.query,
          limit: !append && keepPosition ? Math.max(50, entriesRef.current.length) : 50,
          beforeTime: last?.createdAt,
          beforeId: last?.id,
          beforeCompleted: checklist ? last?.completed : undefined,
        });
      if (version.current !== request) return;
      const next = append
        ? [
            ...entriesRef.current,
            ...page.entries.filter(
              (e) => !entriesRef.current.some((old) => old.id === e.id),
            ),
          ]
        : page.entries;
      setEntries(next);
      paginationValid.current = true;
      setMore(page.hasMore);
      setLibrary(lib);
      setNewThoughts(false);
      cache.current.set(key(current), { entries: next, more: page.hasMore });
      if (keepPosition) requestAnimationFrame(() => {
        if (version.current !== request) return;
        const nextAnchor = anchorId ? document.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(anchorId)}"]`) : null;
        window.scrollTo(0, nextAnchor && anchorTop !== undefined ? window.scrollY + nextAnchor.getBoundingClientRect().top - anchorTop : scroll);
      });
      if (current.tagId && !lib.tags.some((t) => t.id === current.tagId))
        setView({ tab: "tags", query: "" });
    } catch (e) {
      if (version.current === request) failure(e, () => void load(append, keepPosition));
    } finally {
      if (loadingRequest.current === request) loadingRequest.current = 0;
      if (version.current === request) setLoading(false);
    }
  }
  function failure(e: unknown, action?: () => void) {
    setError(e instanceof Error ? e.message : String(e));
    setRetry(() => action);
  }
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    ++version.current;
    loadingRequest.current = 0;
    const existing = cache.current.get(key(view));
    if (existing) {
      paginationValid.current = true;
      setEntries(existing.entries);
      setMore(existing.more);
      setLoading(false);
    } else {
      setEntries([]);
      void load();
    }
    requestAnimationFrame(() =>
      window.scrollTo(0, positions.current.get(key(view)) || 0),
    );
  }, [view.tab, view.tagId, view.query, view.settings, view.checklistOnly]);
  useEffect(() => {
    let disposed = false;
    let remove: (() => Promise<void>) | undefined;
    function changed() {
      if (selfMutation.current || composing.current) return;
      cache.current.clear();
      if (viewRef.current.tagId || viewRef.current.checklistOnly) {
        void loadRef.current(false, true);
      } else if (window.scrollY > 120) {
        setNewThoughts(true);
        void refreshLibrary();
      } else void loadRef.current(false, true);
    }
    void bridge.addListener("dataChanged", changed).then((handle) => {
      if (disposed) void handle.remove();
      else remove = handle.remove;
    });
    const resume = () => {
      if (document.visibilityState === "visible") changed();
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true;
      void remove?.();
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      document.documentElement.style.setProperty(
        "--viewport-height",
        `${viewport?.height || window.innerHeight}px`,
      );
      document.documentElement.style.setProperty(
        "--viewport-top",
        `${viewport?.offsetTop || 0}px`,
      );
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
    };
  }, []);
  function navigate(next: View) {
    positions.current.set(key(view), window.scrollY);
    if (paginationValid.current) cache.current.set(key(view), { entries, more });
    setView(next);
    setSearch(!!next.query);
    setError("");
    setNewThoughts(false);
  }
  useEffect(() => {
    const back = (event: Event) => {
      if (document.querySelector('[role="dialog"]')) return;
      if (search) {
        event.preventDefault();
        setSearch(false);
        setView((v) => ({ ...v, query: "" }));
      } else if (view.settings || view.tagId || view.tab !== "stream") {
        event.preventDefault();
        navigate({ tab: view.tagId ? "tags" : "stream", query: "" });
      }
    };
    window.addEventListener("museamoBack", back);
    return () => window.removeEventListener("museamoBack", back);
  }, [view, search]);
  function openTag(id: string) {
    navigate({ tab: "tags", tagId: id, query: "" });
  }
  async function mutate(action: () => Promise<unknown>, after?: () => void) {
    selfMutation.current++;
    setError("");
    try {
      await action();
      cache.current.clear();
      await refreshLibrary();
      after?.();
    } catch (e) {
      failure(e, () => void mutate(action, after));
      throw e;
    } finally {
      selfMutation.current--;
    }
  }
  async function star(entry: Entry) {
    if (pendingStars.current.has(entry.id)) return;
    pendingStars.current.add(entry.id);
    setEntries((old) =>
      old.map((e) => (e.id === entry.id ? { ...e, starred: !e.starred } : e)),
    );
    try {
      await mutate(
        () => bridge.setStar({ id: entry.id, starred: !entry.starred }),
        () => {
          if (view.tab === "gems" && entry.starred)
            setEntries((old) => old.filter((e) => e.id !== entry.id));
        },
      );
    } catch {
      setEntries((old) => old.map((e) => (e.id === entry.id ? { ...e, starred: entry.starred } : e)));
      setRetry(() => () => void star(entry));
    } finally {
      pendingStars.current.delete(entry.id);
    }
  }
  async function remove(entry: Entry) {
    try {
      await mutate(
        () => bridge.deleteEntry({ id: entry.id }),
        () => {
          setEntries((old) => old.filter((e) => e.id !== entry.id));
          setDeleted((old) => [...old, entry]);
        },
      );
    } catch {
      /* visible retry */
    }
  }
  async function complete(entry: Entry) {
    if (completionRequests.current.has(entry.id)) return;
    completionRequests.current.add(entry.id);
    setPendingCompletions(new Set(completionRequests.current));
    selfMutation.current++;
    ++version.current;
    paginationValid.current = false;
    setMore(false);
    loadingRequest.current = 0;
    setLoading(false);
    cache.current.clear();
    setError("");
    const completed = !entry.completed;
    function update(value: boolean) {
      setEntries(old => old.map(e => e.id === entry.id ? { ...e, completed: value } : e));
      setMapFocus(old => old?.id === entry.id ? { ...old, completed: value } : old);
    }
    update(completed);
    try {
      await bridge.setCompleted({ id: entry.id, completed });
      cache.current.clear();
    } catch (e) {
      update(entry.completed);
      failure(e, () => void complete(entry).catch(() => {}));
      throw e;
    } finally {
      completionRequests.current.delete(entry.id);
      setPendingCompletions(new Set(completionRequests.current));
      // Refresh the full loaded prefix before deriving another pagination cursor.
      // Wait for the last toggle when several independent items are being saved.
      if (!completionRequests.current.size && viewRef.current.tab !== "map")
        await load(false, true, entry.id);
      selfMutation.current--;
    }
  }
  async function saved(id?: string) {
    cache.current.clear();
    const entry = id ? (await bridge.getEntry({ id })).entry : null;
    const lib = await bridge.library();
    setLibrary(lib);
    const matches =
      entry &&
      (!viewRef.current.tagId ||
        entry.tagIds.includes(viewRef.current.tagId)) &&
      (viewRef.current.tab !== "gems" || entry.starred) &&
      (!viewRef.current.checklistOnly || filterEntries([entry], { checklistOnly: true }, lib.tags).length > 0) &&
      (!viewRef.current.query ||
        filterEntries([entry], { search: viewRef.current.query }).length > 0);
    if (matches) {
      window.scrollTo(0, 0);
      await load();
    } else {
      setNotice("Thought saved.");
      setShowStream(true);
      await refreshLibrary();
    }
  }
  async function compose() {
    if (composing.current) return;
    composing.current = true;
    try {
      if (isNative) {
        const result = await bridge.compose({ tagId: view.tagId });
        if (!result.cancelled) await saved(result.entryId);
      } else setDraft((await bridge.getDraft({ tagId: view.tagId })).draft);
    } catch (e) {
      failure(e, () => void compose());
    } finally {
      composing.current = false;
    }
  }
  return (
    <div className="app-shell">
      <div inert={modal}>
        {!isNative && (
          <div className="preview-strip">
            <span>Preview · resets on refresh</span>
            <button onClick={() => setPreviewTheme(previewTheme === "system" ? "light" : previewTheme === "light" ? "dark" : "system")} aria-label="Change preview theme">Theme: {previewTheme}</button>
            <button
              onClick={() => {
                cache.current.clear();
                preview.reset();
                void load();
              }}
            >
              Reset examples
            </button>
          </div>
        )}
        <header className="toolbar">
          <div className="toolbar-title">
            {(view.tagId || view.settings) && (
              <button
                className="icon-button"
                aria-label="Back"
                onClick={() =>
                  navigate({ tab: view.tagId ? "tags" : view.tab, query: "", checklistOnly: view.checklistOnly })
                }
              >
                <PaperIcon name="back" size={21} />
              </button>
            )}
            {view.settings && <PaperIcon name="gear" size={22} />}
            <h1 className={tag ? "dynamic-title" : undefined}>
              {view.settings
                ? "Settings"
                : tag
                  ? tag.name
                  : view.tab === "map" ? "Map" : view.tab === "gems"
                    ? "Gems"
                    : view.tab === "tags"
                      ? "Tags"
                      : "museamo"}
            </h1>
          </div>
          <div className="toolbar-actions">
            {view.tab === "stream" && !view.settings && (
              <button
                className="icon-button stream-filter"
                aria-label="To-dos only"
                title="To-dos only"
                aria-pressed={!!view.checklistOnly}
                onClick={() => navigate({ ...view, checklistOnly: !view.checklistOnly })}
              ><ListChecks size={21} aria-hidden="true" /></button>
            )}
            {tag && (
              <button
                className="icon-button"
                aria-label="Edit this tag"
                onClick={() => setTagEditor(tag)}
              >
                <MoreHorizontal size={21} />
              </button>
            )}
            {!view.settings && (
              <button
                className="icon-button"
                aria-label="Search"
                aria-expanded={search}
                onClick={() => {
                  setSearch(!search);
                  if (search && view.query) navigate({ ...view, query: "" });
                }}
              >
                <Search size={21} />
              </button>
            )}
            <button
              className="icon-button"
              aria-label={view.settings ? "Close settings" : "Settings"}
              onClick={() =>
                navigate({ tab: view.tab, query: "", settings: !view.settings, checklistOnly: view.checklistOnly })
              }
            >
              {view.settings ? <PaperIcon name="close" size={21} /> : <PaperIcon name="gear" size={21} />}
            </button>
          </div>
        </header>
        <main>
          <Presence>{search && !view.settings && (
            <Disclosure>
            <SearchField
              tags={view.tab === "tags" && !tag}
              query={view.query}
              change={(query) => setView({ ...view, query })}
            />
            </Disclosure>
          )}</Presence>
          {error && (
            <div className="error" role="alert">
              {error}
              <div>
                {retry && <button onClick={retry}>Retry</button>}
                <button onClick={() => setError("")}>Dismiss</button>
              </div>
            </div>
          )}
          <PageMotion view={`${view.settings ? "settings" : view.tab}/${view.tagId || ""}`}>
          {view.settings ? (
            <Settings
              library={library}
              report={setNotice}
              run={async (fn) => {
                try {
                  await mutate(fn);
                } catch {
                  /* visible */
                }
              }}
              refresh={() => {
                cache.current.clear();
                void load();
              }}
            />
          ) : view.tab === "map" ? (
            <LocationMap query={view.query} tags={library.tags} edit={setEditing} complete={complete} pendingCompletions={pendingCompletions} />
          ) : view.tab === "tags" && !view.tagId ? (
            <TagList
              tags={library.tags}
              query={view.query}
              open={openTag}
              edit={setTagEditor}
            />
          ) : (
            <Feed
              entries={entries}
              checklist={tag?.type === "checklist"}
              categoryId={tag?.id}
              complete={e => void complete(e).catch(() => {})}
              pendingCompletions={pendingCompletions}
              openLocation={setMapFocus}
              tags={library.tags}
              loading={loading}
              more={more}
              newThoughts={newThoughts}
              query={view.query}
              gems={view.tab === "gems"}
              todosOnly={view.tab === "stream" && !!view.checklistOnly}
              reload={() => {
                window.scrollTo(0, 0);
                void load();
              }}
              older={() => void load(true)}
              star={(e) => void star(e)}
              edit={setEditing}
              remove={(e) => void remove(e)}
              openTag={openTag}
              report={setNotice}
            />
          )}
          </PageMotion>
        </main>
        <Navigation
          tab={view.tab}
          settings={view.settings}
          tagName={tag?.name}
          compose={() => void compose()}
          navigate={(tab) => navigate({ tab, query: "" })}
        />
        {(notice || deleted.length > 0 || showStream) && (
          <aside className="notifications" aria-label="Notifications">
            {(notice || showStream) && (
              <div className="toast" role="status">
                <span>{notice || "Thought saved."}</span>
                {showStream && (
                  <button
                    onClick={() => {
                      setShowStream(false);
                      cache.current.clear();
                      const next: View = { tab: "stream", query: "" };
                      positions.current.set(key(next), 0);
                      viewRef.current = next;
                      setView(next);
                      window.scrollTo(0, 0);
                      void loadRef.current();
                    }}
                  >
                    View in Stream
                  </button>
                )}
                <button
                  className="icon-button"
                  aria-label="Dismiss notification"
                  onClick={() => {
                    setNotice("");
                    setShowStream(false);
                  }}
                >
                  <PaperIcon name="close" size={17} />
                </button>
              </div>
            )}
            {deleted.map((e) => (
              <div className="toast" key={e.id} role="status">
                <span>
                  Deleted: {e.text.slice(0, 28) || `${e.attachments?.length || 0} attachment(s)`}
                  {e.text.length > 28 ? "…" : ""}
                </span>
                <button
                  onClick={() =>
                    void mutate(
                      () => bridge.restoreEntry({ entry: e }),
                      () => {
                        setDeleted((old) => old.filter((d) => d.id !== e.id));
                        void load(false, true);
                      },
                    ).catch(() => {})
                  }
                >
                  Undo
                </button>
                <button
                  className="icon-button"
                  aria-label="Dismiss deletion"
                  onClick={() =>
                    { void bridge.releaseDeleted({ id: e.id }).catch(failure); setDeleted((old) => old.filter((d) => d.id !== e.id)); }
                  }
                >
                  <PaperIcon name="close" size={17} />
                </button>
              </div>
            ))}
          </aside>
        )}
      </div>
      <Presence>{mapFocus && <Sheet title="Post location" close={() => setMapFocus(undefined)}><LocationMap focus={mapFocus} tags={library.tags} complete={complete} pendingCompletions={pendingCompletions} edit={entry => { setMapFocus(undefined); setEditing(entry); }} /></Sheet>}</Presence>
      <Presence>{editing && (
        <Editor
          key={editing.id}
          initial={editing}
          tags={library.tags}
          refreshTags={refreshLibrary}
          close={() => setEditing(undefined)}
          save={async (text, tagIds, attachments, location) => {
            const entry = editing;
            await mutate(() =>
              bridge.updateEntry({ id: entry.id, text, tagIds, ...(location !== undefined ? { location } : {}), attachmentIds: attachments.map(a => a.id) }),
            );
            const updated = (await bridge.getEntry({ id: entry.id })).entry;
            setEntries((old) =>
              old.flatMap((e) =>
                e.id !== entry.id
                  ? [e]
                  : updated &&
                      (!view.checklistOnly || filterEntries([updated], { checklistOnly: true }, library.tags).length > 0) &&
                      (!view.tagId || updated.tagIds.includes(view.tagId)) &&
                      (!view.query ||
                        filterEntries([updated], { search: view.query }).length > 0)
                    ? [updated]
                    : [],
              ),
            );
            setEditing(undefined);
          }}
        />
      )}</Presence>
      <Presence>{draft && (
        <Editor
          key={draft.entryId}
          capture
          initial={draft}
          tags={library.tags}
          refreshTags={refreshLibrary}
          close={() => setDraft(undefined)}
          discard={() => bridge.discardDraft({ profileKey: draft.profileKey })}
          change={(text, tagIds, attachments, location) => {
            const next = { ...draft, text, tagIds, attachments, ...(location !== undefined ? { location } : {}) };
            // An exiting editor can still finish an async update; never reopen it.
            setDraft(current => current?.entryId === draft.entryId ? next : current);
            void bridge.updateDraft({ ...next, attachmentIds: attachments.map(a => a.id) }).catch(failure);
          }}
          save={async (text, tagIds, attachments, location) => {
            selfMutation.current++;
            try {
              const id = preview.save({ ...draft, text, tagIds, attachments, ...(location !== undefined ? { location } : {}) });
              setDraft(undefined);
              await saved(id);
            } finally {
              selfMutation.current--;
            }
          }}
        />
      )}</Presence>
      <Presence>{tagEditor && (
        <TagEditor
          tag={tagEditor}
          close={() => setTagEditor(undefined)}
          done={async () => {
            cache.current.clear();
            await load(false, true);
          }}
        />
      )}</Presence>
    </div>
  );
}
