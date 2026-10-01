import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { bridge, compareEntries, isChecklistEntry, preview, type Entry, type Tag } from "./data";
import { ChecklistToggle } from "./components/Checklist";
import { TagList } from "./components/LibraryViews";
import { Post } from "./components/Thoughts";
import { Feed } from "./components/Feed";

async function tag(name: string, type: Tag["type"] = "standard") {
  await bridge.saveTag({ name, type });
  return (await bridge.library()).tags.find(t => t.name === name)!;
}
async function post(tags: Tag[], text = "**Buy peaches**") {
  const { draft } = await bridge.getDraft({});
  const id = preview.save({ ...draft, text, tagIds: tags.map(t => t.id) });
  return (await bridge.getEntry({ id })).entry!;
}
beforeEach(async () => { preview.reset(true); await bridge.setLocationEnabled({ enabled: false }); });

describe("checklist categories", () => {
  it("defaults new and inline tags to Standard and preserves type on rename", async () => {
    const ordinary = await tag("Ideas");
    expect(ordinary.type).toBe("standard");
    const checklist = await tag("Errands", "checklist");
    await bridge.saveTag({ id: checklist.id, name: "Weekend" });
    await post([], "A new #project");
    const library = await bridge.library();
    expect(library.tags.find(t => t.id === checklist.id)?.type).toBe("checklist");
    expect(library.tags.find(t => t.name === "project")?.type).toBe("standard");
  });
  it("makes existing entries checkable and shares one state across their tags", async () => {
    const errands = await tag("Errands"), groceries = await tag("Groceries", "checklist");
    const entry = await post([errands]);
    expect(isChecklistEntry(entry, (await bridge.library()).tags)).toBe(false);
    await expect(bridge.setCompleted({ id: entry.id, completed: true })).rejects.toThrow("Checklist category");
    await bridge.saveTag({ id: errands.id, name: errands.name, type: "checklist" });
    await bridge.updateEntry({ id: entry.id, text: entry.text, tagIds: [errands.id, groceries.id] });
    const before = (await bridge.getEntry({ id: entry.id })).entry!;
    await bridge.setCompleted({ id: entry.id, completed: true });
    for (const t of [errands, groceries]) {
      const saved = (await bridge.queryEntries({ tagId: t.id, order: "checklist" })).entries[0];
      expect(saved.completed).toBe(true);
      expect(saved.updatedAt).toBe(before.updatedAt);
      expect(saved.text).toBe(before.text);
    }
    await bridge.setCompleted({ id: entry.id, completed: false });
    expect((await bridge.getEntry({ id: entry.id })).entry?.completed).toBe(false);
  });
  it("remembers completion after type changes, tag removal, edits, and Undo", async () => {
    const checklist = await tag("Tasks", "checklist");
    const entry = await post([checklist]);
    await bridge.setCompleted({ id: entry.id, completed: true });
    await bridge.saveTag({ id: checklist.id, name: checklist.name, type: "standard" });
    let saved = (await bridge.getEntry({ id: entry.id })).entry!;
    expect(saved.completed).toBe(true);
    expect(isChecklistEntry(saved, (await bridge.library()).tags)).toBe(false);
    await bridge.updateEntry({ id: entry.id, text: "Updated", tagIds: [] });
    await bridge.saveTag({ id: checklist.id, name: checklist.name, type: "checklist" });
    await bridge.updateEntry({ id: entry.id, text: "Updated", tagIds: [checklist.id] });
    saved = (await bridge.getEntry({ id: entry.id })).entry!;
    expect(saved.completed).toBe(true);
    expect(isChecklistEntry(saved, (await bridge.library()).tags)).toBe(true);
    await bridge.deleteEntry({ id: entry.id });
    await bridge.restoreEntry({ entry: saved });
    expect((await bridge.getEntry({ id: entry.id })).entry).toEqual(saved);
    await bridge.deleteTag({ id: checklist.id });
    expect((await bridge.getEntry({ id: entry.id })).entry?.completed).toBe(true);
  });
  it("fails without modifying saved completion and can retry", async () => {
    const entry = await post([await tag("Tasks", "checklist")]);
    preview.failNext();
    await expect(bridge.setCompleted({ id: entry.id, completed: true })).rejects.toThrow("Preview save failed");
    expect((await bridge.getEntry({ id: entry.id })).entry?.completed).toBe(false);
    await bridge.setCompleted({ id: entry.id, completed: true });
    expect((await bridge.getEntry({ id: entry.id })).entry?.completed).toBe(true);
    await expect(bridge.saveTag({ name: "Invalid", type: "unknown" as Tag["type"] })).rejects.toThrow("category type");
  });
});

