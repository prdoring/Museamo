import type { Entry, Tag } from "./data";

export interface SyncSummary { thoughts: number; tags: number; attachments: number; attachmentBytes: number }
export interface SyncDevice { deviceId: string; name: string; address?: string; status?: string; lastSync?: number; removalPending?: boolean }
export interface SyncState {
  enabled: boolean;
  phase: "idle" | "pairing" | "merge" | "syncing" | "error";
  address?: string;
  addresses?: string[];
  devices: SyncDevice[];
  nearby: SyncDevice[];
  discoveryAvailable?: boolean;
  discoveryError?: string | null;
  pairing?: {
    sessionId: string; code?: string; peer?: SyncDevice; summary?: SyncSummary;
    confirmed?: boolean; localConfirmed?: boolean; peerConfirmed?: boolean;
    localAccepted?: boolean; peerAccepted?: boolean;
  } | null;
  lastError?: string | null;
  attachmentsPending?: number;
  removals?: { id: string; subject: string; pendingDevices: string[]; removalPending: boolean }[];
}
export interface RecoveryItem { id: string; kind: string; entityId: string; payload: Entry | Tag; createdAt: number }
export interface CompanionBridge {
  getSyncState(): Promise<SyncState>;
  listDevices(): Promise<{ devices: SyncDevice[]; nearby?: SyncDevice[] }>;
  linkDevice(input: { address: string }): Promise<unknown>;
  confirmPairing(input: { sessionId: string; confirmed: boolean }): Promise<unknown>;
  acceptEnrollment(input: { sessionId: string; accepted: boolean }): Promise<unknown>;
  syncNow(): Promise<unknown>;
  removeDevice(input: { deviceId: string }): Promise<unknown>;
  cancelPairing(input: { sessionId: string }): Promise<unknown>;
  listRecovery(): Promise<{ items: RecoveryItem[] }>;
  restoreRecovery(input: { id: string }): Promise<{ entryId?: string }>;
  clearRecovery(input: { id: string }): Promise<unknown>;
  clearAllRecovery(): Promise<unknown>;
  getStartupSettings(): Promise<{ enabled: boolean }>;
  setStartupEnabled(input: { enabled: boolean }): Promise<{ enabled: boolean }>;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
