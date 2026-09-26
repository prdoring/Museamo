import { beforeEach, describe, expect, it } from "vitest";
import { bridge, filterEntries, locationLabel, preview, type Entry, type PostLocation } from "./data";

const location: PostLocation = { latitude: 0, longitude: 0, token: "test", capturedAt: 1 };
describe("saved locations", () => {
  beforeEach(async () => { preview.reset(true); await bridge.setLocationEnabled({ enabled: false }); });
  it("an explicit location action works without first visiting Settings", async () => {
    const result = await bridge.currentLocation();
    expect(result.location).not.toBeNull();
  });
  it("falls back through user label, feature, address, locality, then coordinates", () => {
    expect(locationLabel(location)).toBe("Saved location");
    expect(locationLabel({ ...location, locality: "Town" })).toBe("Town");
    expect(locationLabel({ ...location, locality: "Town", address: "10 Main Street" })).toBe("10 Main Street");
    expect(locationLabel({ ...location, address: "10 Main Street", name: "Park" })).toBe("Park");
    expect(locationLabel({ ...location, name: "Park", userLabel: "My spot" })).toBe("My spot");
    expect(locationLabel({ ...location, name: "Park", userLabel: "  " })).toBe("Park");
  });
  it("retains capture coordinates in resumed drafts, updates, and Undo", async () => {
    await bridge.setLocationEnabled({ enabled: true });
    const { draft } = await bridge.getDraft({});
    expect(draft.location).toBeTruthy();
    await bridge.setLocationEnabled({ enabled: false });
    expect((await bridge.getDraft({})).draft.location).toEqual(draft.location);
    const id = preview.save({ ...draft, text: "Remember this" });
    await bridge.updateEntry({ id, text: "Edited", tagIds: [] });
    const entry = (await bridge.getEntry({ id })).entry!;
    expect(entry.location).toEqual(draft.location);
    await bridge.deleteEntry({ id });
    await bridge.restoreEntry({ entry });
    expect((await bridge.getEntry({ id })).entry!.location).toEqual(draft.location);
    await bridge.updateEntry({ id, text: "Edited", tagIds: [], location: null });
    expect((await bridge.queryEntries({ located: true })).entries).toEqual([]);
  });
  it("does not reattach a removed draft location", async () => {
    await bridge.setLocationEnabled({ enabled: true });
    const { draft } = await bridge.getDraft({});
    await bridge.updateDraft({ ...draft, text: "Here", location: null, locationAttempted: true });
    const resumed = (await bridge.getDraft({})).draft;
    expect(resumed.location).toBeNull();
    expect((await bridge.getEntry({ id: preview.save(resumed) })).entry!.location).toBeNull();
  });
  it("filters by name and location without excluding zero coordinates", () => {
    const entry: Entry = { id: "one", text: "Lunch", createdAt: 1, updatedAt: 1, starred: true, tagIds: ["food"], profileId: null, location: { ...location, userLabel: "Cafe", locality: "Town" } };
    expect(filterEntries([entry], { located: true, search: "cafe", starred: true, tagId: "food" })).toEqual([entry]);
    expect(filterEntries([entry], { search: "town" })).toEqual([entry]);
    expect(filterEntries([entry], { tagId: "other" })).toEqual([]);
    expect(filterEntries([{ ...entry, location: null }], { located: true })).toEqual([]);
  });
  it("paginates located posts independently of unlocated posts", async () => {
    for (let i = 0; i < 5; i++) {
      const { draft } = await bridge.getDraft({});
      preview.save({ ...draft, text: `Post ${i}`, location: i % 2 ? null : location });
    }
    const first = await bridge.queryEntries({ located: true, limit: 2 });
    expect(first.entries).toHaveLength(2); expect(first.hasMore).toBe(true);
    const last = first.entries.at(-1)!;
    const next = await bridge.queryEntries({ located: true, limit: 2, beforeTime: last.createdAt, beforeId: last.id });
    expect(next.entries).toHaveLength(1); expect(next.hasMore).toBe(false);
    expect(new Set([...first.entries, ...next.entries].map(e => e.id)).size).toBe(3);
  });
});
