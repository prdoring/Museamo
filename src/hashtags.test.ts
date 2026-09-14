import { describe, expect, it, beforeEach } from "vitest";
import fixtures from "../test-fixtures/hashtags.json";
import {
  hashtags,
  activeHashtag,
  hashtagText,
  removeHashtag,
} from "./hashtags";
import { bridge, preview } from "./data";

describe("shared hashtag contract", () => {
  for (const fixture of fixtures)
    it(fixture.text, () =>
      expect([
        ...new Map(
          hashtags(fixture.text).map((h) => [h.name.toLowerCase(), h.name]),
        ).keys(),
      ]).toEqual(fixture.names.map((n) => n.toLowerCase())),
    );
  it("completes a token at its cursor and keeps quoted names", () => {
    expect(activeHashtag("Hello #words later", 9)).toEqual({
      start: 6,
      end: 12,
      query: "wo",
    });
    expect(hashtagText("Cool words")).toBe('#"Cool words"');
    expect(removeHashtag('Hello #"Cool words" #fresh', "cool words")).toBe(
      "Hello  #fresh",
    );
  });
  it("does not truncate oversized tags", () =>
    expect(hashtags("#" + "a".repeat(81))).toEqual([]));
});
describe("interactive preview persistence contract", () => {
  beforeEach(() => preview.reset());
  it("preserves failed drafts and retries once without duplicating", async () => {
    const { draft } = await bridge.getDraft({});
    draft.text = "Hello #newtag";
    await bridge.updateDraft(draft);
    preview.failNext();
    expect(() => preview.save(draft)).toThrow();
    expect((await bridge.getDraft({})).draft.text).toBe(draft.text);
    const id = preview.save(draft);
    expect(preview.save(draft)).toBe(id);
    expect(
      (await bridge.queryEntries({ search: "Hello" })).entries,
    ).toHaveLength(1);
    expect(
      (await bridge.library()).tags.filter((t) => t.name === "newtag"),
    ).toHaveLength(1);
    expect((await bridge.getDraft({})).draft.entryId).not.toBe(id);
  });
  it("keeps drafts independent and retains their actual tags", async () => {
    const a = (await bridge.getDraft({ tagId: "words" })).draft;
    const b = (await bridge.getDraft({})).draft;
    a.text = "One";
    a.tagIds = ["thoughts"];
    await bridge.updateDraft(a);
    b.text = "Two";
    await bridge.updateDraft(b);
    expect((await bridge.getDraft({ tagId: "words" })).draft.tagIds).toEqual([
      "thoughts",
    ]);
    expect((await bridge.getDraft({})).draft.text).toBe("Two");
  });
  it("pages without duplicating entries after a new save", async () => {
    preview.stress();
    const first = await bridge.queryEntries({ limit: 20 });
    const last = first.entries.at(-1)!;
    preview.save({ ...(await bridge.getDraft({})).draft, text: "Newest" });
    const next = await bridge.queryEntries({
      limit: 20,
      beforeTime: last.createdAt,
      beforeId: last.id,
    });
    expect(next.entries).toHaveLength(20);
    expect(
      next.entries.some((e) => first.entries.some((f) => f.id === e.id)),
    ).toBe(false);
  });
  it("restores consecutive deletions independently and computes tag counts", async () => {
    const original = (await bridge.queryEntries({})).entries.slice(0, 2);
    for (const e of original) await bridge.deleteEntry({ id: e.id });
    for (const e of original) await bridge.restoreEntry({ entry: e });
    const all = (await bridge.queryEntries({})).entries;
    expect(all).toHaveLength(4);
    expect(
      (await bridge.library()).tags.find((t) => t.id === "words")?.count,
    ).toBe(1);
  });
  it("does not recreate a renamed tag when editing historical inline text", async () => {
    const entry = (await bridge.queryEntries({ tagId: "words" })).entries[0];
    await bridge.saveTag({ id: "words", name: "Vocabulary" });
    await bridge.updateEntry({
      id: entry.id,
      text: entry.text + " A useful word.",
      tagIds: ["words"],
    });
    expect(
      (await bridge.library()).tags.some((t) => t.name === "Cool words"),
    ).toBe(false);
    expect((await bridge.getEntry({ id: entry.id })).entry?.tagIds).toEqual([
      "words",
    ]);
  });
});
