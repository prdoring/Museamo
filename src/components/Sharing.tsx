import { useEffect, useRef, useState } from "react";
import { ListChecks, Users, QrCode, ScanLine } from "lucide-react";
import { bridge, type Tag } from "../data";
import { platform, capabilities } from "../platform";
import type { TagInvitation, TagShareState } from "../sharing";
import { Sheet } from "./Thoughts";
import { SettingRow, SettingsBack, SettingsFailure, settingsError, useSettingsResource } from "./SettingsControls";

export function ChecklistMark() { return <span className="shared-mark"><ListChecks size={14} aria-hidden="true" /><span className="sr-only">Checklist</span></span>; }
export function SharedMark({ className = "" }: { className?: string }) { return <span className={`shared-mark ${className}`} title="Shared hashtag"><Users size={15} aria-hidden="true" /><span className="sr-only">Shared</span></span>; }

type TagSharingSettingsProps = {
  tag: Tag; changed: () => Promise<void>; close: () => void; stateChanged?: (state: TagShareState) => void;
  expanded?: boolean; requestOpen?: () => void; busyChanged?: (busy: boolean) => void; backRequested?: number;
};
export function TagSharingSettings(props: TagSharingSettingsProps) { return capabilities.sharing ? <AvailableTagSharingSettings {...props} /> : null; }

function SharingConsent() {
  return <div className="sharing-consent"><p>Existing and future thoughts with this tag are shared with everyone who joins.</p><ul><li>Text, photos/videos, checklist state, and saved locations are shared.</li><li>Everyone can add, edit, delete, and check off items.</li><li>Your other tags and Gems stay private.</li></ul></div>;
}

