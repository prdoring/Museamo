import { useEffect, useRef, useState } from "react";
import { ListChecks, Users, QrCode, ScanLine } from "lucide-react";
import { bridge, type Tag } from "../data";
import { platform } from "../platform";
import type { TagInvitation, TagShareState } from "../sharing";
import { Sheet } from "./Thoughts";

export function ChecklistMark() { return <span className="shared-mark"><ListChecks size={14} aria-hidden="true" /><span className="sr-only">Checklist</span></span>; }

export function SharedMark({ className = "" }: { className?: string }) {
  return <span className={`shared-mark ${className}`} title="Shared hashtag"><Users size={15} aria-hidden="true" /><span className="sr-only">Shared</span></span>;
}
export function TagSharingSettings({ tag, changed, close, stateChanged, disabled = false }: { tag: Tag; changed: () => Promise<void>; close: () => void; stateChanged?: (state: TagShareState) => void; disabled?: boolean }) {
  const [state, setState] = useState<TagShareState>(tag.sharing ?? { collectionId: null });
  const [invite, setInvite] = useState<TagInvitation>();
  const [confirm, setConfirm] = useState<"start" | "stop" | "leave" | string>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [time, setTime] = useState(Date.now());
  const pending = useRef(false), mounted = useRef(true), activeInvite = useRef<TagInvitation | undefined>(undefined);
  async function refresh() { const next = await bridge.getTagShareState({ tagId: tag.id }); if (mounted.current) { setState(next); stateChanged?.(next); } }
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(e => setError(String(e)));
    const timer = window.setInterval(() => { setTime(Date.now()); if (!document.hidden) void refresh().catch(e => { if (mounted.current) setError(String(e)); }); }, 2000);
    return () => { mounted.current = false; clearInterval(timer); if (activeInvite.current) void bridge.cancelTagInvite({ inviteId: activeInvite.current.inviteId }).catch(() => {}); };
  }, [tag.id]);
  async function run(action: () => Promise<unknown>, finish = false) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action(); await changed(); await refresh(); if (finish) close(); }
    catch (e) { await changed().catch(() => {}); await refresh().catch(() => {}); if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); setConfirm(undefined); } }
  }
  async function invitation() {
    if (activeInvite.current) await bridge.cancelTagInvite({ inviteId: activeInvite.current.inviteId });
    const next = await bridge.createTagInvite({ tagId: tag.id }); activeInvite.current = next; setInvite(next);
  }
  const mobile = platform !== "desktop";
  return <section className="sharing-settings" aria-label="Hashtag sharing">
    {state.collectionId ? <>
      <div className="sharing-heading"><SharedMark /><strong>Shared hashtag</strong></div>
      <p className="muted" role="status">{state.status === "syncing" ? "Syncing on your local network…" : state.status === "attachment-pending" ? `${state.attachmentsPending ?? "Some"} attachment(s) waiting to download.` : "Waiting for members on your local network."}{state.lastSync ? ` Last synced ${new Date(state.lastSync).toLocaleString()}.` : ""}</p>
      {state.lastError && <p className="error" role="alert">{state.lastError}</p>}
      <button className="secondary" disabled={busy} onClick={() => void run(() => bridge.syncTagShare({ tagId: tag.id }))}>Sync now</button>
      {state.members?.map(member => <div className="device-row" key={member.id}><span>{member.name}{member.you ? " (you)" : ""}{member.owner ? " · Creator" : ""}</span>{mobile && state.role === "owner" && !member.owner && <button disabled={busy} className="text-button danger" onClick={() => setConfirm(member.id)}>Remove</button>}</div>)}
      {mobile && state.role === "owner" && <button className="secondary" disabled={busy} onClick={() => void run(invitation)}><QrCode size={18} aria-hidden="true" />{invite ? "New QR invitation" : "Invite someone"}</button>}
      {invite && <div className="share-invitation">
        {time < invite.expiresAt ? <><img src={invite.imageDataUrl} alt="QR invitation to this shared hashtag" /><p>Scan in Museamo on another phone on the same local network.</p><p className="muted">One use · Expires in {Math.ceil((invite.expiresAt - time) / 60000)} minute(s). Anyone with this QR code can join.</p></> : <p role="status">This QR invitation expired. Create a new one.</p>}
        <button className="text-button" disabled={busy} onClick={() => void run(async () => { await bridge.cancelTagInvite({ inviteId: invite.inviteId }); activeInvite.current = undefined; setInvite(undefined); })}>Cancel invitation</button>
      </div>}
      {mobile ? <button className="text-button danger" disabled={busy} onClick={() => setConfirm(state.role === "owner" ? "stop" : "leave")}>{state.role === "owner" ? "Stop sharing" : "Leave shared hashtag"}</button> : <p className="muted">Manage sharing on your linked phone.</p>}
    </> : mobile ? <><button className="sharing-setting" disabled={busy || disabled} onClick={() => setConfirm("start")}><Users size={20} aria-hidden="true" /><span><strong>Share hashtag</strong><small>Keep this list in sync with other people.</small></span></button>{disabled && <p className="muted">Save your hashtag changes before sharing.</p>}</> : null}
    {confirm && <div className="sync-confirm">
      <p>{confirm === "start" ? "Share existing and future thoughts with this hashtag? Text, photos/videos, checklist state, and saved locations will be shared. Other hashtag assignments and Gems stay private. Everyone who joins can edit or delete items." : confirm === "stop" ? "Stop sharing for everyone? Each person keeps a private copy of downloaded items. Future changes will stop syncing." : confirm === "leave" ? "Leave this shared hashtag? Your linked devices keep a private copy of downloaded items." : "Remove this member and their linked devices? They keep downloaded items as a private copy. Removal reaches offline devices when they reconnect."}</p>
      <div className="action-row"><button disabled={busy} className="secondary" onClick={() => setConfirm(undefined)}>Cancel</button><button disabled={busy} className={confirm === "start" ? "primary" : "secondary danger"} onClick={() => void run(async () => {
        if (confirm === "start") { await bridge.startTagSharing({ tagId: tag.id }); await invitation(); }
        else if (confirm === "stop") await bridge.stopTagSharing({ tagId: tag.id });
        else if (confirm === "leave") await bridge.leaveTagShare({ tagId: tag.id });
        else await bridge.removeTagShareMember({ tagId: tag.id, memberId: confirm });
      }, confirm === "stop" || confirm === "leave")}>{confirm === "start" ? "Share and show QR" : confirm === "stop" ? "Stop sharing" : confirm === "leave" ? "Leave" : "Remove member"}</button></div>
    </div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

export function JoinSharedTag({ joined }: { joined: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [invite, setInvite] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof bridge.previewTagInvite>>>();
  const pending = useRef(false);
  async function scan() {
    if (pending.current) return; pending.current = true; setBusy(true); setError("");
    try { const result = await bridge.scanTagInvite(); if (result.cancelled || !result.invite) return; setInvite(result.invite); setOpen(true); setPreview(await bridge.previewTagInvite({ invite: result.invite })); }
    catch (e) { setOpen(true); setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); pending.current = false; }
  }
  async function join() {
    if (pending.current || !preview) return; pending.current = true; setBusy(true); setError("");
    try { await bridge.joinTagShare({ invite }); await joined(); setOpen(false); setPreview(undefined); setInvite(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); pending.current = false; }
  }
  if (platform === "desktop") return null;
  return <><button className="menu-row" disabled={busy} onClick={() => void scan()}><ScanLine size={20} aria-hidden="true" />Join shared hashtag</button>{open && <Sheet title="Join shared hashtag" close={() => { if (!busy) { setOpen(false); setPreview(undefined); } }}>
    {preview && <><h3>#{preview.name}</h3><p>{preview.count} existing item(s){preview.type === "checklist" ? " · Checklist" : ""}</p><p>You and everyone who joins can add, edit, delete, and check off items. Text, attachments, and saved locations are shared. Your other tags and Gems stay private.</p><p className="muted">This list will also appear on your linked devices. Both phones must be reachable on the same local network to join.</p><button className="primary" disabled={busy} onClick={() => void join()}>{busy ? "Joining…" : "Join shared hashtag"}</button></>}
    {error && <p className="error" role="alert">{error}</p>}
    {!preview && <button className="secondary" disabled={busy} onClick={() => void scan()}>Scan another QR code</button>}
  </Sheet>}</>;
}
