import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
export interface Tag { id: string; name: string }
export interface Entry { id: string; text: string; createdAt: number; updatedAt: number; starred: boolean; tagIds: string[]; profileId: string | null }
export interface Profile { id: string; label: string; mode: 'fixed' | 'picker'; tagIds: string[]; selectedTagId: string | null }
export interface Draft { profileKey: string; entryId: string; text: string; tagIds: string[]; profileId: string | null }
export interface EntryQuery { search?: string; starred?: boolean; tagId?: string; offset?: number; limit?: number }
export interface Library { tags: Tag[]; profiles: Profile[] }
export interface MuseamoBridge {
  queryEntries(query: EntryQuery): Promise<{ entries: Entry[]; hasMore: boolean }>;
  library(): Promise<Library>;
  updateEntry(input: { id: string; text: string; tagIds: string[] }): Promise<void>;
  setStar(input: { id: string; starred: boolean }): Promise<void>;
  deleteEntry(input: { id: string }): Promise<void>;
  restoreEntry(input: { entry: Entry }): Promise<void>;
  saveTag(input: { id?: string; name: string }): Promise<void>;
  deleteTag(input: { id: string }): Promise<void>;
  saveProfile(input: { profile: Profile }): Promise<void>;
  getDraft(input: { profileId?: string; tagId?: string }): Promise<{ draft: Draft }>;
  updateDraft(input: { profileKey: string; text: string; tagIds: string[] }): Promise<void>;
  discardDraft(input: { profileKey: string }): Promise<void>;
  compose(input: { tagId?: string }): Promise<void>;
  configureWidget(input: { profileId?: string }): Promise<void>;
  exportBackup(): Promise<{ cancelled: boolean }>;
  importBackup(): Promise<{ cancelled: boolean }>;
  addListener(event: 'dataChanged', callback: () => void): Promise<PluginListenerHandle>;
}
export const isNative = Capacitor.isNativePlatform();
export const bridge = registerPlugin<MuseamoBridge>('Museamo');
// The browser is an ephemeral design preview, never a second user database.
export const previewEntries: Entry[] = [
  { id: 'preview-1', text: 'A thought doesn’t have to become something to be worth keeping.', createdAt: Date.now(), updatedAt: Date.now(), starred: true, tagIds: ['thoughts'], profileId: null },
  { id: 'preview-2', text: 'Apricity — the warmth of the sun in winter. A whole feeling, tucked into one word.', createdAt: Date.now() - 3600000, updatedAt: Date.now(), starred: false, tagIds: ['words'], profileId: null },
];
export const previewTags: Tag[] = [{ id: 'thoughts', name: 'Shower thoughts' }, { id: 'words', name: 'Cool words' }];
export function filterEntries(entries: Entry[], query: EntryQuery): Entry[] {
  return entries.filter(e => (!query.starred || e.starred) && (!query.tagId || e.tagIds.includes(query.tagId)) && (!query.search || e.text.toLocaleLowerCase().includes(query.search.toLocaleLowerCase())));
}
export function dayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  if (date.toDateString() === new Date().toDateString()) return 'Today';
  return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}
