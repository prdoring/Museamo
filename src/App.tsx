import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Download, Feather, Hash, MoreHorizontal, Plus, Search, Settings, Sparkles, Star, Trash2, Upload, X } from 'lucide-react';
import { bridge, dayLabel, filterEntries, isNative, previewEntries, previewTags, type Entry, type Library, type Tag } from './data';

type Tab = 'stream' | 'gems' | 'tags';
export default function App() {
  const [tab, setTab] = useState<Tab>('stream');
  const [query, setQuery] = useState('');
  const [selectedTag, setSelectedTag] = useState<string>();
  const [entries, setEntries] = useState<Entry[]>(isNative ? [] : previewEntries);
  const [library, setLibrary] = useState<Library>({ tags: isNative ? [] : previewTags, profiles: [] });
  const [settings, setSettings] = useState(false);
  const [editing, setEditing] = useState<Entry>();
  const [tagEditor, setTagEditor] = useState<Tag | 'new'>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleted, setDeleted] = useState<Entry>();
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pageSize = useRef(50);
  const latestReload = useRef<() => Promise<void>>(async () => {});

  async function reload() {
    if (!isNative) return;
    const current = ++generation.current;
    try {
      const [data, lib] = await Promise.all([bridge.queryEntries({ search: query, starred: tab === 'gems', tagId: selectedTag, limit: pageSize.current }), bridge.library()]);
      if (current !== generation.current) return;
      setEntries(data.entries); setHasMore(data.hasMore); setLibrary(lib);
      if (selectedTag && !lib.tags.some(t => t.id === selectedTag)) setSelectedTag(undefined);
    } catch (e) { setError(message(e)); }
  }
  latestReload.current = reload;
  useEffect(() => { pageSize.current = 50; void reload(); }, [query, tab, selectedTag]);
  useEffect(() => {
    let disposed = false;
    let remove: (() => void) | undefined;
    if (isNative) bridge.addListener('dataChanged', () => void latestReload.current()).then(h => { if (disposed) void h.remove(); else remove = () => void h.remove(); }).catch(e => setError(message(e)));
    const resume = () => { if (document.visibilityState === 'visible') void latestReload.current(); };
    document.addEventListener('visibilitychange', resume);
    return () => { disposed = true; remove?.(); document.removeEventListener('visibilitychange', resume); };
  }, []);
  useEffect(() => { if (!notice) return; const id = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(id); }, [notice]);
  useEffect(() => {
    if (!editing && !tagEditor) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { setEditing(undefined); setTagEditor(undefined); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button:not(:disabled), [role="dialog"] input, [role="dialog"] textarea'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; previous?.focus(); };
  }, [!!editing, !!tagEditor, busy]);

  async function run(action: () => Promise<unknown>, success?: string): Promise<boolean> {
    if (!isNative) { setNotice('Design preview — install the Android app to save thoughts.'); return false; }
    setBusy(true); setError('');
    try { await action(); await reload(); if (success) setNotice(success); return true; }
    catch (e) { setError(message(e)); return false; }
    finally { setBusy(false); }
  }
  function navigate(next: Tab) { setTab(next); setSelectedTag(undefined); setQuery(''); setSettings(false); }
  const shown = isNative ? entries : filterEntries(entries, { search: query, starred: tab === 'gems', tagId: selectedTag });
  const tagName = library.tags.find(t => t.id === selectedTag)?.name;
  const title = settings ? 'Your space' : tagName || (tab === 'gems' ? 'The keepers.' : tab === 'tags' ? 'A little order.' : 'Let it wander.');

  return <div className="app-shell">
    {!isNative && <div className="preview-banner">Browser preview · example thoughts · nothing is stored</div>}
    <header inert={!!editing || !!tagEditor}><a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('stream'); }}><span className="brand-mark"><Feather size={19}/></span> museamo<span className="brand-dot">.</span></a><button className="icon-button" aria-label={settings ? 'Close settings' : 'Settings'} onClick={() => setSettings(!settings)}>{settings ? <X/> : <Settings size={21}/>}</button></header>
    <main inert={!!editing || !!tagEditor}>
      <div className="eyebrow">{settings ? 'MAKE YOURSELF AT HOME' : tagName ? 'YOUR COLLECTION' : tab === 'gems' ? 'WORTH COMING BACK TO' : tab === 'tags' ? 'FOLLOW A THREAD' : 'A PLACE FOR PASSING THOUGHTS'}</div>
      <div className="title-row">{selectedTag && <button className="icon-button" aria-label="Back to tags" onClick={() => setSelectedTag(undefined)}><ArrowLeft/></button>}<h1>{title}</h1></div>
      <p className="subtitle">{settings ? 'On your phone. On your terms.' : tagName ? 'Different moments. A common thread.' : tab === 'gems' ? 'The ones you wanted to hold onto.' : tab === 'tags' ? 'Make room for all the things you notice.' : 'Big ideas, odd words, tiny observations. All welcome.'}</p>
      {error && <div className="error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error"><X size={18}/></button></div>}
      {settings ? <section className="settings-stack">
        <div className="settings-card"><div className="section-heading"><h2>Homescreen widgets</h2><span className="pill">YOUR SHORTCUTS</span></div><p>Add a Museamo widget from your launcher’s widget menu. Each one can have its own tags, or a tag picker.</p>
          {library.profiles.map(p => <button className="profile-row" key={p.id} onClick={() => void run(() => bridge.configureWidget({ profileId: p.id }))}><span><strong>{p.label}</strong><small>{p.mode === 'picker' ? 'Tag picker' : p.tagIds.map(id => library.tags.find(t => t.id === id)?.name).filter(Boolean).join(', ') || 'No tag'}</small></span><ArrowUpRight size={20}/></button>)}
          {!library.profiles.length && <p className="muted">Your configured widgets will appear here.</p>}
        </div>
        <div className="settings-card"><h2>A copy to keep</h2><p>Export your thoughts, gems, tags, and widget profiles to a JSON file. Imports preserve conflicting content as a separate copy.</p><div className="button-row"><button disabled={busy} className="secondary" onClick={() => void run(async () => { const r = await bridge.exportBackup(); if (!r.cancelled) setNotice('Backup exported.'); })}><Download size={17}/> Export</button><button disabled={busy} className="secondary" onClick={() => void run(async () => { const r = await bridge.importBackup(); if (!r.cancelled) setNotice('Backup imported.'); })}><Upload size={17}/> Import</button></div></div>
        <div className="privacy-note"><span className="status-dot"/>Stored on this device. No account. No background uploads.<p>Keep an export somewhere safe: uninstalling the app removes its local data.</p></div>
      </section> : <>
        <label className="search-box"><Search size={19}/><input aria-label={tab === 'tags' && !selectedTag ? 'Search tags' : 'Search thoughts'} placeholder={tab === 'tags' && !selectedTag ? 'Find a tag…' : 'Find a thought…'} value={query} onChange={e => setQuery(e.target.value)}/>{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={17}/></button>}</label>
        {tab === 'tags' && !selectedTag ? <section className="tag-grid">
          {library.tags.filter(t => t.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(t => <div className="tag-card" key={t.id}><button className="tag-open" onClick={() => { setSelectedTag(t.id); setQuery(''); }}><Hash size={23}/><strong>{t.name}</strong><ArrowUpRight size={18}/></button><button className="icon-button" aria-label={`Edit tag ${t.name}`} onClick={() => setTagEditor(t)}><MoreHorizontal size={18}/></button></div>)}
          <button className="new-tag" onClick={() => setTagEditor('new')}><Plus size={20}/> New tag</button>
        </section> : <section className="stream" aria-label="Thoughts">
          {!shown.length && <div className="empty-state"><Feather size={32}/><h2>{tab === 'gems' ? 'A gem will find its way here.' : query ? 'Nothing here just yet.' : 'What crossed your mind?'}</h2><p>{tab === 'gems' ? 'Star a thought in your stream to keep it close.' : query ? 'Try a different word or phrase.' : 'Capture your first thought. It can be anything.'}</p></div>}
          {shown.map((entry, i) => <div key={entry.id}>{(i === 0 || dayLabel(shown[i-1].createdAt) !== dayLabel(entry.createdAt)) && <div className="day-divider"><span>{dayLabel(entry.createdAt)}</span><div/></div>}<article className="thought-card">
            <div className="thought-meta"><time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time><button className={`icon-button star-button ${entry.starred ? 'is-starred' : ''}`} aria-label={entry.starred ? 'Remove from gems' : 'Save to gems'} aria-pressed={entry.starred} disabled={busy} onClick={() => void run(() => bridge.setStar({ id: entry.id, starred: !entry.starred }))}><Star size={20} fill={entry.starred ? 'currentColor' : 'none'}/></button></div>
            <button className="thought-body" onClick={() => setEditing(entry)}>{entry.text}</button>
            <div className="thought-footer"><div className="chips">{entry.tagIds.map(id => library.tags.find(t => t.id === id)).filter((t): t is Tag => !!t).map(t => <button key={t.id} className="chip" onClick={() => { setTab('tags'); setSelectedTag(t.id); setQuery(''); }}># {t.name}</button>)}</div><button className="icon-button" aria-label="Edit thought" onClick={() => setEditing(entry)}><MoreHorizontal size={18}/></button></div>
          </article></div>)}
          {hasMore && <button className="secondary load-more" onClick={() => { pageSize.current += 50; void reload(); }}>More thoughts</button>}
        </section>}
      </>}
      {!settings && <button className="compose-button" aria-label="Capture a thought" onClick={() => void run(() => bridge.compose({ tagId: selectedTag }))}><Plus size={23}/><span>A thought</span></button>}
    </main>
    <nav aria-label="Main navigation" inert={!!editing || !!tagEditor}><button aria-current={!settings && tab === 'stream' ? 'page' : undefined} onClick={() => navigate('stream')}><Feather size={21}/>Stream</button><button aria-current={!settings && tab === 'gems' ? 'page' : undefined} onClick={() => navigate('gems')}><Sparkles size={21}/>Gems</button><button aria-current={!settings && tab === 'tags' ? 'page' : undefined} onClick={() => navigate('tags')}><Hash size={21}/>Tags</button></nav>
    {(notice || deleted) && <div className="toast" role="status"><span>{notice || 'Thought deleted'}</span>{deleted && <button disabled={busy} onClick={() => void run(() => bridge.restoreEntry({ entry: deleted }), 'Thought restored.').then(ok => { if (ok) setDeleted(undefined); })}>Undo</button>}<button aria-label="Dismiss notification" onClick={() => { setNotice(''); setDeleted(undefined); }}><X size={16}/></button></div>}
    {editing && <div className="modal-backdrop"><section className="editor" role="dialog" aria-modal="true" aria-labelledby="edit-title"><div className="section-heading"><h2 id="edit-title">A thought, kept.</h2><button className="icon-button" aria-label="Close editor" onClick={() => setEditing(undefined)}><X/></button></div><div>{error && <p className="error" role="alert">{error}</p>}</div><textarea autoFocus aria-label="Thought text" value={editing.text} onChange={e => setEditing({ ...editing, text: e.target.value })}/><div className="tag-options">{library.tags.map(t => <button className={`chip ${editing.tagIds.includes(t.id) ? 'selected' : ''}`} key={t.id} aria-pressed={editing.tagIds.includes(t.id)} onClick={() => setEditing({ ...editing, tagIds: editing.tagIds.includes(t.id) ? editing.tagIds.filter(id => id !== t.id) : [...editing.tagIds, t.id] })}>{editing.tagIds.includes(t.id) && <Check size={13}/>}# {t.name}</button>)}</div><div className="editor-actions"><button className="danger secondary" disabled={busy} onClick={() => { const e = editing; void run(() => bridge.deleteEntry({ id: e.id })).then(ok => { if (ok) { setDeleted(e); setEditing(undefined); } }); }}><Trash2 size={17}/>Delete</button><button className="primary" disabled={busy || !editing.text.trim()} onClick={() => void run(() => bridge.updateEntry({ id: editing.id, text: editing.text, tagIds: editing.tagIds })).then(ok => { if (ok) setEditing(undefined); })}>Save changes</button></div></section></div>}
    {tagEditor && <TagEditor tag={tagEditor} busy={busy} error={error} close={() => setTagEditor(undefined)} save={async name => { if (await run(() => bridge.saveTag({ id: tagEditor === 'new' ? undefined : tagEditor.id, name }))) setTagEditor(undefined); }} remove={async () => { if (tagEditor !== 'new' && await run(() => bridge.deleteTag({ id: tagEditor.id }))) setTagEditor(undefined); }}/ >}
  </div>;
}
function message(e: unknown) { return e instanceof Error ? e.message : 'Something went wrong. Your saved thoughts are still on this device.'; }
function TagEditor({ tag, busy, error, close, save, remove }: { tag: Tag | 'new'; busy: boolean; error: string; close: () => void; save: (name: string) => Promise<void>; remove: () => Promise<void> }) {
  const [name, setName] = useState(tag === 'new' ? '' : tag.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return <div className="modal-backdrop"><section className="editor small" role="dialog" aria-modal="true" aria-labelledby="tag-title"><div className="section-heading"><h2 id="tag-title">{tag === 'new' ? 'Give it a tag.' : 'Edit tag'}</h2><button className="icon-button" aria-label="Close tag editor" onClick={close}><X/></button></div>{error && <p className="error" role="alert">{error}</p>}<label>Tag name<input className="text-input" autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={80}/></label>{confirmDelete && <p className="error">Remove this tag from all thoughts, drafts, and widget defaults? Your thoughts will remain. Picker widgets using it will switch to No tag.</p>}<div className="editor-actions">{tag !== 'new' && <button className="secondary danger" disabled={busy} onClick={() => confirmDelete ? void remove() : setConfirmDelete(true)}>{confirmDelete ? 'Confirm removal' : 'Delete tag'}</button>}<button className="primary" disabled={busy || !name.trim()} onClick={() => void save(name.trim())}>Save tag</button></div></section></div>;
}