function AvailableTagSharingSettings({ tag, changed, close, stateChanged, expanded: controlledOpen, requestOpen, busyChanged, backRequested = 0 }: TagSharingSettingsProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const resource = useSettingsResource(() => bridge.getTagShareState({ tagId: tag.id }), { enabled: open || !!tag.sharing, poll: open, resourceKey: tag.id, initial: tag.sharing ?? { collectionId: null } });
  const state = resource.value;
  const [invite, setInvite] = useState<TagInvitation>();
  const [view, setView] = useState<"overview" | "invite">("overview");
  const [confirm, setConfirm] = useState<{ kind: "start" | "stop" | "leave" | "member"; memberId?: string; name?: string }>();
  const [time, setTime] = useState(Date.now()), [refreshError, setRefreshError] = useState("");
  const activeInvite = useRef<TagInvitation | undefined>(undefined), mounted = useRef(false);
  const notifyState = useRef(stateChanged); notifyState.current = stateChanged;
  const notifyBusy = useRef(busyChanged); notifyBusy.current = busyChanged;
  const mobile = platform !== "desktop";
  const previousBack = useRef(backRequested);
  useEffect(() => { if (previousBack.current !== backRequested) { previousBack.current = backRequested; void back(); } }, [backRequested]);
  useEffect(() => { if (state) notifyState.current?.(state); }, [state]);
  useEffect(() => { notifyBusy.current?.(resource.busy); }, [resource.busy]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; const current = activeInvite.current; if (current) void bridge.cancelTagInvite({ inviteId: current.inviteId }).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (!invite || !open) return;
    const timer = window.setInterval(() => setTime(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [invite, open]);
  async function notifyChanged() {
    setRefreshError("");
    try { await changed(); } catch (error) { if (mounted.current) setRefreshError(`Sharing changed, but the library could not refresh. ${settingsError(error)}`); }
  }
  async function createInvitation() {
    setView("invite");
    await resource.run(async () => {
      if (activeInvite.current) { await bridge.cancelTagInvite({ inviteId: activeInvite.current.inviteId }); activeInvite.current = undefined; setInvite(undefined); }
      const next = await bridge.createTagInvite({ tagId: tag.id });
      if (!mounted.current) { await bridge.cancelTagInvite({ inviteId: next.inviteId }); return; }
      activeInvite.current = next; setInvite(next); setTime(Date.now());
    });
  }
  async function back() {
    if (resource.busy) return;
    if (activeInvite.current) {
      if (!(await resource.run(() => bridge.cancelTagInvite({ inviteId: activeInvite.current!.inviteId })))) return;
      activeInvite.current = undefined; setInvite(undefined);
    }
    setConfirm(undefined); setView("overview");
    if (controlledOpen === undefined) setLocalOpen(false); else close();
  }
  async function confirmAction() {
    if (!confirm) return;
    if (confirm.kind === "start") {
      if (await resource.run(() => bridge.startTagSharing({ tagId: tag.id }))) {
        setConfirm(undefined); await notifyChanged(); await createInvitation();
      }
      return;
    }
    const ok = await resource.run(() => confirm.kind === "stop" ? bridge.stopTagSharing({ tagId: tag.id }) : confirm.kind === "leave" ? bridge.leaveTagShare({ tagId: tag.id }) : bridge.removeTagShareMember({ tagId: tag.id, memberId: confirm.memberId! }));
    if (ok) { setConfirm(undefined); await notifyChanged(); if (confirm.kind !== "member") { setView("overview"); close(); } }
  }
  if (!open) return <section className="tag-sharing-summary" aria-label="Hashtag sharing"><SettingRow title={state?.collectionId ? "Shared hashtag" : "Sharing"} detail={state?.collectionId ? `${state.role === "owner" ? "Creator" : "Member"} · Manage sharing` : mobile ? "Private · Share hashtag with other people" : "Private · Sharing is managed on your phone"} onClick={() => { if (requestOpen) requestOpen(); else setLocalOpen(true); }} /></section>;
  return <section className="tag-sharing-page" aria-label="Hashtag sharing">
    <SettingsBack onClick={() => { if (resource.busy) return; if (confirm) setConfirm(undefined); else if (view === "invite") { void resource.run(async () => { if (activeInvite.current) await bridge.cancelTagInvite({ inviteId: activeInvite.current.inviteId }); activeInvite.current = undefined; setInvite(undefined); }).then(ok => { if (ok) setView("overview"); }); } else void back(); }}>{confirm ? "Sharing" : view === "invite" ? "Members" : "Tag settings"}</SettingsBack>
    <h3>#{tag.name}</h3>
    <SettingsFailure error={resource.actionError || resource.readError || refreshError} retry={resource.readError ? () => void resource.refresh() : undefined} />
    {confirm ? <>
      <h3>{confirm.kind === "start" ? "Share this tag?" : confirm.kind === "stop" ? "Stop sharing for everyone?" : confirm.kind === "leave" ? "Leave this shared tag?" : `Remove ${confirm.name || "this member"}?`}</h3>
      {confirm.kind === "start" ? <SharingConsent /> : <p>{confirm.kind === "stop" ? "Each person keeps a private copy of downloaded items. Future changes stop syncing." : confirm.kind === "leave" ? "Your linked devices keep a private copy of downloaded items." : "This member and their linked devices keep downloaded items as a private copy. Removal reaches offline devices when they reconnect."}</p>}
      <div className="settings-actions"><button className="secondary" disabled={resource.busy} onClick={() => setConfirm(undefined)}>Cancel</button><button className={confirm.kind === "start" ? "primary" : "primary danger"} disabled={resource.busy || !!resource.readError} onClick={() => void confirmAction()}>{resource.busy ? "Working…" : confirm.kind === "start" ? "Share and show QR" : confirm.kind === "stop" ? "Stop sharing" : confirm.kind === "leave" ? "Leave shared tag" : "Remove member"}</button></div>
    </> : view === "invite" ? <>
      <h3>Invite someone</h3>
      {invite && time < invite.expiresAt ? <div className="share-invitation"><img src={invite.imageDataUrl} alt={`QR invitation to ${tag.name}`} /><p>Scan in Museamo on another phone on the same local network.</p><p className="muted" role="status">One use · Expires in {Math.ceil((invite.expiresAt - time) / 60000)} minute(s). Anyone with this code can join.</p></div> : <p role="status">{resource.busy ? "Creating invitation…" : invite ? "This invitation expired. Create a new one." : "An invitation is not available yet."}</p>}
      <div className="settings-actions"><button className="secondary" disabled={resource.busy} onClick={() => void resource.run(async () => { if (activeInvite.current) await bridge.cancelTagInvite({ inviteId: activeInvite.current.inviteId }); activeInvite.current = undefined; setInvite(undefined); }).then(ok => { if (ok) setView("overview"); })}>Cancel invitation</button><button className="primary" disabled={resource.busy} onClick={() => void createInvitation()}><QrCode size={18} />{invite ? "New QR invitation" : "Retry invitation"}</button></div>
    </> : state?.collectionId ? <>
      <div className="sharing-heading"><SharedMark /><strong>Shared hashtag · {state.role === "owner" ? "Creator" : "Member"}</strong></div>
      <p className="muted" role="status">{state.status === "syncing" ? "Syncing on your local network…" : state.status === "attachment-pending" ? `${state.attachmentsPending ?? "Some"} attachment(s) waiting to download.` : "Waiting for members on your local network."}</p>
      {state.lastSync && <p className="muted">Last synced {new Date(state.lastSync).toLocaleString()}</p>}
      <SettingsFailure error={state.lastError ?? undefined} />
      <div className="sharing-primary-actions">{mobile && state.role === "owner" && <button className="primary" disabled={resource.busy || !!resource.readError} onClick={() => void createInvitation()}><QrCode size={18} />Invite someone</button>}<button className="secondary" disabled={resource.busy} onClick={() => void resource.run(() => bridge.syncTagShare({ tagId: tag.id }))}>Sync now</button></div>
      <h3>Members</h3><div className="settings-list">{state.members?.map(member => <SettingRow key={member.id} title={`${member.name}${member.you ? " (you)" : ""}`} detail={member.owner ? "Creator" : "Member"} children={mobile && state.role === "owner" && !member.owner ? <button className="text-button" disabled={resource.busy} onClick={() => setConfirm({ kind: "member", memberId: member.id, name: member.name })}>Remove</button> : <span />} />)}</div>
      <details className="settings-help"><summary>What members can see and change</summary><SharingConsent /></details>
      {mobile ? <details className="settings-help"><summary>Sharing actions</summary><button className="text-button danger" disabled={resource.busy || !!resource.readError} onClick={() => setConfirm({ kind: state.role === "owner" ? "stop" : "leave" })}>{state.role === "owner" ? "Stop sharing" : "Leave shared tag"}</button></details> : <p className="muted">Manage sharing on your linked phone.</p>}
    </> : <><p>This tag is private. Share only this tag with other people.</p>{mobile ? <button className="primary" disabled={resource.busy || !!resource.readError} onClick={() => setConfirm({ kind: "start" })}><Users size={18} />Share this tag</button> : <p className="muted">Start sharing from Museamo on your linked phone.</p>}</>}
  </section>;
}

export function JoinSharedTag({ joined }: { joined: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [invite, setInvite] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof bridge.previewTagInvite>>>();
  const [success, setSuccess] = useState(false), [time, setTime] = useState(Date.now());
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!open || !preview) return; const timer = window.setInterval(() => setTime(Date.now()), 1000); return () => clearInterval(timer); }, [open, preview]);
  async function scan() {
    if (pending.current) return; pending.current = true; setBusy(true); setError(""); setPreview(undefined); setSuccess(false);
    try {
      const result = await bridge.scanTagInvite();
      if (result.cancelled || !result.invite || !mounted.current) return;
      setInvite(result.invite); setOpen(true);
      const next = await bridge.previewTagInvite({ invite: result.invite });
      if (mounted.current) { setPreview(next); setTime(Date.now()); }
    } catch (failure) { if (mounted.current) { setOpen(true); setError(settingsError(failure)); } }
    finally { if (mounted.current) setBusy(false); pending.current = false; }
  }
  async function join() {
    if (pending.current || !preview || time >= preview.expiresAt) return; pending.current = true; setBusy(true); setError("");
    try { await bridge.joinTagShare({ invite }); if (mounted.current) setSuccess(true); try { await joined(); } catch (failure) { if (mounted.current) setError(`Joined successfully, but the tag list could not refresh. ${settingsError(failure)}`); } }
    catch (failure) { if (mounted.current) setError(settingsError(failure)); }
    finally { if (mounted.current) setBusy(false); pending.current = false; }
  }
  if (!capabilities.sharing || platform === "desktop") return null;
  return <><button className="menu-row" disabled={busy} onClick={() => void scan()}><ScanLine size={20} aria-hidden="true" />Join shared hashtag</button>{open && <Sheet title={success ? "Shared tag joined" : "Join shared hashtag"} close={() => { if (!busy) { setOpen(false); setPreview(undefined); setInvite(""); } }}>
    {success ? <><h3>#{preview?.name}</h3><p>The shared tag is now in your library and will appear on your linked devices.</p><div className="settings-actions"><button className="primary" onClick={() => setOpen(false)}>Done</button></div></> : preview ? <><h3>#{preview.name}</h3><p>{preview.count} existing item(s){preview.type === "checklist" ? " · Checklist" : ""}</p><SharingConsent /><p className="muted">Both phones must be reachable on the same local network to join.</p>{time >= preview.expiresAt ? <p role="status">This invitation expired. Ask for a new invitation.</p> : <div className="settings-actions"><button className="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button><button className="primary" disabled={busy} onClick={() => void join()}>{busy ? "Joining…" : "Join shared hashtag"}</button></div>}</> : busy ? <p role="status">Checking invitation…</p> : null}
    <SettingsFailure error={error} />
    {!success && (!preview || time >= preview.expiresAt) && <button className="secondary" disabled={busy} onClick={() => void scan()}>Scan another QR code</button>}
  </Sheet>}</>;
}
