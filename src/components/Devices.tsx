import { useEffect, useRef, useState } from "react";
import { bridge, isNative } from "../data";
import { formatBytes, type SyncDevice, type SyncState } from "../sync";
import { capabilities, platform } from "../platform";
import type { DeviceBridge } from "../devicePreview";
import { Sheet } from "./Thoughts";
import { SettingRow, SettingsBack, SettingsFailure, settingsError, useSettingsResource, type SettingsResource } from "./SettingsControls";

type DeviceProps = { active?: boolean; controller?: SettingsResource<SyncState>; api?: DeviceBridge; demo?: boolean };
export function Devices(props: DeviceProps = {}) {
  if (props.controller) return <DeviceView {...props} controller={props.controller} />;
  return capabilities.sync ? <LiveDevices {...props} /> : null;
}
function LiveDevices(props: DeviceProps) {
  const api = props.api ?? bridge;
  const controller = useSettingsResource(() => api.getSyncState(), { poll: true });
  return <DeviceView {...props} api={api} controller={controller} />;
}
function deviceStatus(device: SyncDevice) { return device.status === "syncing" ? "Syncing" : device.status === "available" ? "Nearby" : "Linked"; }

function DeviceView({ active = true, controller, api = bridge, demo = false }: DeviceProps & { controller: SettingsResource<SyncState> }) {
  const { value: state, busy, run, refresh, readError, actionError } = controller;
  const [flow, setFlow] = useState(false);
  const [stage, setStage] = useState<"find" | "connecting" | "pairing" | "cancelling" | "success" | "ended">("find");
  const [manual, setManual] = useState(false), [address, setAddress] = useState("");
  const [selected, setSelected] = useState<SyncDevice>();
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const [copyError, setCopyError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const connection = useRef<{ started: number; error?: string | null } | undefined>(undefined);
  const session = useRef<string | undefined>(undefined), target = useRef<SyncDevice | undefined>(undefined), cancelling = useRef(false);
  const pairing = state?.pairing;
  useEffect(() => {
    if (pairing) {
      setSelected(undefined);
      session.current = pairing.sessionId; target.current = pairing.peer;
      setFlow(true); if (!cancelling.current) setStage("pairing");
    } else if (session.current) {
      session.current = undefined;
      if (state?.devices.some(device => device.deviceId === target.current?.deviceId)) setStage("success");
      else if (cancelling.current) { setFlow(false); setStage("find"); }
      else setStage("ended");
      cancelling.current = false;
    }
  }, [pairing, state?.devices]);
  useEffect(() => {
    if (stage !== "connecting") return;
    const timer = window.setInterval(() => setElapsed(Date.now() - (connection.current?.started ?? Date.now())), 1000);
    return () => clearInterval(timer);
  }, [stage]);
  useEffect(() => {
    if (stage !== "connecting" || pairing || busy) return;
    if (target.current && state?.devices.some(device => device.deviceId === target.current?.deviceId)) setStage("success");
    else if (state?.lastError && (state.lastError !== connection.current?.error || elapsed >= 12000)) setStage("ended");
    else if (elapsed >= 30000) setStage("ended");
  }, [stage, pairing, busy, state, elapsed]);
  async function closeFlow() {
    if (busy || stage === "connecting" || stage === "cancelling") return;
    if (!pairing) { setFlow(false); return; }
    cancelling.current = true; setStage("cancelling");
    if (!(await run(() => api.cancelPairing({ sessionId: pairing.sessionId })))) { cancelling.current = false; setStage("pairing"); }
  }
  async function link(endpoint: string, device?: SyncDevice) {
    target.current = device ?? state?.devices.find(peer => peer.address === endpoint.trim()); connection.current = { started: Date.now(), error: state?.lastError }; setElapsed(0); setStage("connecting"); setMessage("");
    if (!(await run(() => api.linkDevice({ address: endpoint.trim() })))) setStage("find");
  }
  async function copy(endpoint: string) {
    setCopyError("");
    try { if (isNative) await bridge.copyFormatted({ text: endpoint, html: "" }); else await navigator.clipboard.writeText(endpoint); setMessage("Address copied."); }
    catch (failure) { setCopyError(settingsError(failure)); }
  }
  const nearby = [...new Map((state?.nearby ?? []).filter(device => !state?.devices.some(linked => linked.deviceId === device.deviceId) && device.deviceId !== state?.deviceId).map(device => [device.deviceId, device])).values()];
  const endpoints = state?.addresses?.length ? state.addresses : state?.address ? [state.address] : [];
  const pendingRemovals = new Set(state?.removals?.filter(removal => removal.removalPending).flatMap(removal => removal.pendingDevices) ?? []).size;
  const confirmed = pairing?.localConfirmed ?? pairing?.confirmed ?? false;
  return <>
    <section className="settings-page devices-page" aria-label="Linked devices" hidden={!active}>
      {demo && <p className="demo-label">Demo devices · no real connections</p>}
      <div className="device-page-heading"><div><strong>{state?.name || "This device"}</strong><p className="muted" role="status">{!state ? "Loading devices…" : !state.enabled ? "Sync needs attention" : state.phase === "syncing" ? "Syncing saved thoughts…" : "Syncs automatically on your local network"}</p></div>
        <button className="primary" disabled={!state?.enabled || busy} onClick={() => { setStage("find"); setManual(false); setMessage(""); setFlow(true); }}>Link a device</button>
      </div>
      <SettingsFailure error={readError} retry={() => void refresh()} />
      <SettingsFailure error={actionError} />
      {state?.lastError && <div className="settings-error" role="alert"><p>There’s a problem with device sync.</p><details><summary>Details</summary><p>{state.lastError}</p></details><button className="text-button" onClick={() => void run(() => api.syncNow())} disabled={busy || !state.enabled}>Retry sync</button></div>}
      {state && !state.devices.length && <div className="settings-empty"><h3>No linked devices yet</h3><p>Keep your saved library on your other devices.</p></div>}
      {!!state?.devices.length && <div className="settings-list" aria-label="Your linked devices">{state.devices.map(device => <SettingRow key={device.deviceId} title={device.name} detail={`${deviceStatus(device)}${device.lastSync ? ` · Last synced ${new Date(device.lastSync).toLocaleString()}` : " · Not synced yet"}${state.devices.filter(other => other.name === device.name).length > 1 ? ` · ${device.deviceId.slice(0, 8)}` : ""}`} onClick={() => { setSelected(device); setRemoveConfirm(false); }} />)}</div>}
      {!!state?.attachmentsPending && <p role="status">{state.attachmentsPending} original attachment{state.attachmentsPending === 1 ? "" : "s"} waiting to transfer.</p>}
      {!!pendingRemovals && <p role="status">Removal is waiting to reach {pendingRemovals} linked device{pendingRemovals === 1 ? "" : "s"}. It will spread when they reconnect.</p>}
      {!!state?.devices.length && <button className="secondary" disabled={busy || !state.enabled || state.phase === "syncing"} onClick={() => void run(() => api.syncNow()).then(ok => { if (ok) setMessage("Sync requested. Reachable devices will catch up."); })}>{busy ? "Working…" : "Sync now"}</button>}
      {message && <p role="status">{message}</p>}
      <details className="settings-help"><summary>When devices sync</summary><p>Open both apps on the same local network to catch up immediately. No account or internet connection is needed.</p><p>{platform === "ios" ? "iPhone sync runs while Museamo is open." : platform === "android" ? "Android background sync can wait for a battery-friendly opportunity." : "Desktop sync runs while Museamo is running."}</p></details>
    </section>
    {selected && <Sheet title={removeConfirm ? "Remove device?" : selected.name} close={() => { if (!busy) setSelected(undefined); }}>
      {removeConfirm ? <><p>Remove <strong>{selected.name}</strong> from your linked library?</p><p>Existing copies stay on that device. Removal reaches other linked devices when they reconnect.</p><div className="settings-actions"><button className="secondary" disabled={busy} onClick={() => setRemoveConfirm(false)}>Keep linked</button><button className="primary danger" disabled={busy} onClick={() => void run(() => api.removeDevice({ deviceId: selected.deviceId })).then(ok => { if (ok) setSelected(undefined); })}>{busy ? "Removing…" : "Remove device"}</button></div></> : <>
        <SettingRow title="Status" detail={deviceStatus(state?.devices.find(device => device.deviceId === selected.deviceId) ?? selected)} children={<span />} />
        <SettingRow title="Last synced" detail={selected.lastSync ? new Date(selected.lastSync).toLocaleString() : "Not synced yet"} children={<span />} />
        <details className="settings-help"><summary>Connection details</summary><p>Device ID: <code>{selected.deviceId}</code></p>{selected.address && <p>Last known address: <code>{selected.address}</code></p>}</details>
        <div className="settings-actions"><button className="text-button danger" onClick={() => setRemoveConfirm(true)}>Remove device</button><button className="primary" onClick={() => setSelected(undefined)}>Done</button></div>
      </>}
      <SettingsFailure error={actionError || readError} />
    </Sheet>}
    {flow && <Sheet title={stage === "success" ? "Device linked" : stage === "ended" ? "Linking stopped" : "Link a device"} closeDisabled={busy || stage === "connecting" || stage === "cancelling"} close={() => void closeFlow()}>
      {demo && <p className="demo-label">Demo · no real devices are linked</p>}
      <ol className="link-steps" aria-label="Linking progress">{["Find", "Compare", "Combine"].map((label, index) => <li key={label} aria-current={(pairing?.summary ? 2 : pairing ? 1 : 0) === index && stage !== "success" ? "step" : undefined}>{index + 1}. {label}</li>)}</ol>
      {stage === "success" ? <><h3>{target.current?.name || "Your device"} is linked</h3><p>Both devices now share the saved library.</p>{!!state?.attachmentsPending && <p role="status">Original attachments are still transferring.</p>}<div className="settings-actions"><button className="primary" onClick={() => setFlow(false)}>Done</button></div></> : stage === "ended" ? <><p>The link did not complete. Your local library is still here.</p><SettingsFailure error={state?.lastError} /><div className="settings-actions"><button className="secondary" onClick={() => setFlow(false)}>Done</button><button className="primary" onClick={() => { setStage("find"); setManual(false); }}>Try again</button></div></> : stage === "cancelling" ? <p role="status">Cancelling linking…</p> : pairing ? <>
        <h3>{pairing.summary ? `Combine with ${pairing.peer?.name || "the other device"}` : `Compare with ${pairing.peer?.name || "the other device"}`}</h3>
        {pairing.summary ? <>
          <p>The matching code was confirmed on both devices.</p>
          <dl className="library-summary" aria-label="Other device’s library"><div><dt>Thoughts</dt><dd>{pairing.summary.thoughts}</dd></div><div><dt>Tags</dt><dd>{pairing.summary.tags}</dd></div><div><dt>Original attachments</dt><dd>{pairing.summary.attachments} · {formatBytes(pairing.summary.attachmentBytes)}</dd></div></dl>
          <p>Both devices keep the combined library. Earlier versions stay in Recovery.</p><p className="muted">Drafts, widgets, and preferences stay on their own device.</p>
          {pairing.localAccepted ? <p role="status">Approved here. Waiting for {pairing.peer?.name || "the other device"} to approve…</p> : <div className="settings-actions"><button className="primary" disabled={busy} onClick={() => void run(() => api.acceptEnrollment({ sessionId: pairing.sessionId, accepted: true }))}>Combine and link</button></div>}
        </> : pairing.code ? <>
          <p>Confirm only if every code group matches the other screen.</p><output className="pairing-code" aria-label="Matching code">{pairing.code.split(/\s+/).map((group, index) => <span key={index}>{group}{" "}</span>)}</output>
          {confirmed ? <p role="status">Confirmed here. Waiting for {pairing.peer?.name || "the other device"} to confirm…</p> : <div className="settings-actions"><button className="secondary" disabled={busy} onClick={() => { cancelling.current = true; setStage("cancelling"); void run(() => api.confirmPairing({ sessionId: pairing.sessionId, confirmed: false })).then(ok => { if (!ok) { cancelling.current = false; setStage("pairing"); } }); }}>Codes differ</button><button className="primary" disabled={busy} onClick={() => void run(() => api.confirmPairing({ sessionId: pairing.sessionId, confirmed: true }))}>Codes match</button></div>}
        </> : <p role="status">Establishing a secure connection…</p>}
        <button className="text-button" disabled={busy} onClick={() => void closeFlow()}>Cancel linking</button>
      </> : stage === "connecting" ? <><p role="status">Connecting to {target.current?.name || "the other device"}…</p><p className="muted">Keep Museamo open on both devices.</p></> : <>
        {manual ? <><SettingsBack onClick={() => setManual(false)}>Nearby devices</SettingsBack><h3>Use an address</h3><p>Enter the address shown in Museamo on the other device.</p>
          <form onSubmit={event => { event.preventDefault(); void link(address); }}><label className="field-label">Other device address<input value={address} onChange={event => setAddress(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="192.168.1.20:12345" disabled={busy} /></label><div className="settings-actions"><button className="primary" type="submit" disabled={busy || !address.trim()}>Connect</button></div></form>
          <h3>This device’s local addresses</h3>{endpoints.length ? endpoints.map(endpoint => <div className="address-row" key={endpoint}><code>{endpoint}</code><button className="text-button" onClick={() => void copy(endpoint)}>Copy</button></div>) : <p className="muted">No local address is available yet.</p>}
        </> : <><h3>Choose a nearby device</h3><p>Open Museamo on both devices on the same local network.</p>
          {state?.discoveryError ? <p role="status">Nearby discovery is unavailable. You can use an address instead.</p> : !nearby.length ? <div className="settings-empty"><strong>Looking for devices…</strong><p>Keep the other app open. Devices will appear here.</p></div> : <div className="settings-list">{nearby.map(device => <SettingRow key={device.deviceId} title={device.name} detail={nearby.filter(other => other.name === device.name).length > 1 ? `Nearby · ${device.deviceId.slice(0, 8)}` : "Nearby"} disabled={busy || !device.address} onClick={() => void link(device.address!, device)} />)}</div>}
          <button className="text-button" onClick={() => setManual(true)}>Use an address</button>
        </>}
        <details className="settings-help"><summary>Help connecting</summary><ul><li>Keep both apps open on the same local network.</li><li>Guest Wi-Fi can prevent devices from connecting.</li><li>Allow Museamo through the firewall on desktop, and allow Local Network permission on iPhone or Mac.</li></ul><p>Nearby names are hints. Always compare the matching code before linking.</p></details>
      </>}
      <SettingsFailure error={actionError || readError || copyError} retry={readError ? () => void refresh() : undefined} />
      {message && <p role="status">{message}</p>}
    </Sheet>}
  </>;
}