describe("checklist pagination", () => {
  async function collection() {
    const checklist = await tag("Tasks", "checklist");
    const rows: Entry[] = [];
    for (let i = 0; i < 137; i++) {
      const entry: Entry = { id: `entry-${String(i).padStart(3, "0")}`, text: i % 3 ? "Buy peaches" : "Read a book", createdAt: Math.floor(i / 3), updatedAt: 1, tagIds: [checklist.id], profileId: null, completed: i % 2 === 0, starred: i % 5 === 0 };
      await bridge.restoreEntry({ entry }); rows.push(entry);
    }
    return { checklist, rows };
  }
  it("pages across both groups and tied timestamps without skips or duplicates", async () => {
    const { checklist, rows } = await collection();
    const all: Entry[] = [];
    let last: Entry | undefined;
    do {
      const page = await bridge.queryEntries({ tagId: checklist.id, order: "checklist", limit: 50, beforeTime: last?.createdAt, beforeId: last?.id, beforeCompleted: last?.completed });
      all.push(...page.entries);
      if (!page.hasMore) break;
      last = page.entries.at(-1);
    } while (all.length < 200);
    expect(all).toEqual([...rows].sort((a, b) => compareEntries(a, b, true)));
    expect(new Set(all.map(e => e.id)).size).toBe(rows.length);
    const filtered = await bridge.queryEntries({ tagId: checklist.id, order: "checklist", search: "PEACHES", starred: true, limit: 200 });
    expect(filtered.entries).toEqual(all.filter(e => e.starred && e.text.includes("peaches")));
    expect((await bridge.queryEntries({ tagId: checklist.id, limit: 200 })).entries).toEqual([...rows].sort((a, b) => compareEntries(a, b)));
  });
  it("rebuilds a loaded prefix after moving a boundary entry, then continues correctly", async () => {
    const { checklist, rows } = await collection();
    const loaded = await bridge.queryEntries({ tagId: checklist.id, order: "checklist", limit: 100 });
    const moved = loaded.entries.at(-1)!;
    await bridge.setCompleted({ id: moved.id, completed: !moved.completed });
    const refreshed = await bridge.queryEntries({ tagId: checklist.id, order: "checklist", limit: 100 });
    const last = refreshed.entries.at(-1)!;
    const rest = await bridge.queryEntries({ tagId: checklist.id, order: "checklist", limit: 50, beforeTime: last.createdAt, beforeId: last.id, beforeCompleted: last.completed });
    const expected = rows.map(e => e.id === moved.id ? { ...e, completed: !e.completed } : e).sort((a, b) => compareEntries(a, b, true));
    expect([...refreshed.entries, ...rest.entries]).toEqual(expected);
    await expect(bridge.queryEntries({ tagId: checklist.id, order: "checklist", beforeTime: last.createdAt, beforeId: last.id })).rejects.toThrow("Reload");
  });
});

it("filters the whole Stream across Checklist tags before pagination, without duplicating shared items", async () => {
  const first = await tag("Errands", "checklist"), second = await tag("Groceries", "checklist"), notes = await tag("Notes");
  const rows: Entry[] = [];
  for (let i = 0; i < 137; i++) {
    const entry: Entry = { id: `stream-${String(i).padStart(3, "0")}`, text: i % 3 ? "Peaches" : "Read", createdAt: Math.floor(i / 3), updatedAt: 1, completed: i % 2 === 0, starred: i % 5 === 0, tagIds: [[notes.id], [first.id], [second.id], [first.id, second.id, notes.id]][i % 4], profileId: null };
    await bridge.restoreEntry({ entry }); rows.push(entry);
  }
  const expected = rows.filter(e => e.tagIds.includes(first.id) || e.tagIds.includes(second.id)).sort((a, b) => compareEntries(a, b));
  const all: Entry[] = [];
  let last: Entry | undefined;
  do {
    const page = await bridge.queryEntries({ checklistOnly: true, limit: 50, beforeTime: last?.createdAt, beforeId: last?.id });
    all.push(...page.entries);
    if (!page.hasMore) break;
    last = page.entries.at(-1);
  } while (all.length < 200);
  expect(all).toEqual(expected);
  expect(new Set(all.map(e => e.id)).size).toBe(expected.length);
  expect(all.some(e => e.completed)).toBe(true);
  expect((await bridge.queryEntries({ checklistOnly: true, search: "PEACHES", starred: true, tagId: second.id, limit: 200 })).entries).toEqual(expected.filter(e => e.text === "Peaches" && e.starred && e.tagIds.includes(second.id)));
  expect((await bridge.queryEntries({ checklistOnly: true, limit: 50, offset: 50 })).entries).toEqual(expected.slice(50, 100));
  expect((await bridge.queryEntries({ limit: 200 })).entries).toHaveLength(137);
  await bridge.saveTag({ id: first.id, name: first.name, type: "standard" });
  expect((await bridge.queryEntries({ checklistOnly: true, limit: 200 })).entries).toEqual(expected.filter(e => e.tagIds.includes(second.id)));
  await bridge.deleteTag({ id: second.id });
  expect((await bridge.queryEntries({ checklistOnly: true })).entries).toEqual([]);
  expect((await bridge.queryEntries({ limit: 200 })).entries).toHaveLength(137);
});

