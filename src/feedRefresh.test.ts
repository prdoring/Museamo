import { describe, expect, it } from "vitest";
import type { Entry } from "./data";
import { hasNewThoughtsAhead } from "./feedRefresh";

const thought = (id: string, createdAt: number): Entry => ({
  id, createdAt, updatedAt: createdAt, text: id, tagIds: [], starred: false,
  completed: false, profileId: null,
});
const newest = thought("b", 20), oldest = thought("a", 10);

describe("remote feed refresh arrivals", () => {
  it("does not label deletions or edits as new thoughts", () => {
    expect(hasNewThoughtsAhead([newest, oldest], [oldest])).toBe(false);
    expect(hasNewThoughtsAhead([newest, oldest], [{ ...newest, text: "Updated", updatedAt: 100 }, oldest])).toBe(false);
    expect(hasNewThoughtsAhead([newest], [])).toBe(false);
  });
  it("finds genuinely newer thoughts, including the stable ordering tie-breaker", () => {
    expect(hasNewThoughtsAhead([newest, oldest], [thought("c", 21), newest, oldest])).toBe(true);
    expect(hasNewThoughtsAhead([newest, oldest], [thought("c", 20), newest, oldest])).toBe(true);
    expect(hasNewThoughtsAhead([newest, oldest], [newest, thought("c", 10), oldest])).toBe(false);
  });
  it("does not show an arrival banner for the initial library load", () => {
    expect(hasNewThoughtsAhead([], [newest, oldest])).toBe(false);
  });
});
