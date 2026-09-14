import {
  Capacitor,
  registerPlugin,
  type PluginListenerHandle,
} from "@capacitor/core";
import { hashtags } from "./hashtags";
export interface Tag {
  id: string;
  name: string;
  count?: number;
}
export interface Entry {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  starred: boolean;
  tagIds: string[];
  profileId: string | null;
}
export interface Profile {
  id: string;
  label: string;
  mode: "fixed" | "picker";
  tagIds: string[];
  selectedTagId: string | null;
}
export interface Draft {
  profileKey: string;
  entryId: string;
  text: string;
  tagIds: string[];
  profileId: string | null;
}
export interface EntryQuery {
  search?: string;
  starred?: boolean;
  tagId?: string;
  offset?: number;
  limit?: number;
  beforeTime?: number;
  beforeId?: string;
}
export interface Library {
  tags: Tag[];
  profiles: Profile[];
}
export interface ComposeResult {
  cancelled: boolean;
  entryId?: string;
}
export interface MuseamoBridge {
  copyFormatted(input: { text: string; html: string }): Promise<void>;
  openExternal(input: { url: string }): Promise<void>;
  queryEntries(
    query: EntryQuery,
  ): Promise<{ entries: Entry[]; hasMore: boolean }>;
  library(): Promise<Library>;
  getEntry(input: { id: string }): Promise<{ entry: Entry | null }>;
  updateEntry(input: {
    id: string;
    text: string;
    tagIds: string[];
  }): Promise<void>;
  setStar(input: { id: string; starred: boolean }): Promise<void>;
  deleteEntry(input: { id: string }): Promise<void>;
  restoreEntry(input: { entry: Entry }): Promise<void>;
  saveTag(input: { id?: string; name: string }): Promise<void>;
  deleteTag(input: { id: string }): Promise<void>;
  saveProfile(input: { profile: Profile }): Promise<void>;
  getDraft(input: {
    profileId?: string;
    tagId?: string;
  }): Promise<{ draft: Draft }>;
  updateDraft(input: {
    profileKey: string;
    text: string;
    tagIds: string[];
  }): Promise<void>;
  discardDraft(input: { profileKey: string }): Promise<void>;
  compose(input: { tagId?: string }): Promise<ComposeResult>;
  configureWidget(input: { profileId?: string }): Promise<void>;
  exportBackup(): Promise<{ cancelled: boolean }>;
  importBackup(): Promise<{ cancelled: boolean }>;
  addListener(
    event: "dataChanged",
    callback: () => void,
  ): Promise<PluginListenerHandle>;
}
export const isNative = Capacitor.isNativePlatform();
export const previewTags: Tag[] = [
  { id: "thoughts", name: "Shower thoughts" },
  { id: "words", name: "Cool words" },
  { id: "jokes", name: "Jokes" },
  { id: "later", name: "For later" },
];
const now = Date.now();
export const previewEntries: Entry[] = [
  {
    id: "preview-1",
    text: 'A book is just a very long message from someone you’ve never met. #"Shower thoughts"',
    createdAt: now,
    updatedAt: now,
    starred: false,
    tagIds: ["thoughts"],
    profileId: null,
  },
  {
    id: "preview-2",
    text: '**Apricity**\n_noun_\n\nThe warmth of the sun in winter.\n\n- A whole feeling, tucked into one word.\n- Best enjoyed by a sunny window.\n #"Cool words"',
    createdAt: now - 3600000,
    updatedAt: now - 3600000,
    starred: true,
    tagIds: ["words"],
    profileId: null,
  },
  {
    id: "preview-3",
    text: "Buy the good peaches. 🍑",
    createdAt: now - 7200000,
    updatedAt: now - 7200000,
    starred: false,
    tagIds: [],
    profileId: null,
  },
  {
    id: "preview-4",
    text: "Things I noticed on the walk:\n\nThe tiny door in the old brick wall.\nA dog carrying its own lead.\nSomeone practicing the same four piano notes.\nThe smell of rain before it arrived.\nAn orange chair left at the bus stop.\nA handwritten sign: back in five.\n\nI like that none of these needed a photograph.\nI just wanted to remember them.",
    createdAt: now - 86400000,
    updatedAt: now - 86400000,
    starred: true,
    tagIds: ["thoughts", "later"],
    profileId: null,
  },
];
export function filterEntries(entries: Entry[], query: EntryQuery): Entry[] {
  return entries.filter(
    (e) =>
      (!query.starred || e.starred) &&
      (!query.tagId || e.tagIds.includes(query.tagId)) &&
      (!query.search ||
        e.text.toLocaleLowerCase().includes(query.search.toLocaleLowerCase())),
  );
}
export function dayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  if (date.toDateString() === new Date().toDateString()) return "Today";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}
const clone = <T>(x: T): T => structuredClone(x);
let entries = clone(previewEntries),
  tags = clone(previewTags);
