// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotionList, Presence, Disclosure, PageMotion, animateElement, type MotionItem } from "./components/Motion";
import { DesktopLayout, DesktopRuntime, WindowControls } from "./components/Desktop";
import { previewDesktopInfo } from "./platform";
import { ActionMenu } from "./components/ActionMenu";
import { PhotoViewer } from "./components/PhotoViewer";
import { captureReadingAnchor, restoreReadingAnchor } from "./feedMotion";
import { createRef } from "react";

let host: HTMLDivElement, root: Root;
let reduced = false;
let preference: EventTarget & MediaQueryList;
const animate = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); reduced = false;
  preference = Object.assign(new EventTarget(), { get matches() { return reduced; }, media: "", onchange: null, addListener() {}, removeListener() {} }) as EventTarget & MediaQueryList;
  Object.defineProperty(preference, "matches", { get: () => reduced });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => preference);
  animate.mockReset().mockImplementation(() => ({ cancel: vi.fn(), finished: new Promise(() => {}) }));
  HTMLElement.prototype.animate = animate;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    const index = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
    const top = index * 80;
    return { top, bottom: top + 80, left: 0, right: 400, width: 400, height: 80, x: 0, y: top, toJSON() {} };
  });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function(this: HTMLElement) { return this.parentElement ? [...this.parentElement.children].indexOf(this) * 80 : 0; });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(80);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.documentElement.removeAttribute("data-layout"); });
const items = (...keys: string[]): MotionItem[] => keys.map(key => ({ key, content: <button>{key}</button> }));
const renderList = (keys: string[], scope = "stream", reason: "initial" | "mutation" | "refresh" | "search" = "mutation") => act(() => root.render(<MotionList scope={scope} items={items(...keys)} reason={reason} />));

it("keeps an open photo ready through metadata refresh and hides it immediately on exit", async () => {
  const photos = () => [{ kind: "image" as const, url: "https://example.com/photo.png", source: "https://example.com/photo.png" }];
  await act(async () => root.render(<Presence><PhotoViewer images={photos()} initial={0} close={() => {}} /></Presence>));
  const original = document.querySelector('.photo-stage img')!;
  act(() => original.dispatchEvent(new Event("load")));
  await act(async () => root.render(<Presence><PhotoViewer images={photos()} initial={0} close={() => {}} /></Presence>));
  expect(document.querySelector('.photo-stage img')).toBe(original); expect(original.getAttribute("data-ready")).toBe("true");
  act(() => root.render(<Presence>{null}</Presence>));
  expect(document.querySelector('.photo-lightbox')?.getAttribute("aria-hidden")).toBe("true");
  act(() => vi.advanceTimersByTime(200)); expect(document.querySelector('.photo-lightbox')).toBeNull();
});

it("recognizes double taps by touch timestamps even when event handling is delayed", async () => {
  await act(async () => root.render(<PhotoViewer images={[{ kind: "image", url: "https://example.com/photo.png", source: "https://example.com/photo.png" }]} initial={0} close={() => {}} />));
  const stage = document.querySelector<HTMLDivElement>(".photo-stage")!;
  const image = document.querySelector<HTMLImageElement>(".photo-stage img")!;
  stage.setPointerCapture = vi.fn();
  Object.defineProperties(stage, { clientWidth: { value: 400 }, clientHeight: { value: 80 } });
  Object.defineProperties(image, { naturalWidth: { value: 600 }, naturalHeight: { value: 800 } });
  const tap = (time: number) => {
    for (const [type, offset] of [["pointerdown", 0], ["pointerup", 40]] as const) {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, { pointerId: { value: 1 }, clientX: { value: 200 }, clientY: { value: 40 }, timeStamp: { value: time + offset } });
      act(() => stage.dispatchEvent(event));
    }
  };
  tap(1000);
  // Queued touches still form a double tap when rendering delays delivery.
  act(() => vi.advanceTimersByTime(500)); tap(1100);
  expect(image.style.transform).toContain("scale(2.5)");
  tap(2000); act(() => vi.advanceTimersByTime(500)); tap(2100);
  expect(image.style.transform).toContain("scale(1)");
  // Touches more than 300ms apart must stay separate even when delivered together.
  tap(3000); tap(3400);
  expect(image.style.transform).toContain("scale(1)");
});

