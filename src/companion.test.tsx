import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { desktopBridge } from "./desktop";
import { TagList } from "./components/LibraryViews";
import type { Tag } from "./data";

afterEach(() => vi.unstubAllGlobals());
describe("native companion boundary", () => {
  it("keeps native stale-revision errors actionable instead of returning preview content", async () => {
    const invoke = vi.fn().mockRejectedValue({ code: "STALE_REVISION", message: "This thought changed on another device." });
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
    await expect(desktopBridge().updateEntry({ id: "thought", baseRevision: "old", text: "unsaved", tagIds: [] })).rejects.toMatchObject({ code: "STALE_REVISION" });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("library_command", { method: "updateEntry", input: { id: "thought", baseRevision: "old", text: "unsaved", tagIds: [] } }, undefined);
  });
  it("preserves pending-original status so a missing file is not reported as a deleted attachment", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: vi.fn().mockResolvedValue({ url: "", availability: "pending" }) } });
    expect(await desktopBridge().resolveMedia({ id: "original" })).toEqual({ url: "", availability: "pending" });
  });
  it("never hides native storage failures behind ephemeral example data", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: vi.fn().mockRejectedValue({ code: "STORAGE", message: "Could not open the library." }) } });
    await expect(desktopBridge().library()).rejects.toMatchObject({ code: "STORAGE", message: "Could not open the library." });
  });
});
describe("concurrent tag rename presentation", () => {
  it("keeps all colliding IDs selectable and distinguishes both types and same-type copies", () => {
    const tags: Tag[] = [
      { id: "aaaaaaaa-1", name: "Tasks", type: "standard" },
      { id: "bbbbbbbb-2", name: "tasks", type: "standard" },
      { id: "cccccccc-3", name: "TASKS", type: "checklist" },
    ];
    const html = renderToStaticMarkup(<TagList tags={tags} query="" open={() => {}} edit={() => {}} />);
    expect(html).toContain("Tasks · Standard · aaaaaaaa");
    expect(html).toContain("tasks · Standard · bbbbbbbb");
    expect(html).toContain("TASKS · Checklist");
    expect((html.match(/class="tag-row"/g) || [])).toHaveLength(3);
  });
  it("uses the shared native normalization for contextual Unicode case differences", () => {
    const tags: Tag[] = [{ id: "aaaaaaaa-1", name: "ΟΣ", normalizedName: "οσ", type: "standard" }, { id: "bbbbbbbb-2", name: "οσ", normalizedName: "οσ", type: "standard" }];
    const html = renderToStaticMarkup(<TagList tags={tags} query="" open={() => {}} edit={() => {}} />);
    expect(html).toContain("ΟΣ · Standard · aaaaaaaa");
    expect(html).toContain("οσ · Standard · bbbbbbbb");
  });
});
