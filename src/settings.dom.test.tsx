// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Devices } from "./components/Devices";
import { Settings } from "./components/Settings";
import { TagEditor } from "./components/Thoughts";
import { Recovery } from "./components/Recovery";
import { useSettingsResource, type SettingsResource } from "./components/SettingsControls";
import type { SyncState } from "./sync";
import type { TagShareState } from "./sharing";
import type { Tag } from "./data";

const fake = vi.hoisted(() => ({
  getSyncState: vi.fn(), linkDevice: vi.fn(), confirmPairing: vi.fn(), acceptEnrollment: vi.fn(), cancelPairing: vi.fn(), syncNow: vi.fn(), removeDevice: vi.fn(),
  saveTag: vi.fn(), deleteTag: vi.fn(), getTagShareState: vi.fn(), startTagSharing: vi.fn(), createTagInvite: vi.fn(), cancelTagInvite: vi.fn(),
  syncTagShare: vi.fn(), stopTagSharing: vi.fn(), leaveTagShare: vi.fn(), removeTagShareMember: vi.fn(),
  listRecovery: vi.fn(), restoreRecovery: vi.fn(), clearRecovery: vi.fn(), clearAllRecovery: vi.fn(), exportBackup: vi.fn(), importBackup: vi.fn(),
}));
vi.mock("./platform", async original => ({ ...(await original<typeof import("./platform")>()), platform: "android", isPreview: false, isDesktop: false, capabilities: (await original<typeof import("./platform")>()).platformCapabilities("android") }));
vi.mock("./data", async original => ({ ...(await original<typeof import("./data")>()), isNative: true, bridge: { ...fake, addListener: async () => ({ remove: async () => {} }) } }));
let root: Root, host: HTMLDivElement, state: SyncState, share: TagShareState;
const peer = { deviceId: "peer", name: "Other phone", address: "10.0.0.2:9999" };
const tag: Tag = { id: "tag", name: "Errands", type: "standard" };
const code = "AB12 CD34 EF56 7890 ABCD EF12 3456 789A";
const summary = { thoughts: 42, tags: 5, attachments: 3, attachmentBytes: 4096 };
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion"), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  for (const mock of Object.values(fake)) mock.mockReset().mockResolvedValue(undefined);
  state = { enabled: true, phase: "idle", deviceId: "self", name: "My phone", devices: [], nearby: [peer] };
  share = { collectionId: null };
  fake.getSyncState.mockImplementation(async () => structuredClone(state));
  fake.getTagShareState.mockImplementation(async () => structuredClone(share));
  fake.linkDevice.mockImplementation(async () => { state.pairing = { sessionId: "session", peer, code }; state.phase = "pairing"; });
  fake.confirmPairing.mockImplementation(async () => { state.pairing!.localConfirmed = true; });
  fake.startTagSharing.mockImplementation(async () => { share = { collectionId: "collection", role: "owner", status: "waiting", members: [{ id: "owner", name: "Me", owner: true, you: true }] }; return { collectionId: "collection" }; });
  fake.createTagInvite.mockResolvedValue({ inviteId: "invite", invite: "test-invite", expiresAt: Date.now() + 60000, imageDataUrl: "data:image/png;base64,test" });
  fake.listRecovery.mockResolvedValue({ items: [] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = async (content: ReactNode) => { await act(async () => { root.render(content); }); };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent?.trim() === label && !element.closest("[hidden]"))!;
const click = async (label: string) => { const element = button(label); expect(element, label).toBeTruthy(); await act(async () => element.click()); };
const poll = async () => { await act(async () => vi.advanceTimersByTimeAsync(2000)); };
const setName = async (name: string) => { await act(async () => { const input = document.querySelector<HTMLInputElement>(".tag-settings input")!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name); input.dispatchEvent(new Event("input", { bubbles: true })); }); };
const closeSheet = async () => { await act(async () => document.querySelector<HTMLButtonElement>('.sheet [aria-label="Close"]')!.click()); };

it("ignores a stale read after a write and clears a recovered read error", async () => {
  let resource!: SettingsResource<number>;
  const first = deferred<number>(), read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(2).mockRejectedValueOnce(new Error("Read failed")).mockResolvedValueOnce(3);
  function Probe() { resource = useSettingsResource(read); return <span>{resource.value}</span>; }
  await render(<Probe />);
  await act(async () => { expect(await resource.run(async () => {})).toBe(true); });
  expect(resource.value).toBe(2);
  await act(async () => first.resolve(1));
  expect(resource.value).toBe(2);
  await act(async () => { await resource.refresh(); }); expect(resource.readError).toBe("Read failed");
  await act(async () => { await resource.refresh(); }); expect(resource.readError).toBe(""); expect(resource.value).toBe(3);
});

