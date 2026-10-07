import { useEffect, useState } from "react";
import { bridge, type Entry, type Tag } from "../data";
import type { RecoveryItem } from "../sync";
import { MediaGallery } from "./Media";
import { FormattedText } from "./FormattedText";
import { capabilities } from "../platform";
import { Sheet } from "./Thoughts";
import { SettingRow, SettingsFailure, useSettingsResource } from "./SettingsControls";

export function Recovery({ report }: { report: (message: string) => void }) {
  const resource = useSettingsResource(() => bridge.listRecovery());
  const [selected, setSelected] = useState<RecoveryItem>();
  const [clearing, setClearing] = useState<RecoveryItem | "all">();
  const [limit, setLimit] = useState(50);
  const items = resource.value?.items;
  useEffect(() => {
    const listener = bridge.addListener("dataChanged", () => void resource.refresh());
    return () => { void listener.then(handle => handle.remove()).catch(() => {}); };
  }, [resource.refresh]);
  async function clear() {
    if (!clearing) return;
    if (await resource.run(() => clearing === "all" ? bridge.clearAllRecovery() : bridge.clearRecovery({ id: clearing.id }))) {
      setClearing(undefined); setSelected(undefined); report("Recovery cleared.");
    }
  }
  return <section className="settings-page" aria-label="Recovery">
    <p>Deleted thoughts and saved versions stay here until cleared.</p>
    <SettingsFailure error={resource.readError || resource.actionError} retry={() => void resource.refresh()} />
    {!items && !resource.readError && <p role="status">Loading Recovery…</p>}
    {items?.length === 0 && <div className="settings-empty"><h3>Nothing in Recovery.</h3><p>Deleted thoughts and earlier versions will appear here.</p></div>}
    <div className="settings-list">{items?.slice(0, limit).map(item => {
      const thought = item.kind === "entry" || item.kind === "thought";
      const payload = item.payload as Entry;
      const excerpt = thought ? payload.text?.replace(/\s+/g, " ").slice(0, 120) || (payload.attachments?.length ? "Thought with attachments" : "Saved thought") : `Tag: ${(item.payload as Tag).name}`;
      return <SettingRow key={item.id} title={excerpt} detail={new Date(item.createdAt).toLocaleString()} onClick={() => setSelected(item)} />;
    })}</div>
    {!!items && items.length > limit && <button className="secondary" onClick={() => setLimit(count => count + 50)}>Show more</button>}
    <details className="settings-help"><summary>Restoring and clearing</summary><p>Restoring saves a separate thought. The saved version remains in Recovery until you clear it.</p>{capabilities.sync && <p>Recovery and permanent clearing sync across your linked devices.</p>}</details>
    {!!items?.length && <button className="text-button danger" disabled={resource.busy} onClick={() => setClearing("all")}>Clear all Recovery</button>}
    {selected && !clearing && <Sheet title="Saved version" close={() => { if (!resource.busy) setSelected(undefined); }}>
      <p className="muted">{new Date(selected.createdAt).toLocaleString()}</p>
      {selected.kind === "entry" || selected.kind === "thought" ? <><div className="rich-text"><FormattedText text={(selected.payload as Entry).text || ""} tags={[]} openTag={() => {}} report={report} /></div><MediaGallery attachments={(selected.payload as Entry).attachments} /></> : <p>Tag: {(selected.payload as Tag).name}</p>}
      <p className="muted">Restore creates a separate copy.</p>
      <SettingsFailure error={resource.actionError || resource.readError} />
      <div className="settings-actions"><button className="text-button danger" disabled={resource.busy} onClick={() => setClearing(selected)}>Clear permanently</button><button className="primary" disabled={resource.busy} onClick={() => void resource.run(() => bridge.restoreRecovery({ id: selected.id })).then(ok => { if (ok) { report(selected.kind === "entry" || selected.kind === "thought" ? "Restored as a new thought." : "Tag restored."); setSelected(undefined); } })}>{resource.busy ? "Restoring…" : "Restore copy"}</button></div>
    </Sheet>}
    {clearing && <Sheet title="Clear permanently?" close={() => { if (!resource.busy) setClearing(undefined); }}>
      <p>{clearing === "all" ? "Permanently clear all versions in Recovery?" : "Permanently clear this saved version?"}</p>
      {capabilities.sync && <p>Clearing reaches your linked devices when they reconnect.</p>}<p>This cannot be undone.</p>
      <SettingsFailure error={resource.actionError || resource.readError} />
      <div className="settings-actions"><button className="secondary" disabled={resource.busy} onClick={() => setClearing(undefined)}>Keep in Recovery</button><button className="primary danger" disabled={resource.busy} onClick={() => void clear()}>{resource.busy ? "Clearing…" : "Clear permanently"}</button></div>
    </Sheet>}
  </section>;
}
