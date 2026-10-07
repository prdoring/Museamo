import type { CompanionBridge, SyncState } from "./sync";

export type DeviceBridge = Pick<CompanionBridge, "getSyncState" | "linkDevice" | "confirmPairing" | "acceptEnrollment" | "cancelPairing" | "syncNow" | "removeDevice">;

/** Only supplied by the explicitly labeled in-memory browser preview. */
export function createDevicePreview(): DeviceBridge & { scenario: (kind: "empty" | "linked" | "unavailable" | "incoming") => void } {
  let state: SyncState = { enabled: true, name: "This demo device", deviceId: "demo-local", phase: "idle", address: "192.168.1.20:54321", devices: [], nearby: [{ deviceId: "demo-phone", name: "My phone", address: "192.168.1.21:54321" }] };
  const pairing = () => { state.phase = "pairing"; state.pairing = { sessionId: "demo-session", code: "0123 4567 89AB CDEF 0123 4567 89AB CDEF", peer: state.nearby[0] ?? { deviceId: "demo-phone", name: "My phone" }, localConfirmed: false }; };
  return {
    async getSyncState() { return structuredClone(state); },
    async linkDevice() { pairing(); },
    async confirmPairing({ confirmed }) { if (!confirmed) { state.pairing = null; state.phase = "idle"; } else if (state.pairing) { state.pairing.localConfirmed = true; state.pairing.peerConfirmed = true; state.pairing.summary = { thoughts: 24, tags: 4, attachments: 3, attachmentBytes: 8388608 }; state.phase = "merge"; } },
    async acceptEnrollment() { state.devices = [{ deviceId: "demo-phone", name: "My phone", status: "available", lastSync: Date.now() }]; state.pairing = null; state.phase = "idle"; },
    async cancelPairing() { state.pairing = null; state.phase = "idle"; },
    async syncNow() { state.devices = state.devices.map(device => ({ ...device, lastSync: Date.now() })); },
    async removeDevice({ deviceId }) { state.devices = state.devices.filter(device => device.deviceId !== deviceId); },
    scenario(kind) { state.pairing = null; state.phase = "idle"; state.devices = []; state.discoveryError = kind === "unavailable" ? "Nearby discovery is unavailable in this demo." : null; state.nearby = kind === "unavailable" ? [] : [{ deviceId: "demo-phone", name: "My phone", address: "192.168.1.21:54321" }]; if (kind === "linked") state.devices = [{ deviceId: "demo-phone", name: "My phone", status: "available", lastSync: Date.now() - 120000 }, { deviceId: "demo-laptop", name: "My laptop", status: "linked", lastSync: Date.now() - 86400000 }]; if (kind === "incoming") pairing(); },
  };
}
