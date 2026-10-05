import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ platform: "web", plugin: { library: vi.fn() }, register: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => native.platform, isNativePlatform: () => ["ios", "android"].includes(native.platform) },
  registerPlugin: native.register,
}));
beforeEach(() => { vi.resetModules(); native.platform = "web"; native.register.mockReset().mockReturnValue(native.plugin); native.plugin.library.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe("platform boundaries", () => {
  it("recognizes each host explicitly and gives native hosts precedence", async () => {
    const { detectPlatform } = await import("./platform");
    expect(detectPlatform("ios", true)).toBe("ios");
    expect(detectPlatform("android", true)).toBe("android");
    expect(detectPlatform("web", true)).toBe("desktop");
    expect(detectPlatform("web", false)).toBe("preview");
  });
  it("routes iOS to its native library and preserves storage failures", async () => {
    native.platform = "ios";
    const { bridge, isNative } = await import("./data");
    expect(isNative).toBe(true);
    expect(bridge).toBe(native.plugin);
    expect(native.register).toHaveBeenCalledExactlyOnceWith("Museamo");
    native.plugin.library.mockRejectedValue(new Error("Could not open the iOS library."));
    await expect(bridge.library()).rejects.toThrow("Could not open the iOS library.");
  });
  it("keeps Android on the native plugin and browser examples in preview", async () => {
    native.platform = "android";
    expect((await import("./data")).bridge).toBe(native.plugin);
    vi.resetModules(); native.platform = "web"; native.register.mockClear();
    expect((await import("./data")).bridge).not.toBe(native.plugin);
    expect(native.register).not.toHaveBeenCalled();
  });
  it("exposes only implemented iOS capabilities while retaining existing hosts", async () => {
    const { platformCapabilities } = await import("./platform");
    expect(platformCapabilities("ios")).toEqual({ nativeCapture: false, widgets: false, automaticLocation: false, location: false, media: false, backups: false, sync: false, sharing: false, recovery: true });
    expect(platformCapabilities("android")).toEqual({ nativeCapture: true, widgets: true, automaticLocation: true, location: true, media: true, backups: true, sync: true, sharing: true, recovery: true });
    expect(platformCapabilities("desktop")).toMatchObject({ nativeCapture: false, widgets: false, automaticLocation: false, location: true, media: true, backups: true, sync: true, sharing: true });
    expect(platformCapabilities("preview")).toMatchObject({ sync: false, sharing: true, media: true, automaticLocation: true });
  });
});
