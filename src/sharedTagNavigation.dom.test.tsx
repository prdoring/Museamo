// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Tag } from "./data";
import App from "./App";

const fake = vi.hoisted(() => ({ queries: [] as { starred: boolean; tagId?: string; resolve: (page: unknown) => void; reject: (error: Error) => void }[], changed: () => {}, tags: [] as Tag[] }));
vi.mock("./platform", async importOriginal => ({ ...(await importOriginal<typeof import("./platform")>()), platform: "android", isDesktop: false, isPreview: false, capabilities: (await importOriginal<typeof import("./platform")>()).platformCapabilities("android") }));
vi.mock("./components/LocationMap", () => ({ LocationMap: () => null }));
vi.mock("./data", async importOriginal => ({ ...(await importOriginal<typeof import("./data")>()), isNative: true,
  bridge: {
    library: async () => ({ tags: fake.tags, profiles: [] }),
    addListener: async (_name: string, changed: () => void) => { fake.changed = changed; return { remove: async () => {} }; },
    queryEntries: (options: { starred: boolean; tagId?: string }) => new Promise((resolve, reject) => fake.queries.push({ starred: options.starred, tagId: options.tagId, resolve, reject })),
  },
}));
let root: Root, host: HTMLDivElement, scroll = 0;
const entries = (...ids: string[]) => ids.map(id => ({ id, text: id, createdAt: 1000, tagIds: id.includes("movie") ? ["movie-list"] : id.includes("friend") ? ["friendship"] : [], completed: false, starred: false }));
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const resolve = (index: number, ...ids: string[]) => act(async () => { fake.queries[index].resolve({ entries: entries(...ids), hasMore: false }); });
beforeEach(async () => {
  fake.queries = []; fake.tags = [
    { id: "movie-list", name: "movie list", type: "checklist", sharing: { collectionId: "movies", role: "owner", status: "waiting" } },
    { id: "friendship", name: "friendship", type: "standard", sharing: { collectionId: "friends", role: "member", status: "waiting" } },
  ]; scroll = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => scroll);
  vi.spyOn(window, "scrollTo").mockImplementation((_x, y) => { scroll = Number(y); });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function(this: HTMLElement) {
    return this.hasAttribute("data-entry-id") ? [...this.parentElement!.children].indexOf(this) * 100 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    const top = this.offsetTop - scroll;
    return { top, bottom: top + 100, left: 0, right: 400, x: 0, y: top, height: 100, width: 400, toJSON() {} };
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<App />)); await flush();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const click = async (selector: string) => { act(() => host.querySelector<HTMLButtonElement>(selector)!.click()); await flush(); };
const openCollection = async (name: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>('.tag-row > button:first-child')].find(button => button.textContent?.includes(name))!;
  act(() => button.click()); await flush();
};
it("keeps two shared hashtags isolated when switching and returning to cached views", async () => {
  await resolve(fake.queries.length - 1, "movie item", "friend item");
  await click('nav button[title="Tags"]');
  await resolve(fake.queries.length - 1, "movie item", "friend item");
  await openCollection("movie list");
  expect(fake.queries.at(-1)!.tagId).toBe("movie-list");
  await resolve(fake.queries.length - 1, "movie item");
  await click('button[aria-label="Back"]');
  await openCollection("friendship");
  expect(fake.queries.at(-1)!.tagId).toBe("friendship");
  expect(host.textContent).not.toContain("movie item");
  await resolve(fake.queries.length - 1, "friend item");
  expect(host.textContent).toContain("friend item");
  expect(host.textContent).not.toContain("movie item");
  await click('button[aria-label="Back"]');
  await openCollection("movie list");
  expect(host.textContent).toContain("movie item");
  expect(host.textContent).not.toContain("friend item");
});

it("ignores a delayed shared-list response after opening another shared hashtag", async () => {
  await resolve(fake.queries.length - 1);
  await click('nav button[title="Tags"]');
  await resolve(fake.queries.length - 1);
  await openCollection("movie list");
  const movieRequest = fake.queries.length - 1;
  await click('button[aria-label="Back"]');
  await openCollection("friendship");
  const friendRequest = fake.queries.length - 1;
  await resolve(movieRequest, "private movie item");
  expect(host.textContent).not.toContain("private movie item");
  await resolve(friendRequest, "friend item");
  act(() => fake.changed()); await flush();
  const refresh = fake.queries.length - 1;
  await click('button[aria-label="Back"]');
  await openCollection("movie list");
  await resolve(fake.queries.length - 1, "private movie item");
  await resolve(refresh, "stale friend item");
  expect(host.textContent).toContain("private movie item");
  expect(host.textContent).not.toContain("stale friend item");
});

it("does not cache another view's entries when leaving before cached results commit", async () => {
  await resolve(fake.queries.length - 1, "private movie item", "friend item");
  await click('nav button[title="Tags"]');
  await resolve(fake.queries.length - 1, "private movie item", "friend item");
  await openCollection("movie list");
  await resolve(fake.queries.length - 1, "private movie item");
  await click('button[aria-label="Back"]');
  await openCollection("friendship");
  await resolve(fake.queries.length - 1, "friend item");
  await click('button[aria-label="Back"]');
  // A back tap can arrive after navigation commits but before its cached rows commit.
  let leaveCachedView = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    if (leaveCachedView && host.querySelector("h1")?.textContent?.includes("friendship")) {
      leaveCachedView = false;
      host.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click();
    }
    return 0;
  });
  await openCollection("friendship");
  expect(host.querySelector("h1")?.textContent).toBe("Tags");
  await openCollection("friendship");
  expect(host.textContent).toContain("friend item");
  expect(host.textContent).not.toContain("private movie item");
});
