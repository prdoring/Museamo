import { afterEach, describe, expect, it, vi } from "vitest";
import { lockOverlay } from "./components/Motion";

afterEach(() => vi.unstubAllGlobals());

describe("overlapping overlay focus and scroll locks", () => {
  function page(inert = false, overflow = "auto") {
    const shell = { inert };
    const trigger = { isConnected: true, focus: vi.fn() };
    const body = { style: { overflow } };
    vi.stubGlobal("document", { body, activeElement: trigger, querySelector: () => shell });
    return { shell, trigger, body };
  }

  it("keeps the background locked while an outgoing sheet overlaps the editor", () => {
    const { shell, trigger, body } = page();
    const closeMenu = lockOverlay();
    const closeEditor = lockOverlay();
    closeMenu();
    expect(shell.inert).toBe(true);
    expect(body.style.overflow).toBe("hidden");
    expect(trigger.focus).not.toHaveBeenCalled();
    closeEditor();
    expect(shell.inert).toBe(false);
    expect(body.style.overflow).toBe("auto");
    expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("preserves prior locks when overlays finish in reverse order", () => {
    const { shell, body } = page(true, "clip");
    const first = lockOverlay(), second = lockOverlay();
    second();
    expect(body.style.overflow).toBe("hidden");
    first();
    expect(shell.inert).toBe(true);
    expect(body.style.overflow).toBe("clip");
  });

  it("does not try to focus a deleted post after its menu closes", () => {
    const { trigger, shell } = page();
    const close = lockOverlay();
    trigger.isConnected = false;
    close();
    expect(trigger.focus).not.toHaveBeenCalled();
    expect(shell.inert).toBe(false);
  });
});