it("deduplicates reads and prevents duplicate writes without confusing a refresh failure with a write failure", async () => {
  let resource!: SettingsResource<number>;
  const read = vi.fn().mockResolvedValueOnce(1), action = deferred<void>();
  function Probe() { resource = useSettingsResource(read); return null; }
  await render(<Probe />);
  const pendingRead = deferred<number>(); read.mockReturnValueOnce(pendingRead.promise);
  const one = resource.refresh(), two = resource.refresh(); expect(one).toBe(two);
  await act(async () => pendingRead.resolve(2));
  const write = vi.fn(() => action.promise); let operation!: Promise<boolean>;
  await act(async () => { operation = resource.run(write); expect(await resource.run(write)).toBe(false); });
  read.mockRejectedValueOnce(new Error("Refresh unavailable"));
  await act(async () => { action.resolve(); expect(await operation).toBe(true); });
  expect(write).toHaveBeenCalledOnce(); expect(resource.actionError).toBe(""); expect(resource.readError).toBe("Refresh unavailable");
});

it("invalidates a manual read started during a write before reading the committed state", async () => {
  let resource!: SettingsResource<number>;
  const stale = deferred<number>(), action = deferred<void>();
  const read = vi.fn().mockResolvedValueOnce(0).mockReturnValueOnce(stale.promise).mockResolvedValueOnce(2);
  function Probe() { resource = useSettingsResource(read); return null; }
  await render(<Probe />);
  let write!: Promise<boolean>;
  await act(async () => { write = resource.run(() => action.promise); });
  void resource.refresh();
  await act(async () => { action.resolve(); await write; });
  expect(resource.value).toBe(2);
  await act(async () => stale.resolve(1));
  expect(resource.value).toBe(2);
});

it("keeps code comparison and peer library approval separate and waits for membership", async () => {
  state.nearby = [peer, peer, { deviceId: "self", name: "My phone" }];
  await render(<Devices api={fake} />); await click("Link a device");
  expect(document.querySelectorAll(".sheet .setting-row")).toHaveLength(1);
  await click("Other phoneNearby");
  expect(document.querySelector(".pairing-code")?.textContent?.trim()).toBe(code);
  expect(button("Combine and link")).toBeUndefined();
  await click("Codes match"); expect(document.body.textContent).toContain("Waiting for Other phone to confirm");
  state.pairing!.summary = summary; state.phase = "merge"; await poll();
  expect(document.querySelector('[aria-label="Other device’s library"]')?.textContent).toContain("42");
  expect(document.body.textContent).toContain("Combine with Other phone");
  fake.acceptEnrollment.mockImplementation(async () => { state.pairing!.localAccepted = true; });
  await click("Combine and link"); expect(document.body.textContent).toContain("Waiting for Other phone to approve");
  state.pairing = null; state.phase = "idle"; await poll();
  expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Linking stopped");
  expect(document.querySelector('[aria-label="Device linked"]')).toBeNull();
});

it("reports linking success only after the peer joins, while attachments remain separate", async () => {
  state.pairing = { sessionId: "session", peer, code, summary };
  fake.acceptEnrollment.mockImplementation(async () => { state.pairing = null; state.devices = [peer]; state.attachmentsPending = 3; });
  await render(<Devices api={fake} active={false} />);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await click("Combine and link");
  expect(document.querySelector('[aria-label="Device linked"]')?.textContent).toContain("Original attachments are still transferring");
});

