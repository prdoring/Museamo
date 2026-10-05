import { useEffect, useRef, useState } from "react";
import { bridge, type Entry, type Tag } from "../data";
import type { RecoveryItem } from "../sync";
import { MediaGallery } from "./Media";
import { FormattedText } from "./FormattedText";
import { capabilities } from "../platform";

export function Recovery({ report }: { report: (message: string) => void }) {
  const [items, setItems] = useState<RecoveryItem[]>();
  const [error, setError] = useState("");
  const [clearing, setClearing] = useState<RecoveryItem | "all">();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false), pending = useRef(false);
  async function refresh() { try { const result = await bridge.listRecovery(); if (mounted.current) setItems(result.items); } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); } }
  useEffect(() => {
    mounted.current = true; void refresh();
    const listener = bridge.addListener("dataChanged", () => void refresh());
    void listener.catch(e => { if (mounted.current) setError(String(e)); });
    return () => { mounted.current = false; void listener.then(handle => handle.remove()).catch(() => {}); };
  }, []);
  async function run(action: () => Promise<unknown>, message: string) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action(); if (mounted.current) { setClearing(undefined); report(message); } await refresh(); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <section aria-labelledby="recovery-title">
    <h2 id="recovery-title">Recovery</h2>
    <p>Deleted thoughts and earlier versions stay here until you clear them. Restoring saves a separate thought.{capabilities.sync && " Recovery and permanent clearing sync across your linked devices."}</p>
    {error && <p className="error" role="alert">{error} <button onClick={() => void refresh()}>Retry</button></p>}
    {!items && !error && <p role="status">Loading Recovery…</p>}
    {items?.length === 0 && <p className="muted">Nothing in Recovery.</p>}
    {clearing && <div className="sync-confirm" role="group" aria-label="Confirm permanent clearing">
      <p>{clearing === "all" ? "Permanently clear all versions in Recovery?" : "Permanently clear this version?"}{capabilities.sync && " Clearing spreads to your linked devices when they reconnect."} This cannot be undone.</p>
      <div className="action-row"><button className="secondary" disabled={busy} onClick={() => setClearing(undefined)}>Keep in Recovery</button><button className="secondary danger" disabled={busy} onClick={() => void run(() => clearing === "all" ? bridge.clearAllRecovery() : bridge.clearRecovery({ id: clearing.id }), "Recovery cleared.")}>Clear permanently</button></div>
    </div>}
    {items?.map(item => {
      const entry = item.payload as Entry, tag = item.payload as Tag;
      const thought = item.kind === "entry" || item.kind === "thought";
      return <article className="recovery-item" key={item.id}>
        <small>{new Date(item.createdAt).toLocaleString()}</small>
        {thought ? <><div className="rich-text"><FormattedText text={entry.text || ""} tags={[]} openTag={() => {}} report={report} /></div><MediaGallery attachments={entry.attachments} /></> : <p>Tag: {tag.name}</p>}
        <div className="action-row"><button className="secondary" disabled={busy} onClick={() => void run(() => bridge.restoreRecovery({ id: item.id }), thought ? "Restored as a new thought." : "Tag restored.")}>Restore copy</button><button className="text-button danger" disabled={busy} onClick={() => setClearing(item)}>Clear permanently</button></div>
      </article>;
    })}
    {!!items?.length && <button className="text-button danger" disabled={busy} onClick={() => setClearing("all")}>Clear all Recovery</button>}
  </section>;
}