it("labels checklist categories and exposes checked, busy, and attachment-only states accessibly", async () => {
  const checklist = await tag("Shopping", "checklist");
  expect(renderToStaticMarkup(<TagList tags={[checklist]} query="" open={() => {}} edit={() => {}} />)).toContain("Checklist");
  const entry = { ...(await post([checklist])), text: "", completed: true };
  const html = renderToStaticMarkup(<ChecklistToggle entry={entry} pending change={() => {}} />);
  expect(html).toContain('role="checkbox"'); expect(html).toContain('aria-checked="true"');
  expect(html).toContain('aria-busy="true"'); expect(html).toContain('disabled=""');
  expect(html).toContain("Photo/video post");
});

it("keeps attachments outside crossed-out text and hides checklist presentation for Standard tags", async () => {
  const checklist = await tag("Photos", "checklist");
  const entry: Entry = { ...(await post([checklist])), text: "", completed: true, attachments: [{ id: "photo", kind: "image", mimeType: "image/png", filename: "peaches.png", byteSize: 68, width: 1, height: 1 }] };
  const render = (tags: Tag[]) => renderToStaticMarkup(<Post entry={entry} tags={tags} complete={() => {}} completionPending={false} star={() => {}} edit={() => {}} remove={() => {}} openTag={() => {}} report={() => {}} />);
  const html = render([checklist]);
  expect(html).toContain('aria-checked="true"');
  expect(html).toContain('aria-label="Checklist item: Photo/video post"');
  expect(html).toContain('class="media-grid"');
  expect(html.indexOf('class="media-grid"')).toBeGreaterThan(html.indexOf('checklist-completed'));
  const ordinary = render([{ ...checklist, type: "standard" }]);
  expect(ordinary).not.toContain('role="checkbox"'); expect(ordinary).not.toContain('checklist-completed');
  expect(ordinary).toContain('class="media-grid"');
});

it("uses compact rows only inside checklist categories and preserves other tag links", async () => {
  const checklist = await tag("Errands", "checklist"), other = await tag("Weekend");
  const entry = await post([checklist, other]);
  const render = (categoryId?: string) => renderToStaticMarkup(<Post entry={entry} tags={[checklist, other]} checklistCategoryId={categoryId} complete={() => {}} completionPending={false} star={() => {}} edit={() => {}} remove={() => {}} openTag={() => {}} report={() => {}} />);
  const compact = render(checklist.id);
  expect(compact).toContain("post-compact");
  expect(compact).not.toContain('class="post-top"');
  expect(compact).not.toContain("# Errands");
  expect(compact).toContain("# Weekend");
  expect(compact).toContain('aria-label="Thought actions"');
  const stream = render();
  expect(stream).not.toContain("post-compact");
  expect(stream).toContain('class="post-top"');
  expect(stream).toContain("# Errands");
  expect(stream).toContain('role="checkbox"');
});

it("retains both completion groups and date dividers in compact category feeds", async () => {
  const checklist = await tag("Errands", "checklist");
  const original = await post([checklist]);
  const today = new Date(2026, 8, 28, 12).getTime();
  const entries = [
    { ...original, id: "new", createdAt: today },
    { ...original, id: "old", createdAt: today - 86400000 },
    { ...original, id: "done", createdAt: today, completed: true },
  ];
  const html = renderToStaticMarkup(<Feed entries={entries} tags={[checklist]} checklist categoryId={checklist.id} complete={() => {}} pendingCompletions={new Set()} loading={false} more newThoughts={false} query="" gems={false} reload={() => {}} older={() => {}} star={() => {}} edit={() => {}} remove={() => {}} openTag={() => {}} report={() => {}} openLocation={() => {}} />);
  expect(html.match(/class="day-divider"/g)).toHaveLength(3);
  expect(html).toContain('class="checklist-section">Unchecked');
  expect(html).toContain('class="checklist-section">Checked');
  expect(html.match(/post-compact/g)).toHaveLength(3);
  expect(html).toContain("Load more thoughts");
});
