import { describe, expect, it } from "vitest";
import { desktopCloseDescription, desktopShortcut, previewDesktopInfo, readNativeDesktopInfo, shortcutModifier } from "./platform";
import type { DesktopInfo } from "./sync";

const windows: DesktopInfo = { os: "windows", startupSupported: true, windowControls: "custom", closeBehavior: "background" };
const macos: DesktopInfo = { os: "macos", startupSupported: true, windowControls: "native", closeBehavior: "background" };
const linux: DesktopInfo = { os: "linux", startupSupported: true, windowControls: "custom", closeBehavior: "quit" };
const key = (changes: Partial<Parameters<typeof desktopShortcut>[0]> = {}) => ({ key: "n", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, ...changes });

describe("native desktop capabilities", () => {
  it("accepts the runtime's close behavior instead of assuming Windows always has a tray", () => {
    expect(readNativeDesktopInfo({ ...windows, closeBehavior: "quit" })).toEqual({ ...windows, closeBehavior: "quit" });
  });
  it.each([null, {}, previewDesktopInfo, { ...macos, startupSupported: "true" }, { ...linux, closeBehavior: "hide" }, { ...windows, windowControls: "unknown" }])("rejects incompatible native information %j", value => {
    expect(() => readNativeDesktopInfo(value)).toThrow();
  });
  it("describes the available reopen and quit paths", () => {
    expect(desktopCloseDescription(macos)).toContain("Dock");
    expect(desktopCloseDescription(macos)).toContain("Command+Q");
    expect(desktopCloseDescription(windows)).toContain("tray menu");
    expect(desktopCloseDescription(linux)).toContain("quits Museamo and stops syncing");
    expect(desktopCloseDescription({ ...windows, closeBehavior: "quit" })).not.toContain("tray");
  });
});

describe("desktop shortcuts", () => {
  it("uses Command on macOS and Ctrl on Windows and Linux", () => {
    expect(desktopShortcut(key({ metaKey: true }), macos)).toBe("compose");
    expect(desktopShortcut(key({ ctrlKey: true }), macos)).toBeUndefined();
    expect(desktopShortcut(key({ key: "f", ctrlKey: true }), windows)).toBe("search");
    expect(desktopShortcut(key({ ctrlKey: true }), linux)).toBe("compose");
    expect(desktopShortcut(key({ metaKey: true }), linux)).toBeUndefined();
  });
  it.each([{ altKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }, { ctrlKey: true }])("does not consume modified or already handled Command combinations %j", changes => {
    expect(desktopShortcut(key({ metaKey: true, ...changes }), macos)).toBeUndefined();
  });
  it("keeps preview identity while using the browser host's familiar modifier", () => {
    expect(shortcutModifier(previewDesktopInfo, "MacIntel")).toBe("Command");
    expect(shortcutModifier(previewDesktopInfo, "Win32")).toBe("Ctrl");
    expect(desktopShortcut(key({ metaKey: true }), previewDesktopInfo, "MacIntel")).toBe("compose");
    expect(previewDesktopInfo.os).toBe("preview");
  });
});
