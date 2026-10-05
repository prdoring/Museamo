// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Entry } from "./data";
import App from "./App";

const fake = vi.hoisted(() => ({ queries: [] as { starred: boolean; resolve: (page: unknown) => void; reject: (error: Error) => void }[], changed: () => {} }));
vi.mock("./platform", async importOriginal => ({ ...(await importOriginal<typeof import("./platform")>()), platform: "preview", isDesktop: false, isPreview: false, capabilities: { nativeCapture: false } }));
vi.mock("./components/LocationMap", () => ({ LocationMap: () => null }));
vi.mock("./data", async importOriginal => ({ ...(await importOriginal<typeof import("./data")>()), isNative: false,
  bridge: {
    library: async () => ({ tags: [], profiles: [] }),
    addListener: async (_name: string, changed: () => void) => { fake.changed = changed; return { remove: async () => {} }; },
    queryEntries: (options: { starred: boolean }) => new Promise((resolve, reject) => fake.queries.push({ starred: options.starred, resolve, reject })),
  },
}));
vi.mock("./components/Feed", () => ({ Feed: ({ entries, reason, beforeLayout }: { entries: Entry[]; reason: string; beforeLayout: () => void }) => {
  useLayoutEffect(() => beforeLayout());
  return <section data-reason={reason}>{entries.map(entry => <article key={entry.id} data-entry-id={entry.id}>{entry.text}</article>)}</section>;
} }));

let root: Root, host: HTMLDivElement, scroll = 0;
const entries = (...ids: string[]) => ids.map(id => ({ id, text: id, createdAt: 1000, tagIds: [], completed: false, starred: false }));
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const resolve = (index: number, ...ids: string[]) => act(async () => { fake.queries[index].resolve({ entries: entries(...ids), hasMore: false }); });
beforeEach(async () => {
  fake.queries = []; scroll = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
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

it("treats the startup listener refresh as initial data", async () => {
  await resolve(fake.queries.length - 1, "first");
  expect(host.querySelector('[data-reason="initial"]')?.textContent).toBe("first");
});
it("ignores an older view's response and failure after navigation", async () => {
  const prior = fake.queries.length - 1;
  const gems = host.querySelector<HTMLButtonElement>('nav button[title="Gems"]')!;
  act(() => gems.click()); await flush();
  expect(fake.queries.at(-1)!.starred).toBe(true);
  await resolve(fake.queries.length - 1, "gem result"); await resolve(prior, "stale stream result");
  expect(host.textContent).toContain("gem result"); expect(host.textContent).not.toContain("stale stream result");
  act(() => fake.changed()); await flush();
  const stale = fake.queries.length - 1;
  act(() => fake.changed()); await flush();
  await resolve(fake.queries.length - 1, "fresh gem result");
  await act(async () => fake.queries[stale].reject(new Error("Stale failure")));
  expect(host.textContent).toContain("fresh gem result"); expect(host.textContent).not.toContain("Stale failure");
});
it("anchors a background refresh to the reader's position at commit time", async () => {
  await resolve(fake.queries.length - 1, "a", "b", "c"); scroll = 180;
  act(() => fake.changed()); await flush();
  scroll = 240; // The reader continues scrolling while the query is pending.
  await resolve(fake.queries.length - 1, "new", "a", "b", "c");
  expect(scroll).toBe(340);
  expect(host.querySelector('[data-reason="refresh"]')?.textContent).toBe("newabc");
});
