// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Settings } from "./components/Settings";
import { Devices } from "./components/Devices";
import { Editor, TagEditor } from "./components/Thoughts";
import { Navigation } from "./components/Navigation";
import { MediaGallery } from "./components/Media";
import { TagList } from "./components/LibraryViews";
import App from "./App";
import { JoinSharedTag } from "./components/Sharing";

const fake = vi.hoisted(() => ({
  forbidden: Object.fromEntries(["compose", "locationSettings", "currentLocation", "getStartupSettings", "configureWidget", "exportBackup", "importBackup"].map(name => [name, vi.fn()])),
  getSyncState: vi.fn().mockResolvedValue({ enabled: true, phase: "idle", devices: [], nearby: [] }),
  getTagShareState: vi.fn().mockResolvedValue({ collectionId: null }),
  resolveMedia: vi.fn().mockResolvedValue({ url: "", availability: "pending" }),
  releaseMedia: vi.fn().mockResolvedValue(undefined),
  pickMedia: vi.fn().mockResolvedValue({ attachments: [] }),
  scanTagInvite: vi.fn().mockResolvedValue({ cancelled: true }),
  previewTagInvite: vi.fn(),
  joinTagShare: vi.fn(),
  listRecovery: vi.fn().mockResolvedValue({ items: [] }),
  addListener: vi.fn().mockResolvedValue({ remove: async () => {} }),
  library: vi.fn().mockResolvedValue({ tags: [], profiles: [] }),
  queryEntries: vi.fn().mockResolvedValue({ entries: [], hasMore: false }),
  getDraft: vi.fn().mockResolvedValue({ draft: { profileKey: "app:general", entryId: "unfinished", text: "An unfinished native draft", tagIds: [], profileId: null } }),
}));
vi.mock("./platform", async importOriginal => ({ ...(await importOriginal<typeof import("./platform")>()), platform: "ios", isPreview: false, isDesktop: false, capabilities: { nativeCapture: false, widgets: false, automaticLocation: false, manualLocation: true, location: true, media: true, backups: false, sync: true, sharing: true, recovery: true } }));
vi.mock("./data", async importOriginal => ({ ...(await importOriginal<typeof import("./data")>()), isNative: true, bridge: { ...fake, ...fake.forbidden, listRecovery: fake.listRecovery, addListener: fake.addListener, library: fake.library, queryEntries: fake.queryEntries, getDraft: fake.getDraft } }));

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  fake.scanTagInvite.mockReset().mockResolvedValue({ cancelled: true });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { constructor(private callback: IntersectionObserverCallback) {} observe() { this.callback([{ isIntersecting: true }] as IntersectionObserverEntry[], this as unknown as IntersectionObserver); } disconnect() {} });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(window, "scrollBy").mockImplementation(() => {});
  // jsdom has no range layout; ProseMirror reads it when autofocus scrolls.
  const createRange = document.createRange.bind(document);
  vi.spyOn(document, "createRange").mockImplementation(() => {
    const range = createRange();
    range.getClientRects = () => [] as unknown as DOMRectList;
    range.getBoundingClientRect = () => new DOMRect(0, 0, 100, 20);
    return range;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = async (element: React.ReactNode) => { await act(async () => { root.render(element); await Promise.resolve(); }); };
const expectNoUnsupportedCalls = () => { for (const method of Object.values(fake.forbidden)) expect(method).not.toHaveBeenCalled(); };

it("shows linking and Recovery while keeping automatic capture, widgets, and backups unavailable", async () => {
  await render(<Settings library={{ tags: [], profiles: [] }} report={() => {}} run={async fn => { await fn(); }} refresh={() => {}} />);
  expect(fake.listRecovery).not.toHaveBeenCalled();
  for (const label of ["Post locations", "Widgets", "Export backup", "Import backup"]) expect(host.textContent).not.toContain(label);
  expect(host.textContent).not.toContain("export a backup first");
  expect(host.textContent).toContain("Linked devices");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-setting="recovery"]')!.click());
  expect(fake.listRecovery).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Nothing in Recovery.");
  await act(async () => host.querySelector<HTMLButtonElement>(".settings-back")!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[data-setting="about"]')!.click());
  expect(host.textContent).toContain("Backup export and import are not available yet on iPhone.");
  expectNoUnsupportedCalls();
});
it("exposes saved maps, sharing, and pending originals", async () => {
  await render(<><Navigation tab="tags" compose={() => {}} navigate={() => {}} /><Devices /><TagList tags={[]} query="" open={() => {}} edit={() => {}} /><TagEditor tag={{ id: "tag", name: "Tasks", type: "checklist" }} done={async () => {}} close={() => {}} /><MediaGallery attachments={[{ id: "photo", kind: "image", filename: "photo.jpg", mimeType: "image/jpeg", byteSize: 1, width: 1, height: 1 }]} text="https://example.com/photo.jpg" /></>);
  expect(document.querySelector('[title="Map"]')).not.toBeNull();
  expect(document.body.textContent).toContain("Share hashtag");
  expect(document.body.textContent).toContain("Join shared hashtag");
  expect(document.querySelector(".media-grid")).not.toBeNull();
  expect(fake.resolveMedia).toHaveBeenCalledWith({ id: "photo" });
  expectNoUnsupportedCalls();
});
it("offers manual media and location without collecting location on composer mount", async () => {
  await render(<Editor initial={{ text: "A durable thought", tagIds: [] }} tags={[]} capture save={async () => {}} refreshTags={async () => {}} close={() => {}} />);
  expect(document.querySelector('[aria-label="Thought text"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Text formatting"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Add tag"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Attach photos/videos"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Post location"]')).not.toBeNull();
  await render(null);
  expectNoUnsupportedCalls();
});
it("opens a persisted native draft through the React composer from the iOS library", async () => {
  await render(<App />);
  await act(async () => { host.querySelector<HTMLButtonElement>(".capture-bar")!.click(); await Promise.resolve(); });
  expect(fake.library).toHaveBeenCalled();
  expect(fake.queryEntries).toHaveBeenCalled();
  expect(fake.getDraft).toHaveBeenCalledExactlyOnceWith({ tagId: undefined });
  expect(document.querySelector('[aria-label="Thought text"]')?.textContent).toBe("An unfinished native draft");
  expectNoUnsupportedCalls();
});

it("requests location only on tap and preserves text when permission is denied", async () => {
  fake.forbidden.currentLocation.mockResolvedValue({ location: null, status: "permission-denied" });
  await render(<Editor initial={{ text: "Keep my writing", tagIds: [] }} tags={[]} capture save={async () => {}} refreshTags={async () => {}} close={() => {}} />);
  expect(fake.forbidden.currentLocation).not.toHaveBeenCalled();
  await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Post location"]')!.click(); await Promise.resolve(); });
  expect(fake.forbidden.currentLocation).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Location permission was not granted.");
  expect(document.querySelector('[aria-label="Thought text"]')?.textContent).toBe("Keep my writing");
});
it("scanner cancellation does not preview or join a collection", async () => {
  await render(<JoinSharedTag joined={async () => {}} />);
  await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
  expect(fake.scanTagInvite).toHaveBeenCalledOnce(); expect(fake.previewTagInvite).not.toHaveBeenCalled(); expect(fake.joinTagShare).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it("shows native camera errors and allows another scan", async () => {
  fake.scanTagInvite.mockRejectedValue(new Error("Camera permission was denied."));
  await render(<JoinSharedTag joined={async () => {}} />);
  await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
  expect(document.body.textContent).toContain("Camera permission was denied.");
  expect(document.body.textContent).toContain("Scan another QR code");
  expect(fake.joinTagShare).not.toHaveBeenCalled();
});
