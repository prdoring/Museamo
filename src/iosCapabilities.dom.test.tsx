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

const fake = vi.hoisted(() => ({
  forbidden: Object.fromEntries(["compose", "locationSettings", "currentLocation", "getStartupSettings", "getSyncState", "getTagShareState", "pickMedia", "resolveMedia", "releaseMedia", "configureWidget", "exportBackup", "importBackup"].map(name => [name, vi.fn()])),
  listRecovery: vi.fn().mockResolvedValue({ items: [] }),
  addListener: vi.fn().mockResolvedValue({ remove: async () => {} }),
  library: vi.fn().mockResolvedValue({ tags: [], profiles: [] }),
  queryEntries: vi.fn().mockResolvedValue({ entries: [], hasMore: false }),
  getDraft: vi.fn().mockResolvedValue({ draft: { profileKey: "app:general", entryId: "unfinished", text: "An unfinished native draft", tagIds: [], profileId: null } }),
}));
vi.mock("./platform", async importOriginal => ({ ...(await importOriginal<typeof import("./platform")>()), platform: "ios", isPreview: false, isDesktop: false, capabilities: { nativeCapture: false, widgets: false, automaticLocation: false, location: false, media: false, backups: false, sync: false, sharing: false, recovery: true } }));
vi.mock("./data", async importOriginal => ({ ...(await importOriginal<typeof import("./data")>()), isNative: true, bridge: { ...fake.forbidden, listRecovery: fake.listRecovery, addListener: fake.addListener, library: fake.library, queryEntries: fake.queryEntries, getDraft: fake.getDraft } }));

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
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

it("loads local Recovery in Settings without initializing unavailable native services", async () => {
  await render(<Settings library={{ tags: [], profiles: [] }} report={() => {}} run={async fn => { await fn(); }} refresh={() => {}} />);
  expect(fake.listRecovery).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Nothing in Recovery.");
  for (const label of ["Linked devices", "Post locations", "Widgets", "Export", "Import"]) expect(host.textContent).not.toContain(label);
  expect(host.textContent).toContain("Your thoughts, tags, and drafts are saved on this device.");
  expectNoUnsupportedCalls();
});
it("hides map, sharing, and media controls even if unsupported components are mounted directly", async () => {
  await render(<><Navigation tab="tags" compose={() => {}} navigate={() => {}} /><Devices /><TagList tags={[]} query="" open={() => {}} edit={() => {}} /><TagEditor tag={{ id: "tag", name: "Tasks", type: "checklist" }} done={async () => {}} close={() => {}} /><MediaGallery attachments={[{ id: "photo", kind: "image", filename: "photo.jpg", mimeType: "image/jpeg", byteSize: 1, width: 1, height: 1 }]} text="https://example.com/photo.jpg" /></>);
  expect(document.querySelector('[title="Map"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Share hashtag");
  expect(document.body.textContent).not.toContain("Join shared hashtag");
  expect(document.querySelector(".media-grid")).toBeNull();
  expectNoUnsupportedCalls();
});
it("keeps the React text composer usable without media or location bridge calls on mount and close", async () => {
  await render(<Editor initial={{ text: "A durable thought", tagIds: [] }} tags={[]} capture save={async () => {}} refreshTags={async () => {}} close={() => {}} />);
  expect(document.querySelector('[aria-label="Thought text"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Text formatting"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Add tag"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Attach photos/videos"]')).toBeNull();
  expect(document.querySelector('[aria-label="Post location"]')).toBeNull();
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