describe("list presence and interrupted updates", () => {
  it("keeps the last departing post in place before showing the empty surface", () => {
    act(() => root.render(<MotionList scope="stream" items={items("last")} empty={<p>Empty library</p>} />));
    act(() => root.render(<MotionList scope="stream" items={[]} empty={<p>Empty library</p>} />));
    expect(host.textContent).toBe("last");
    expect((host.firstElementChild as HTMLElement).style.minHeight).toBe("80px");
    act(() => vi.advanceTimersByTime(200)); expect(host.textContent).toBe("Empty library");
  });
  it("never animates initial data or treats a search/navigation replacement as new posts", () => {
    renderList([], "stream", "initial"); renderList(["a", "b"], "stream", "initial");
    renderList(["c"], "search", "search");
    expect(animate).not.toHaveBeenCalled(); expect(host.textContent).toBe("c");
  });
  it("keeps two deletions inert, restores one exactly once before its exit finishes, and independently removes the other", () => {
    renderList(["a", "b", "c"]); renderList(["c"]);
    expect(host.querySelectorAll('[data-exiting="true"]')).toHaveLength(2);
    expect(host.querySelector('[data-motion-key="a"]')?.getAttribute("inert")).not.toBeNull();
    renderList(["a", "c"]);
    expect(host.querySelectorAll('[data-motion-key="a"]')).toHaveLength(1);
    expect(host.querySelector('[data-motion-key="a"]')?.getAttribute("aria-hidden")).toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(host.textContent).toBe("ac");
  });
  it("preserves local component state through checklist reorder and remote refresh", () => {
    function Stateful({ id }: { id: string }) { const [text] = useState(() => `state:${id}`); return <input aria-label={id} defaultValue={text} />; }
    const rows = (keys: string[]) => keys.map(key => ({ key, content: <Stateful id={key} /> }));
    act(() => root.render(<MotionList scope="checklist" items={rows(["a", "b"])} />));
    const original = host.querySelector('input[aria-label="a"]') as HTMLInputElement; original.value = "unsent local state";
    act(() => root.render(<MotionList scope="checklist" items={rows(["b", "a", "remote"])} reason="refresh" />));
    expect(host.querySelector('input[aria-label="a"]')).toBe(original); expect(original.value).toBe("unsent local state");
    expect(animate).toHaveBeenCalled();
  });
  it("finishes all exits immediately when reduced motion is enabled mid-transition", () => {
    renderList(["a", "b"]); renderList(["b"]);
    act(() => { reduced = true; preference.dispatchEvent(new Event("change")); });
    expect(host.textContent).toBe("b"); expect(host.querySelector('[data-exiting="true"]')).toBeNull();
    renderList(["b", "c"]); expect(host.textContent).toBe("bc");
    expect(animate.mock.results[0].value.cancel).toHaveBeenCalled();
  });
  it("flushes old scope exits without removing the replacement row with the same ID", () => {
    renderList(["a", "b"]); renderList(["b"]); renderList(["a"], "tag-feed");
    act(() => vi.advanceTimersByTime(300)); expect(host.textContent).toBe("a");
  });
});
describe("surfaces and reading position", () => {
  it("does not lose a reopened disclosure to an earlier exit timer", () => {
    const render = (show: boolean) => act(() => root.render(<Presence>{show && <Disclosure><button>Search</button></Disclosure>}</Presence>));
    render(true); render(false); render(true); act(() => vi.advanceTimersByTime(300)); expect(host.textContent).toBe("Search");
  });
  it("waits for the destination and does not replay a page transition for repeated data renders", () => {
    const render = (view: string, ready: boolean) => act(() => root.render(<PageMotion view={view} ready={ready}>Content</PageMotion>));
    render("stream", true); render("gems", false); expect(animate).not.toHaveBeenCalled();
    render("gems", true); render("gems", true); expect(animate).toHaveBeenCalledTimes(1);
  });
  it("cancels a direct animation when the OS changes its preference", () => {
    animateElement(host, [{ opacity: 0 }, { opacity: 1 }]);
    reduced = true; preference.dispatchEvent(new Event("change")); expect(animate.mock.results[0].value.cancel).toHaveBeenCalled();
  });
  it("restores logical reading geometry rather than an animated bounding box", () => {
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    const scroll = vi.fn(); vi.stubGlobal("scrollTo", scroll);
    host.innerHTML = '<article data-entry-id="a"></article><article data-entry-id="b"></article>';
    const anchor = captureReadingAnchor("a"); expect(anchor.id).toBe("b");
    const element = host.lastElementChild as HTMLElement;
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ top: 9000, bottom: 9080 } as DOMRect);
    restoreReadingAnchor(anchor); expect(scroll).toHaveBeenCalledWith(0, anchor.scroll);
  });
  it("keeps custom window controls outside the inert app region", () => {
    act(() => root.render(<DesktopLayout.Provider value><DesktopRuntime.Provider value={{ status: "ready", info: previewDesktopInfo }}><WindowControls report={() => {}} /><div className="app-shell" inert><button>Background</button></div></DesktopRuntime.Provider></DesktopLayout.Provider>));
    expect(host.querySelector('[aria-label="Close window"]')?.closest("[inert]")).toBeNull();
  });
  it("supports anchored menu arrows, Escape and return focus", () => {
    const trigger = document.createElement("button"); document.body.append(trigger);
    const anchor = createRef<HTMLButtonElement>(); anchor.current = trigger;
    const close = vi.fn();
    act(() => root.render(<ActionMenu anchor={anchor} close={close}><button>Edit</button><button>Delete</button></ActionMenu>));
    expect(document.activeElement?.textContent).toBe("Edit");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" })); expect(document.activeElement?.textContent).toBe("Delete");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); expect(close).toHaveBeenCalledOnce();
    act(() => root.render(null)); expect(document.activeElement).toBe(trigger); trigger.remove();
  });
});