let profiles: Profile[] = [
  {
    id: "sample-widget",
    label: "Shower thoughts",
    mode: "picker",
    tagIds: [],
    selectedTagId: "thoughts",
  },
];
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
let failNext = false;
function mutation() {
  if (failNext) {
    failNext = false;
    throw new Error(
      "Preview save failed. Your writing is still here. Try again.",
    );
  }
}
function changed() {
  listeners.forEach((fn) => fn());
}
function assigned(text: string, explicit: string[], previous?: Entry) {
  const inline = hashtags(text)
    .filter(
      (h) =>
        !previous ||
        !hashtags(previous.text).some(
          (old) => old.name.toLowerCase() === h.name.toLowerCase(),
        ) ||
        previous.tagIds.some((id) =>
          tags.some(
            (t) => t.id === id && t.name.toLowerCase() === h.name.toLowerCase(),
          ),
        ),
    )
    .map(({ name }) => {
      let tag = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
      if (!tag) {
        tag = { id: crypto.randomUUID(), name };
        tags.push(tag);
      }
      return tag.id;
    });
  return [
    ...new Set([
      ...explicit.filter((id) => tags.some((t) => t.id === id)),
      ...inline,
    ]),
  ];
}
export const preview = {
  reset(empty = false) {
    entries = empty ? [] : clone(previewEntries);
    tags = empty ? [] : clone(previewTags);
    drafts.clear();
    failNext = false;
    changed();
  },
  failNext() {
    failNext = true;
  },
  stress() {
    this.reset();
    for (let i = 0; i < 200; i++)
      entries.push({
        ...clone(previewEntries[i % 4]),
        id: crypto.randomUUID(),
        createdAt: now - (i + 2) * 86400000,
      });
    for (let i = 0; i < 35; i++)
      tags.push({ id: crypto.randomUUID(), name: `Topic ${i + 1}` });
    changed();
  },
  save(draft: Draft) {
    mutation();
    if (!draft.text.trim()) throw new Error("Write a thought first.");
    const found = entries.find((e) => e.id === draft.entryId);
    if (found) return found.id;
    const time = Date.now();
    entries.unshift({
      id: draft.entryId,
      text: draft.text,
      tagIds: assigned(draft.text, draft.tagIds),
      starred: false,
      createdAt: time,
      updatedAt: time,
      profileId: null,
    });
    drafts.delete(draft.profileKey);
    changed();
    return draft.entryId;
  },
};
const browser: MuseamoBridge = {
  async copyFormatted({ text }) {
    await navigator.clipboard.writeText(text);
  },
  async openExternal({ url }) {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol))
      throw new Error("Only web links can be opened.");
    window.open(parsed.href, "_blank", "noopener,noreferrer");
  },
  async queryEntries(q) {
    const rows = filterEntries(entries, q)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .filter(
        (e) =>
          q.beforeTime === undefined ||
          e.createdAt < q.beforeTime ||
          (e.createdAt === q.beforeTime && e.id < (q.beforeId || "")),
      );
    const start = q.offset || 0,
      limit = q.limit || 50;
    return clone({
      entries: rows.slice(start, start + limit),
      hasMore: rows.length > start + limit,
    });
  },
  async getEntry({ id }) {
    return { entry: clone(entries.find((e) => e.id === id) || null) };
  },
  async library() {
    return clone({
      tags: tags
        .map((t) => ({
          ...t,
          count: entries.filter((e) => e.tagIds.includes(t.id)).length,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      profiles,
    });
  },
  async updateEntry({ id, text, tagIds }) {
    mutation();
    if (!text.trim()) throw new Error("A thought cannot be empty.");
    const e = entries.find((e) => e.id === id);
    if (!e) throw new Error("This thought no longer exists.");
    Object.assign(e, {
      text,
      tagIds: assigned(text, tagIds, e),
      updatedAt: Date.now(),
    });
    changed();
  },
  async setStar({ id, starred }) {
    mutation();
    const e = entries.find((e) => e.id === id);
    if (e) e.starred = starred;
    changed();
  },
  async deleteEntry({ id }) {
    mutation();
    entries = entries.filter((e) => e.id !== id);
    changed();
  },
  async restoreEntry({ entry }) {
    mutation();
    if (!entries.some((e) => e.id === entry.id))
      entries.push(
        clone({
          ...entry,
          tagIds: entry.tagIds.filter((id) => tags.some((t) => t.id === id)),
        }),
      );
    changed();
  },
  async saveTag({ id, name }) {
    mutation();
    name = name.trim();
    if (!name || name.length > 80) throw new Error("Use 1–80 characters.");
    if (
      tags.some(
        (t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new Error("This tag already exists.");
    const tag = tags.find((t) => t.id === id);
    if (tag) tag.name = name;
    else tags.push({ id: crypto.randomUUID(), name });
    changed();
  },
  async deleteTag({ id }) {
    mutation();
    tags = tags.filter((t) => t.id !== id);
    entries.forEach((e) => (e.tagIds = e.tagIds.filter((t) => t !== id)));
    drafts.forEach((d) => (d.tagIds = d.tagIds.filter((t) => t !== id)));
    profiles = profiles.map((p) => ({
      ...p,
      tagIds: p.tagIds.filter((t) => t !== id),
      selectedTagId: p.selectedTagId === id ? null : p.selectedTagId,
    }));
    changed();
  },
  async saveProfile({ profile }) {
    mutation();
    profiles = [...profiles.filter((p) => p.id !== profile.id), clone(profile)];
    changed();
  },
  async getDraft({ tagId }) {
    const key = `app:${tagId || "general"}`;
    if (!drafts.has(key))
      drafts.set(key, {
        profileKey: key,
        entryId: crypto.randomUUID(),
        text: "",
        tagIds: tagId ? [tagId] : [],
        profileId: null,
      });
    return { draft: clone(drafts.get(key)!) };
  },
  async updateDraft({ profileKey, text, tagIds }) {
    const d = drafts.get(profileKey);
    if (d) Object.assign(d, { text, tagIds: clone(tagIds) });
  },
  async discardDraft({ profileKey }) {
    drafts.delete(profileKey);
  },
  async compose() {
    return { cancelled: true };
  },
  async configureWidget() {
    throw new Error("Widget configuration is available on Android.");
  },
  async exportBackup() {
    throw new Error(
      "File backup is available on Android. Preview examples are temporary.",
    );
  },
  async importBackup() {
    throw new Error("Import backups on Android.");
  },
  async addListener(_event, callback) {
    listeners.add(callback);
    return {
      remove: async () => {
        listeners.delete(callback);
      },
    };
  },
};
export const bridge = isNative
  ? registerPlugin<MuseamoBridge>("Museamo")
  : browser;
