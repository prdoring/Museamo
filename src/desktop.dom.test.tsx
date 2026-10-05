// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { DesktopRuntime, WindowControls } from "./components/Desktop";
import { Settings } from "./components/Settings";
import type { DesktopInfo } from "./sync";
import { previewDesktopInfo, type DesktopRuntimeState } from "./platform";

const fake = vi.hoisted(() => ({
  desktopInfo: vi.fn(), startup: vi.fn(), setStartup: vi.fn(), close: vi.fn(),
  currentWindow: vi.fn(),
}));
vi.mock("./platform", async importOriginal => ({ ...(await importOriginal<typeof import("./platform")>()), platform: "desktop", isDesktop: true, isPreview: false, capabilities: (await importOriginal<typeof import("./platform")>()).platformCapabilities("desktop") }));
vi.mock("./data", async importOriginal => ({ ...(await importOriginal<typeof import("./data")>()), isNative: true,
  bridge: {
    getDesktopInfo: fake.desktopInfo,
    getStartupSettings: fake.startup,
    setStartupEnabled: fake.setStartup,
    library: async () => ({ tags: [], profiles: [] }),
    queryEntries: async () => ({ entries: [], hasMore: false }),
    addListener: async () => ({ remove: async () => {} }),
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: fake.currentWindow }));
vi.mock("./components/Devices", () => ({ Devices: () => null }));
vi.mock("./components/Recovery", () => ({ Recovery: () => null }));
vi.mock("./components/LocationMap", () => ({ LocationMap: () => null }));
vi.mock("./components/Feed", () => ({ Feed: () => null }));

const macos: DesktopInfo = { os: "macos", startupSupported: true, windowControls: "native", closeBehavior: "background" };
const linux: DesktopInfo = { os: "linux", startupSupported: true, windowControls: "custom", closeBehavior: "quit" };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  fake.desktopInfo.mockReset().mockResolvedValue(macos);
  fake.startup.mockReset().mockResolvedValue({ enabled: false });
  fake.setStartup.mockReset().mockResolvedValue({ enabled: true });
  fake.close.mockReset().mockResolvedValue(undefined);
  fake.currentWindow.mockReset().mockReturnValue({
    isMaximized: async () => false, isFocused: async () => true,
    onResized: async () => () => {}, onFocusChanged: async () => () => {},
    close: fake.close,
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  delete document.documentElement.dataset.layout;
  delete document.documentElement.dataset.windowControls;
});
const render = async (content: React.ReactNode) => { await act(async () => root.render(content)); };
const runtime = (info: DesktopInfo): DesktopRuntimeState => ({ status: "ready", info });
const settings = (state: DesktopRuntimeState) => <DesktopRuntime.Provider value={state}><Settings library={{ tags: [], profiles: [] }} report={() => {}} run={async fn => { await fn(); }} refresh={() => {}} /></DesktopRuntime.Provider>;

it("loads native capabilities once under StrictMode and shares them with controls and settings", async () => {
  await render(<StrictMode><App /></StrictMode>);
  expect(fake.desktopInfo).toHaveBeenCalledTimes(1);
  expect(host.querySelector(".window-controls")).toBeNull();
  expect(document.documentElement.dataset.windowControls).toBe("native");
  const openSettings = host.querySelector<HTMLButtonElement>(".desktop-settings")!;
  await act(async () => openSettings.click());
  expect(host.querySelector(".settings")?.textContent).toContain("macOS");
  expect(host.querySelector(".settings")?.textContent).toContain("Dock");
  expect(fake.desktopInfo).toHaveBeenCalledTimes(1);
});

it("shows a native capability failure and recovers through an explicit retry without showing preview state", async () => {
  fake.desktopInfo.mockRejectedValueOnce(new Error("Native information unavailable")).mockResolvedValueOnce(linux);
  await render(<App />);
  expect(host.textContent).toContain("Desktop options are unavailable");
  expect(host.textContent).not.toContain("Desktop preview");
  expect(host.querySelector(".window-controls")).toBeNull();
  const retry = [...host.querySelectorAll("button")].find(button => button.textContent === "Retry desktop options")!;
  await act(async () => retry.click());
  expect(fake.desktopInfo).toHaveBeenCalledTimes(2);
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Close window"]')?.title).toBe("Quit Museamo");
  expect(document.documentElement.dataset.windowControls).toBe("custom");
});

it("keeps native chrome hidden and sends custom close actions to the current window", async () => {
  await render(<DesktopRuntime.Provider value={runtime(macos)}><WindowControls report={() => {}} /></DesktopRuntime.Provider>);
  expect(fake.currentWindow).not.toHaveBeenCalled();
  await render(<DesktopRuntime.Provider value={runtime(linux)}><WindowControls report={() => {}} /></DesktopRuntime.Provider>);
  const close = host.querySelector<HTMLButtonElement>('[aria-label="Close window"]')!;
  expect(close.title).toBe("Quit Museamo");
  await act(async () => close.click());
  expect(fake.close).toHaveBeenCalledOnce();
});

it("keeps preview controls disabled without opening a native window handle", async () => {
  await render(<DesktopRuntime.Provider value={runtime(previewDesktopInfo)}><WindowControls report={() => {}} /></DesktopRuntime.Provider>);
  expect(fake.currentWindow).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Close window"]')?.disabled).toBe(true);
});

it("does not query or expose startup actions when the runtime disables startup", async () => {
  await render(settings(runtime({ ...linux, startupSupported: false })));
  expect(fake.startup).not.toHaveBeenCalled();
  expect(host.querySelector(".startup-setting")).toBeNull();
  expect(host.textContent).toContain("Starting at sign-in is unavailable");
  expect(host.textContent).toContain("quits Museamo and stops syncing");
});

it("keeps startup actions disabled after a read failure and allows a fresh read", async () => {
  fake.startup.mockRejectedValueOnce(new Error("Not accessible")).mockResolvedValueOnce({ enabled: true });
  await render(settings(runtime(linux)));
  const checkbox = host.querySelector<HTMLInputElement>(".startup-setting input")!;
  expect(checkbox.disabled).toBe(true);
  const retry = [...host.querySelectorAll("button")].find(button => button.textContent === "Retry sign-in settings")!;
  await act(async () => retry.click());
  expect(fake.startup).toHaveBeenCalledTimes(2);
  expect(checkbox.disabled).toBe(false);
  expect(checkbox.checked).toBe(true);
});