it("waits for native cancellation and keeps the pairing visible when cancellation fails", async () => {
  state.pairing = { sessionId: "session", peer, code };
  fake.cancelPairing.mockRejectedValueOnce(new Error("Could not cancel"));
  await render(<Devices api={fake} />); await click("Cancel linking");
  expect(document.body.textContent).toContain("Could not cancel"); expect(document.querySelector(".pairing-code")).not.toBeNull();
  await click("Cancel linking"); expect(document.body.textContent).toContain("Cancelling linking");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  state.pairing = null; await poll(); expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("turns a connection failure into an actionable stopped state", async () => {
  fake.linkDevice.mockResolvedValue(undefined);
  await render(<Devices api={fake} />); await click("Link a device"); await click("Other phoneNearby");
  expect(document.body.textContent).toContain("Connecting to Other phone");
  state.lastError = "Connection refused"; await poll();
  expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Linking stopped"); expect(button("Try again")).toBeTruthy();
});

it("protects unsaved tag changes on close and saves before opening sharing", async () => {
  const close = vi.fn();
  await render(<TagEditor tag={tag} close={close} done={async () => {}} />);
  expect(button("Delete tag")).toBeUndefined();
  await setName("Weekend"); await closeSheet(); expect(close).not.toHaveBeenCalled(); expect(button("Discard changes")).toBeTruthy();
  await click("Keep editing"); await click("SharingPrivate · Share hashtag with other people");
  expect(button("Save and continue")).toBeTruthy(); expect(fake.startTagSharing).not.toHaveBeenCalled();
  fake.saveTag.mockRejectedValueOnce(new Error("Save unavailable")); await click("Save and continue");
  expect(document.body.textContent).toContain("Save unavailable"); expect(document.querySelector<HTMLInputElement>(".tag-settings input")!.value).toBe("Weekend");
  await click("Save and continue"); expect(fake.saveTag).toHaveBeenLastCalledWith({ id: "tag", name: "Weekend", type: "standard" });
  await click("Share this tag"); expect(fake.startTagSharing).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("saved locations"); expect(button("Share and show QR")).toBeTruthy();
});

it("does not create a tag twice when refreshing after a committed creation fails", async () => {
  const done = vi.fn().mockRejectedValueOnce(new Error("Refresh failed")).mockResolvedValue(undefined), close = vi.fn();
  await render(<TagEditor tag="new" close={close} done={done} />); await setName("New list"); await click("Create tag");
  expect(document.body.textContent).toContain("Tag saved, but the library could not refresh");
  await click("Retry library refresh"); expect(fake.saveTag).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});

it("allows retrying an invitation after sharing starts without restarting sharing", async () => {
  fake.createTagInvite.mockRejectedValueOnce(new Error("Invitation unavailable"));
  await render(<TagEditor tag={tag} close={() => {}} done={async () => {}} />);
  await click("SharingPrivate · Share hashtag with other people"); await click("Share this tag"); await click("Share and show QR");
  expect(fake.startTagSharing).toHaveBeenCalledOnce(); expect(document.body.textContent).toContain("Invitation unavailable");
  await click("Retry invitation"); expect(fake.startTagSharing).toHaveBeenCalledOnce(); expect(document.querySelector(".share-invitation img")).not.toBeNull();
  fake.cancelTagInvite.mockRejectedValueOnce(new Error("Cancellation unavailable")); await closeSheet();
  expect(document.body.textContent).toContain("Cancellation unavailable"); expect(document.querySelector(".share-invitation img")).not.toBeNull();
  await closeSheet(); expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Tag settings");
});

it("gives shared members a usable Done action with read-only tag fields", async () => {
  share = { collectionId: "collection", role: "member", status: "waiting" };
  await render(<TagEditor tag={{ ...tag, sharing: { collectionId: "collection", role: "member", status: "waiting" } }} close={() => {}} done={async () => {}} />);
  expect(document.querySelector<HTMLInputElement>(".tag-settings input")!.disabled).toBe(true); expect(button("Save tag")).toBeUndefined(); expect(button("Done")?.disabled).toBe(false);
  await click("Shared hashtagMember · Manage sharing"); expect(button("Invite someone")).toBeUndefined();
});

it("keeps Recovery compact, pages large lists, and confirms permanent clearing", async () => {
  const longText = "Saved version ".repeat(50);
  fake.listRecovery.mockResolvedValue({ items: Array.from({ length: 110 }, (_, id) => ({ id: String(id), kind: "entry", createdAt: 1000 + id, payload: { text: longText, attachments: [] } })) });
  await render(<Recovery report={() => {}} />); expect(host.querySelectorAll(".setting-row")).toHaveLength(50); expect(host.textContent).not.toContain(longText);
  await click("Show more"); expect(host.querySelectorAll(".setting-row")).toHaveLength(100);
  await act(async () => host.querySelector<HTMLButtonElement>(".setting-row")!.click()); expect(document.querySelector(".rich-text")?.textContent).toContain(longText.trim());
  await click("Clear permanently"); expect(fake.clearRecovery).not.toHaveBeenCalled(); expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await click("Keep in Recovery"); expect(fake.clearRecovery).not.toHaveBeenCalled();
});

it("prevents duplicate backup export while the system picker is open and treats cancellation distinctly", async () => {
  const result = deferred<{ cancelled: boolean }>(); fake.exportBackup.mockReturnValue(result.promise);
  await render(<Settings section="backup" library={{ tags: [], profiles: [] }} report={() => {}} refresh={() => {}} />);
  await click("Export backup"); await click("Export backup"); expect(fake.exportBackup).toHaveBeenCalledOnce(); expect(button("Import backup").disabled).toBe(true);
  await act(async () => result.resolve({ cancelled: true })); expect(host.textContent).toContain("Cancelled. Your library has not changed");
});
