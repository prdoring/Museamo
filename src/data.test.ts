import { describe, expect, it } from 'vitest';
import { filterEntries, type Entry } from './data';
const entries: Entry[] = [
  { id: 'a', text: 'Apricity means winter sunlight', createdAt: 1, updatedAt: 1, starred: true, completed: false, tagIds: ['words', 'thoughts'], profileId: null },
  { id: 'b', text: 'An untagged thought', createdAt: 2, updatedAt: 2, starred: false, completed: false, tagIds: [], profileId: null },
];
describe('collection filters', () => {
  it('combines text, star and tag filters without duplicating multi-tag entries', () => {
    expect(filterEntries(entries, { search: 'WINTER', starred: true, tagId: 'words' }).map(e => e.id)).toEqual(['a']);
    expect(filterEntries(entries, { search: 'WINTER', tagId: 'missing' })).toEqual([]);
  });
  it('keeps untagged entries in the full stream', () => { expect(filterEntries(entries, {})).toHaveLength(2); });
});
