import type { Entry } from "./data";

/** Changes to existing thoughts should refresh in place without an arrival banner. */
export function hasNewThoughtsAhead(previous: Entry[], current: Entry[]): boolean {
  const first = previous[0];
  return !!first && current.some(entry => entry.createdAt > first.createdAt ||
    (entry.createdAt === first.createdAt && entry.id > first.id));
}
