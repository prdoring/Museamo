import { useEffect, useRef, useState } from "react";
import { bridge } from "../data";
import { formatBytes, type SyncDevice, type SyncState } from "../sync";

export function Devices() {
  const [state, setState] = useState<SyncState>();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<SyncDevice>();
  const mounted = useRef(false), pending = useRef(false);
  async function refresh() {
    try { const next = await bridge.getSyncState(); if (mounted.current) { setState(next); } }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
  }
  useEffect(() => {
    mounted.current = true;
    let loading = false;
    const update = async () => { if (loading || document.hidden) return; loading = true; try { await refresh(); } finally { loading = false; } };
    void update();
    const timer = window.setInterval(() => void update(), 2000);
    document.addEventListener("visibilitychange", update);
    return () => { mounted.current = false; clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, []);
  async function run(action: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await action(); await refresh(); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const pairing = state?.pairing;
  const confirmed = pairing?.localConfirmed ?? pairing?.confirmed ?? false;
  return <section aria-labelledby="devices-title">
    <h2 id="devices-title">Linked devices</h2>
    <p>Keep your saved thoughts, tags, and original attachments on every linked device. Sync uses your local network and needs no account or internet connection.</p>
    {!state && !error && <p role="status">Loading devices…</p>}
    {error && <p className="error" role="alert">{error} <button onClick={() => void refresh()}>Retry</button></p>}
    {state?.lastError && <p className="error" role="alert">{state.lastError}</p>}
    {state && !state.enabled && <p>Sync is stopped. Resolve the error above before linking or syncing again.</p>}
    {state?.enabled && <>
      {state.discoveryError && <p className="muted">Nearby discovery is unavailable. Use a device’s local address to link it.</p>}
      <p className="muted" role="status">{state.phase === "syncing" ? "Syncing saved thoughts…" : "Sync automatically when linked devices are reachable."}{!!state.attachmentsPending && ` ${state.attachmentsPending} original attachment(s) waiting to transfer.`}</p>
      {!!state.devices.length && <div className="device-list">{state.devices.map(device => <div className="device-row" key={device.deviceId}>
        <div><strong>{device.name}</strong><small>{device.removalPending ? "Removal waiting to reach other devices" : device.status || "Linked"}{device.lastSync ? ` · Last synced ${new Date(device.lastSync).toLocaleString()}` : ""}</small></div>
        <button className="text-button" disabled={busy} onClick={() => setRemoving(device)}>Remove</button>
      </div>)}</div>}
      {!state.devices.length && <p className="muted">No linked devices yet. Open Museamo on both devices and use the same local network.</p>}
      {!!state.removals?.some(removal => removal.removalPending) && <p role="status">Device removal is waiting to reach {new Set(state.removals.filter(removal => removal.removalPending).flatMap(removal => removal.pendingDevices)).size} linked device(s). It will spread when they reconnect.</p>}
      {!!state.devices.length && <button className="secondary" disabled={busy || state.phase === "syncing"} onClick={() => void run(() => bridge.syncNow())}>Sync now</button>}
      {removing && <div className="sync-confirm" role="group" aria-label="Confirm device removal">
        <p>Remove <strong>{removing.name}</strong>? Removal spreads when the other devices reconnect. This keeps existing copies on that device.</p>
        <div className="action-row"><button className="secondary" disabled={busy} onClick={() => setRemoving(undefined)}>Keep linked</button><button className="secondary danger" disabled={busy} onClick={() => void run(async () => { await bridge.removeDevice({ deviceId: removing.deviceId }); setRemoving(undefined); })}>Remove device</button></div>
      </div>}
      {pairing ? <div className="sync-confirm" role="group" aria-label="Link device">
        <h3>Link with {pairing.peer?.name || "nearby device"}</h3>
        {pairing.summary ? <>
          <p>The matching code has been verified on both devices. This device has {pairing.summary.thoughts} thoughts, {pairing.summary.tags} tags, and {pairing.summary.attachments} original attachments ({formatBytes(pairing.summary.attachmentBytes)}).</p>
          <p>Combine these libraries? Both devices will keep the combined library. Earlier versions stay in Recovery. Drafts, widgets, and preferences stay on their own device.</p>
          {pairing.localAccepted ? <p role="status">Waiting for the other device to approve…</p> : <button className="primary" disabled={busy} onClick={() => void run(() => bridge.acceptEnrollment({ sessionId: pairing.sessionId, accepted: true }))}>Combine and link</button>}
        </> : pairing.code ? <>
          <p>Compare this code with the code on the other device. Confirm only if every group matches.</p>
          <output className="pairing-code" aria-label="Matching code">{pairing.code}</output>
          {confirmed ? <p role="status">Waiting for confirmation on the other device…</p> : <div className="action-row"><button className="primary" disabled={busy} onClick={() => void run(() => bridge.confirmPairing({ sessionId: pairing.sessionId, confirmed: true }))}>Codes match</button><button className="secondary" disabled={busy} onClick={() => void run(() => bridge.confirmPairing({ sessionId: pairing.sessionId, confirmed: false }))}>Codes differ</button></div>}
        </> : <p role="status">Establishing a secure connection…</p>}
        <button className="text-button" disabled={busy} onClick={() => void run(() => bridge.cancelPairing({ sessionId: pairing.sessionId }))}>Cancel linking</button>
      </div> : <>
        {!!state.nearby.length && <div className="nearby-devices"><h3>Nearby</h3>{state.nearby.filter(device => !state.devices.some(linked => linked.deviceId === device.deviceId)).map(device => <button className="menu-row" key={`${device.deviceId}/${device.address}`} disabled={busy || !device.address} onClick={() => void run(() => bridge.linkDevice({ address: device.address! }))}>{device.name}<span>Link</span></button>)}</div>}
        <details className="manual-link"><summary>Link using an address</summary>
          <p>If discovery is blocked, enter the address shown in Museamo on the other device. Guest Wi-Fi may prevent devices connecting.</p>
          {!!(state.addresses?.length || state.address) && <div className="local-addresses"><p>This device’s local address{(state.addresses?.length || 0) > 1 ? "es" : ""}:</p>{(state.addresses?.length ? state.addresses : [state.address!]).map(endpoint => <code key={endpoint}>{endpoint}</code>)}</div>}
          <form onSubmit={e => { e.preventDefault(); void run(() => bridge.linkDevice({ address: address.trim() })); }}><label>Other device address<input value={address} onChange={e => setAddress(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="192.168.1.20:12345" disabled={busy} /></label><button className="secondary" type="submit" disabled={busy || !address.trim()}>Link device</button></form>
        </details>
      </>}
      <p className="muted">Android background sync may wait for a battery-friendly opportunity. Open both apps and choose Sync now to catch up immediately.</p>
    </>}
  </section>;
}
