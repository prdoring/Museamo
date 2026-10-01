import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { FormattedText } from "./FormattedText";
import { ChecklistToggle } from "./Checklist";
import { reducedMotion } from "./Motion";
import "leaflet/dist/leaflet.css";
import { bridge, isChecklistEntry, locationLabel, type Entry, type Tag } from "../data";

export function groupLocations(entries: Entry[], project: (lat: number, lng: number) => { x: number; y: number }) {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!entry.location) continue;
    const point = project(entry.location.latitude, entry.location.longitude);
    const key = `${Math.floor(point.x / 44)},${Math.floor(point.y / 44)}`;
    groups.set(key, [...(groups.get(key) || []), entry]);
  }
  return [...groups.values()];
}

export function LocationMap({ query = "", tags = [], focus, edit, complete, pendingCompletions }: {
  query?: string; tags?: Tag[]; focus?: Entry; edit: (entry: Entry) => void;
  complete: (entry: Entry) => Promise<void>; pendingCompletions: ReadonlySet<string>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const fittedLocations = useRef("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const changingCompletion = useRef(new Set<string>());
  const [retryCompletion, setRetryCompletion] = useState<Entry>();
  const [starred, setStarred] = useState(false), [tagId, setTagId] = useState("");
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [tileError, setTileError] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    if (focus) { setEntries([focus]); setSelected([focus.id]); return; }
    let disposed = false;
    setLoading(true); setError("");
    void (async () => {
      try {
        const all: Entry[] = [];
        let last: Entry | undefined;
        do {
          const page = await bridge.queryEntries({ located: true, search: query, starred, tagId: tagId || undefined, limit: 200, beforeTime: last?.createdAt, beforeId: last?.id });
          if (disposed) return;
          all.push(...page.entries);
          if (!page.hasMore || !page.entries.length) break;
          last = page.entries.at(-1);
        } while (!disposed);
        if (!disposed) setEntries(all);
      } catch (e) { if (!disposed) setError(String(e)); }
      finally { if (!disposed) setLoading(false); }
    })();
    return () => { disposed = true; };
  }, [focus, query, starred, tagId, revision]);
  useEffect(() => { setSelected([]); }, [query, starred, tagId]);
  useEffect(() => {
    let disposed = false;
    const listener = bridge.addListener("dataChanged", () => { if (!disposed && !changingCompletion.current.size) setRevision(v => v + 1); });
    return () => { disposed = true; void listener.then(h => h.remove()); };
  }, []);
  useEffect(() => {
    if (!container.current) return;
    const animate = !reducedMotion();
    const instance = L.map(container.current, { zoomAnimation: animate, fadeAnimation: animate, markerZoomAnimation: animate }).setView([20, 0], 2);
    map.current = instance;
    fittedLocations.current = "";
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).on("tileerror", () => setTileError(true)).addTo(instance);
    const resize = new ResizeObserver(() => instance.invalidateSize());
    resize.observe(container.current);
    return () => { resize.disconnect(); instance.remove(); map.current = null; };
  }, []);
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const layer = L.layerGroup().addTo(instance);
    const render = () => {
      layer.clearLayers();
      for (const group of groupLocations(entries, (lat, lng) => instance.project([lat, lng]))) {
        const location = group[0].location!;
        L.marker([location.latitude, location.longitude], {
          title: group.length > 1 ? `${group.length} posts` : locationLabel(location),
          icon: L.divIcon({ className: "location-pin", html: `<span>${group.length > 1 ? group.length : "●"}</span>`, iconSize: [36, 36] }),
        }).on("click", () => setSelected(group.map(e => e.id))).addTo(layer);
      }
    };
    const locations = entries.map(e => `${e.id}:${e.location!.latitude}:${e.location!.longitude}`).join("|");
    if (entries.length && locations !== fittedLocations.current) {
      fittedLocations.current = locations;
      instance.fitBounds(L.latLngBounds(entries.map(e => [e.location!.latitude, e.location!.longitude])), { maxZoom: focus ? 16 : 14, padding: [30, 30], animate: !reducedMotion() });
    }
    render(); instance.on("zoomend", render);
    return () => { instance.off("zoomend", render); layer.remove(); };
  }, [entries, focus]);
  async function toggle(entry: Entry) {
    if (loading || pendingCompletions.has(entry.id) || changingCompletion.current.has(entry.id)) return;
    changingCompletion.current.add(entry.id);
    setError(""); setRetryCompletion(undefined);
    setEntries(old => old.map(e => e.id === entry.id ? { ...e, completed: !entry.completed } : e));
    try { await complete(entry); }
    catch (e) {
      setEntries(old => old.map(item => item.id === entry.id ? { ...item, completed: entry.completed } : item));
      setError(e instanceof Error ? e.message : String(e)); setRetryCompletion(entry);
    } finally { changingCompletion.current.delete(entry.id); }
  }
  const selectedEntries = entries.filter(e => selected.includes(e.id));
  return <section className="location-view" aria-label="Post map">
    {!focus && <div className="map-filters">
      <label><input type="checkbox" checked={starred} onChange={e => setStarred(e.target.checked)} /> Gems only</label>
      <label>Tag <select value={tagId} onChange={e => setTagId(e.target.value)}><option value="">All tags</option>{tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    </div>}
    <div ref={container} className="location-map" aria-label="Map of saved locations" />
    {tileError && <p role="status">Map tiles are unavailable. Your saved locations are listed below.</p>}
    {error && <p role="alert">{error} <button onClick={() => retryCompletion ? void toggle(retryCompletion) : setRevision(v => v + 1)}>Retry</button></p>}
    {loading && <p role="status">Loading located posts…</p>}
    {!loading && !entries.length && <p>No located posts match. Enable automatic location in Settings to capture locations on new posts.</p>}
    {selected.length > 0 && !focus && <button onClick={() => setSelected([])}>Show all {entries.length} located posts</button>}
    <div className="map-posts">{(selectedEntries.length ? selectedEntries : entries).map(entry => <article key={entry.id} data-entry-id={entry.id}>
      {isChecklistEntry(entry, tags) && <ChecklistToggle entry={entry} pending={loading || pendingCompletions.has(entry.id)} change={e => void toggle(e)} />}
      <strong>{locationLabel(entry.location!)}</strong>
      <div className={"rich-text " + (isChecklistEntry(entry, tags) && entry.completed ? "checklist-completed" : "")}><FormattedText text={entry.text || "Photo/video post"} tags={[]} openTag={() => {}} report={setError} /></div>
      <small>{entry.location!.latitude.toFixed(5)}, {entry.location!.longitude.toFixed(5)}{entry.location!.accuracy !== undefined ? ` · accuracy ~${Math.round(entry.location!.accuracy!)} m` : ""}</small>
      <div className="action-row"><button onClick={() => edit(entry)}>Edit post</button><button onClick={() => void bridge.openLocation({ latitude: entry.location!.latitude, longitude: entry.location!.longitude }).catch(e => setError(String(e)))}>Open in maps</button></div>
    </article>)}</div>
  </section>;
}
