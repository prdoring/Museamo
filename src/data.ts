import {
  Capacitor,
  registerPlugin,
} from "@capacitor/core";
import { type Attachment, MEDIA_LIMIT } from "./media";
import { hashtags } from "./hashtags";
import { type LocationLabelParts } from "./locationLabels";
import { platform } from "./platform";
import { desktopBridge } from "./desktop";
import type { CompanionBridge } from "./sync";
import type { ShareBridge, TagSharing } from "./sharing";
export { locationLabel } from "./locationLabels";
export type LocationStatus = "available" | "services-off" | "permission-denied" | "disabled" | "timeout" | "cancelled" | "unavailable";
export function locationStatusMessage(status: LocationStatus) {
  switch (status) {
    case "services-off": return "Device location is off. This post will save without a location.";
    case "permission-denied": return "Location permission was not granted. You can allow it in Android app settings.";
    case "timeout": return "Couldn’t find your location. Tap the pin to retry.";
    case "disabled": return "Automatic location is off. Tap the pin to add a location to this post.";
    case "cancelled": return "Location lookup stopped. Tap the pin to retry.";
    case "unavailable": return "Location is unavailable. Tap the pin to retry.";
    default: return "";
  }
}
export interface PostLocation extends LocationLabelParts {
  latitude: number;
  longitude: number;
  capturedAt: number;
  accuracy?: number;
  token: string;
}
export interface Tag {
  sharing?: TagSharing;
  id: string;
  name: string;
  normalizedName?: string;
  type: "standard" | "checklist";
  count?: number;
}
/** Duplicate names can arrive through concurrent renames; IDs keep them separate. */
export function tagDisplayName(tag: Tag, tags: Tag[]): string {
  const normalize = (name: string) => name.trim().normalize("NFC").toLowerCase();
  const normalized = tag.normalizedName ?? normalize(tag.name);
  const collisions = tags.filter(other => (other.normalizedName ?? normalize(other.name)) === normalized);
  if (collisions.length < 2) return tag.name;
  const type = tag.type === "checklist" ? "Checklist" : "Standard";
  const sharing = collisions.some(t => t.sharing) ? ` · ${tag.sharing ? "Shared" : "Private"}` : "";
  return `${tag.name} · ${type}${sharing}${collisions.filter(other => other.type === tag.type && !!other.sharing === !!tag.sharing).length > 1 ? ` · ${tag.id.slice(0, 8)}` : ""}`;
}
export interface Entry {
  revision?: string;
  location?: PostLocation | null;
  id: string;
  text: string;
  attachments?: Attachment[];
  createdAt: number;
  updatedAt: number;
  starred: boolean;
  completed: boolean;
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
  location?: PostLocation | null;
  locationAttempted?: boolean;
  profileKey: string;
  attachments?: Attachment[];
  entryId: string;
  text: string;
  tagIds: string[];
  profileId: string | null;
}
export interface EntryQuery {
  checklistOnly?: boolean;
  order?: "newest" | "checklist";
  beforeCompleted?: boolean;
  located?: boolean;
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
export interface MuseamoBridge extends CompanionBridge, ShareBridge {
  commitDraft(input: { draft: Draft }): Promise<{ entryId: string }>;
  openLocation(input: { latitude: number; longitude: number }): Promise<void>;
  locationSettings(): Promise<{ enabled: boolean; permitted: boolean }>;
  setLocationEnabled(input: { enabled: boolean }): Promise<{ enabled: boolean }>;
  currentLocation(): Promise<{ location: PostLocation | null; status: LocationStatus }>;
  pickMedia(input: { remaining: number }): Promise<{ attachments: Attachment[] }>;
  resolveMedia(input: { id: string }): Promise<{ url: string; thumbnailUrl?: string; availability?: "available" | "pending" | "unsupported" }>;
  releaseMedia(input: { ids: string[] }): Promise<void>;
  releaseDeleted(input: { id: string }): Promise<void>;
  copyFormatted(input: { text: string; html: string }): Promise<void>;
  openExternal(input: { url: string }): Promise<void>;
  queryEntries(
    query: EntryQuery,
  ): Promise<{ entries: Entry[]; hasMore: boolean }>;
  library(): Promise<Library>;
  getEntry(input: { id: string }): Promise<{ entry: Entry | null }>;
  updateEntry(input: {
    baseRevision?: string;
    id: string;
    text: string;
    tagIds: string[];
    attachmentIds?: string[];
    location?: PostLocation | null;
    locationAttempted?: boolean;
  }): Promise<void>;
  setStar(input: { id: string; starred: boolean }): Promise<void>;
  setCompleted(input: { id: string; completed: boolean }): Promise<void>;
  deleteEntry(input: { id: string; baseRevision?: string }): Promise<void>;
  restoreEntry(input: { entry: Entry }): Promise<void>;
  saveTag(input: { id?: string; name: string; type?: Tag["type"] }): Promise<void>;
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
    attachmentIds?: string[];
    location?: PostLocation | null;
    locationAttempted?: boolean;
  }): Promise<void>;
  discardDraft(input: { profileKey: string }): Promise<void>;
  compose(input: { tagId?: string }): Promise<ComposeResult>;
  configureWidget(input: { profileId?: string }): Promise<void>;
  exportBackup(): Promise<{ cancelled: boolean }>;
  importBackup(): Promise<{ cancelled: boolean }>;
  addListener(
    event: "dataChanged",
    callback: () => void,
  ): Promise<{ remove(): Promise<void> }>;
}
export const isNative = Capacitor.isNativePlatform();
export const previewTags: Tag[] = [
  { id: "thoughts", name: "Shower thoughts", type: "standard" },
  { id: "words", name: "Cool words", type: "standard" },
  { id: "jokes", name: "Jokes", type: "standard" },
  { id: "later", name: "For later", type: "checklist" },
];
const now = Date.now();
export const previewEntries: Entry[] = [
  {
    id: "preview-1",
    completed: false,
    location: { latitude: 37.7599, longitude: -122.4241, capturedAt: Date.now(), token: "preview-location-1", city: "San Francisco", region: "California", country: "United States", countryCode: "US", locality: "San Francisco, California", userLabel: "Bakery" },
    text: 'A book is just a very long message from someone you’ve never met. #"Shower thoughts"',
    createdAt: now,
    updatedAt: now,
    starred: false,
    tagIds: ["thoughts"],
    profileId: null,
  },
  {
    id: "preview-2",
    completed: false,
    location: { latitude: 37.7694, longitude: -122.4862, capturedAt: Date.now(), token: "preview-location-2" },
    text: '**Apricity**\n_noun_\n\nThe warmth of the sun in winter.\n\n- A whole feeling, tucked into one word.\n- Best enjoyed by a sunny window.\n #"Cool words"',
    createdAt: now - 3600000,
    updatedAt: now - 3600000,
    starred: true,
    tagIds: ["words"],
    profileId: null,
  },
  {
    id: "preview-3",
    completed: false,
    text: "Buy the good peaches. 🍑",
    createdAt: now - 7200000,
    updatedAt: now - 7200000,
    starred: false,
    tagIds: ["later"],
    profileId: null,
  },
  {
    id: "preview-4",
    completed: true,
    text: "Things I noticed on the walk:\n\nThe tiny door in the old brick wall.\nA dog carrying its own lead.\nSomeone practicing the same four piano notes.\nThe smell of rain before it arrived.\nAn orange chair left at the bus stop.\nA handwritten sign: back in five.\n\nI like that none of these needed a photograph.\nI just wanted to remember them.",
    createdAt: now - 86400000,
    updatedAt: now - 86400000,
    starred: true,
    tagIds: ["thoughts", "later"],
    profileId: null,
  },
];
export function filterEntries(entries: Entry[], query: EntryQuery, availableTags: Tag[] = []): Entry[] {
  return entries.filter(
    (e) =>
      (!query.located || !!e.location) &&
      (!query.starred || e.starred) &&
      (!query.checklistOnly || isChecklistEntry(e, availableTags)) &&
      (!query.tagId || e.tagIds.includes(query.tagId)) &&
      (!query.search ||
        [e.text, e.location?.userLabel, e.location?.name, e.location?.address, e.location?.locality, e.location?.city, e.location?.region, e.location?.country, e.location?.countryCode].filter(Boolean).join(" ").toLocaleLowerCase().includes(query.search.toLocaleLowerCase())),
  );
}
export function isChecklistEntry(entry: Entry, tags: Tag[]): boolean {
  return tags.some(tag => tag.type === "checklist" && entry.tagIds.includes(tag.id));
}
export function compareEntries(a: Entry, b: Entry, checklist = false): number {
  return (checklist ? Number(a.completed) - Number(b.completed) : 0) ||
    b.createdAt - a.createdAt || (a.id === b.id ? 0 : a.id < b.id ? 1 : -1);
}
export function isAfterCursor(entry: Entry, query: EntryQuery): boolean {
  if (query.beforeTime === undefined) return true;
  if (query.order === "checklist" && entry.completed !== query.beforeCompleted)
    return entry.completed;
  return entry.createdAt < query.beforeTime ||
    (entry.createdAt === query.beforeTime && entry.id < (query.beforeId || ""));
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
      const matches = tags.filter(t => t.name.toLowerCase() === name.toLowerCase());
      const chosen = matches.filter(t => explicit.includes(t.id) || previous?.tagIds.includes(t.id));
      if (matches.length > 1 && chosen.length !== 1) throw new Error(`Several hashtags are named ${name}. Choose the intended hashtag explicitly.`);
      let tag = chosen[0] ?? matches[0];
      if (!tag) {
        tag = { id: crypto.randomUUID(), name, type: "standard" };
        tags.push(tag);
      }
      return tag.id;
    });
  const result = [
    ...new Set([
      ...explicit.filter((id) => tags.some((t) => t.id === id)),
      ...inline,
    ]),
  ];
  if (tags.filter(t => t.sharing && result.includes(t.id)).length > 1) throw new Error("A thought can belong to only one shared hashtag. Your draft is kept.");
  return result;
}
export const preview = {
  reset(empty = false) {
    entries = empty ? [] : clone(previewEntries);
    tags = empty ? [] : clone(previewTags);
    drafts.clear();
    deletedMedia.clear(); browserPins.clear(); collectBrowserMedia();
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
      tags.push({ id: crypto.randomUUID(), name: `Topic ${i + 1}`, type: "standard" });
    changed();
  },
  save(draft: Draft) {
    mutation();
    if (!draft.text.trim() && !draft.attachments?.length) throw new Error("Write a thought first.");
    const found = entries.find((e) => e.id === draft.entryId);
    if (found) return found.id;
    const time = Date.now();
    entries.unshift({
      id: draft.entryId,
      text: draft.text,
      location: draft.location,
      attachments: clone(draft.attachments || []),
      tagIds: assigned(draft.text, draft.tagIds),
      starred: false,
      completed: false,
      createdAt: time,
      updatedAt: time,
      profileId: null,
    });
    drafts.delete(draft.profileKey);
    changed();
    return draft.entryId;
  },
};
const browserMedia = new Map<string, { attachment: Attachment; url: string }>();
const deletedMedia = new Map<string, Entry>();
function collectBrowserMedia() {
  const referenced = new Set([...entries, ...drafts.values(), ...deletedMedia.values()].flatMap(e => e.attachments?.map(a => a.id) || []));
  for (const [id, media] of browserMedia) if (!referenced.has(id) && !browserPins.has(id)) { URL.revokeObjectURL(media.url); browserMedia.delete(id); }
}
const browserPins = new Set<string>();
const resolveAttachments = (ids: string[]) => {
  if (ids.length > MEDIA_LIMIT || new Set(ids).size !== ids.length) throw new Error("Choose up to 10 different attachments.");
  return ids.map(id => { const media = browserMedia.get(id); if (!media) throw new Error("Attachment is unavailable. Select it again."); return media.attachment; });
};
let previewLocationEnabled = true;
const browser: MuseamoBridge = {
  async getDesktopInfo() { return { os: "preview", startupSupported: false, windowControls: "custom", closeBehavior: "quit" }; },
  async getTagShareState({ tagId }) { const tag = tags.find(t => t.id === tagId); return tag?.sharing ? { ...tag.sharing, members: [{ id: "preview-owner", name: "Your preview", owner: true, you: true }] } : { collectionId: null }; },
  async startTagSharing({ tagId }) { mutation(); const tag = tags.find(t => t.id === tagId); if (!tag) throw new Error("Tag no longer exists."); if (entries.some(e => e.tagIds.includes(tagId) && tags.some(t => t.sharing && e.tagIds.includes(t.id)))) throw new Error("Some thoughts already belong to another shared list."); const collectionId = crypto.randomUUID(); tag.sharing = { collectionId, role: "owner", status: "waiting" }; changed(); return { collectionId }; },
  async createTagInvite() { throw new Error("QR invitations are available in the installed Android app. This preview is temporary."); },
  async cancelTagInvite() {},
  async scanTagInvite() { throw new Error("Scan shared hashtags in the installed Android app."); },
  async previewTagInvite() { throw new Error("Join shared hashtags in the installed Android app."); },
  async joinTagShare() { throw new Error("Join shared hashtags in the installed Android app."); },
  async removeTagShareMember() { throw new Error("Manage members in the installed Android app."); },
  async leaveTagShare({ tagId }) { const tag = tags.find(t => t.id === tagId); if (tag) delete tag.sharing; changed(); },
  async stopTagSharing({ tagId }) { return browser.leaveTagShare({ tagId }); },
  async syncTagShare() { throw new Error("Local-network sync is available in the installed app."); },
  async getSyncState() { return { enabled: false, phase: "idle", devices: [], nearby: [] }; },
  async listDevices() { return { devices: [], nearby: [] }; },
  async linkDevice() { throw new Error("Link devices from the installed Android or desktop app."); },
  async confirmPairing() { throw new Error("Device linking is unavailable in the preview."); },
  async acceptEnrollment() { throw new Error("Device linking is unavailable in the preview."); },
  async syncNow() { throw new Error("Device linking is unavailable in the preview."); },
  async removeDevice() { throw new Error("Device linking is unavailable in the preview."); },
  async cancelPairing() {},
  async listRecovery() { return { items: [...deletedMedia.values()].map(payload => ({ id: payload.id, kind: "entry", entityId: payload.id, payload: clone(payload), createdAt: payload.updatedAt })) }; },
  async restoreRecovery({ id }) {
    const entry = deletedMedia.get(id);
    if (!entry) throw new Error("This version is no longer in Recovery.");
    const entryId = crypto.randomUUID();
    entries.push(clone({ ...entry, id: entryId })); changed(); return { entryId };
  },
  async clearRecovery({ id }) { deletedMedia.delete(id); collectBrowserMedia(); changed(); },
  async clearAllRecovery() { deletedMedia.clear(); collectBrowserMedia(); changed(); },
  async getStartupSettings() { return { enabled: false }; },
  async setStartupEnabled() { throw new Error("Startup settings are available in the installed desktop app."); },
  async commitDraft({ draft }) { return { entryId: preview.save(draft) }; },
  async openLocation({ latitude, longitude }) { await browser.openExternal({ url: `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}` }); },
  async locationSettings() { return { enabled: previewLocationEnabled, permitted: true }; },
  async setLocationEnabled({ enabled }) { previewLocationEnabled = enabled; return { enabled }; },
  async currentLocation() { return { status: "available", location: { latitude: 37.7599, longitude: -122.4241, capturedAt: Date.now(), accuracy: 25, token: crypto.randomUUID(), locality: "San Francisco (preview)" } }; },
  async pickMedia({ remaining }) {
    if (remaining < 1) throw new Error("Choose up to 10 attachments.");
    const files = await new Promise<File[]>(resolve => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = "image/*,video/*"; input.multiple = true;
      input.onchange = () => { resolve(Array.from(input.files || [])); input.remove(); };
      input.oncancel = () => { resolve([]); input.remove(); };
      input.hidden = true; document.body.append(input); input.click();
    });
    if (files.length > remaining) throw new Error("Choose up to " + remaining + " more attachments.");
    for (const f of files) {
      if (!/^(image\/(jpeg|png|gif|webp|heic|heif|avif)|video\/(mp4|webm|quicktime|x-m4v|ogg))$/.test(f.type)) throw new Error("Choose a supported photo or video format.");
      if (!f.size || f.size > (f.type.startsWith("image/") ? 50 : 500) * 1024 * 1024) throw new Error("Use images up to 50 MiB and videos up to 500 MiB.");
    }
    const created: string[] = [];
    try {
      const attachments: Attachment[] = [];
      for (const f of files) {
        const kind = f.type.startsWith("image/") ? "image" : "video";
        const url = URL.createObjectURL(f);
        const id = crypto.randomUUID();
        try {
          const metadata = await new Promise<{ width: number; height: number; duration?: number }>((resolve, reject) => {
            const element = kind === "image" ? new Image() : document.createElement("video");
            const finish = () => { clearTimeout(timer); element.onload = null; element.onerror = null; if (element instanceof HTMLVideoElement) { element.onloadedmetadata = null; element.removeAttribute("src"); element.load(); } };
            const fail = () => { finish(); reject(new Error("This photo or video cannot be displayed. Choose a supported file.")); };
            const timer = window.setTimeout(fail, 15000);
            element.onerror = fail;
            if (element instanceof HTMLVideoElement) {
              element.preload = "metadata";
              element.onloadedmetadata = () => { const meta = { width: element.videoWidth, height: element.videoHeight, duration: element.duration * 1000 }; finish(); if (!meta.width || !meta.height) reject(new Error("This file has no video.")); else resolve(meta); };
            } else element.onload = () => { const meta = { width: element.naturalWidth, height: element.naturalHeight }; finish(); resolve(meta); };
            element.src = url;
          });
          const attachment: Attachment = { id, kind, mimeType: f.type, filename: f.name, byteSize: f.size, ...metadata };
          browserMedia.set(id, { attachment, url }); browserPins.add(id); created.push(id); attachments.push(attachment);
        } catch (error) { URL.revokeObjectURL(url); throw error; }
      }
      return { attachments };
    } catch (error) { created.forEach(id => { const m = browserMedia.get(id); if (m) URL.revokeObjectURL(m.url); browserMedia.delete(id); browserPins.delete(id); }); throw error; }
  },
  async resolveMedia({ id }) { const m = browserMedia.get(id); if (!m) throw new Error("Media is unavailable."); return { url: m.url }; },
  async releaseMedia({ ids }) { ids.forEach(id => browserPins.delete(id)); collectBrowserMedia(); },
  async releaseDeleted({ id }) { deletedMedia.delete(id); collectBrowserMedia(); },
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
    if (q.order && !["newest", "checklist"].includes(q.order)) throw new Error("Unknown thought order.");
    if (q.order === "checklist") {
      if (!tags.some(t => t.id === q.tagId && t.type === "checklist")) throw new Error("Choose a Checklist category.");
      if (q.beforeTime !== undefined && typeof q.beforeCompleted !== "boolean") throw new Error("Reload this checklist before loading more thoughts.");
    }
    const rows = filterEntries(entries, q, tags)
      .sort((a, b) => compareEntries(a, b, q.order === "checklist"))
      .filter(e => isAfterCursor(e, q));
    const start = q.beforeTime === undefined ? Math.max(0, q.offset || 0) : 0,
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
  async updateEntry({ id, text, tagIds, attachmentIds, location }) {
    mutation();
    const e = entries.find((e) => e.id === id);
    if (!e) throw new Error("This thought no longer exists.");
    const attachments = attachmentIds ? resolveAttachments(attachmentIds) : e.attachments || [];
    if (!text.trim() && !attachments.length) throw new Error("Add text or an attachment.");
    Object.assign(e, {
      ...(location !== undefined ? { location } : {}),
      attachments,
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
  async setCompleted({ id, completed }) {
    mutation();
    const entry = entries.find(e => e.id === id);
    if (!entry) throw new Error("This thought no longer exists.");
    if (typeof completed !== "boolean") throw new Error("Invalid completed state.");
    if (!isChecklistEntry(entry, tags)) throw new Error("This thought no longer belongs to a Checklist category.");
    entry.completed = completed;
    changed();
  },
  async deleteEntry({ id }) {
    mutation();
    const entry = entries.find(e => e.id === id);
    if (entry) deletedMedia.set(id, entry);
    entries = entries.filter((e) => e.id !== id);
    changed();
  },
  async restoreEntry({ entry }) {
    mutation();
    deletedMedia.delete(entry.id);
    if (!entries.some((e) => e.id === entry.id))
      entries.push(
        clone({
          ...entry,
          tagIds: entry.tagIds.filter((id) => tags.some((t) => t.id === id)),
        }),
      );
    changed();
  },
  async saveTag({ id, name, type }) {
    mutation();
    name = name.trim();
    if (!name || name.length > 80) throw new Error("Use 1–80 characters.");
    if (
      tags.some(
        (t) => !t.sharing && t.id !== id && t.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new Error("This tag already exists.");
    const tag = tags.find((t) => t.id === id);
    const categoryType = type ?? tag?.type ?? "standard";
    if (!["standard", "checklist"].includes(categoryType)) throw new Error("Unknown category type.");
    if (tag) Object.assign(tag, { name, type: categoryType });
    else tags.push({ id: crypto.randomUUID(), name, type: categoryType });
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
        location: previewLocationEnabled ? (await browser.currentLocation()).location : null,
        locationAttempted: true,
        profileKey: key,
        entryId: crypto.randomUUID(),
        text: "",
        tagIds: tagId ? [tagId] : [],
        profileId: null,
      });
    return { draft: clone(drafts.get(key)!) };
  },
  async updateDraft({ profileKey, text, tagIds, attachmentIds, location, locationAttempted }) {
    const d = drafts.get(profileKey);
    if (d) Object.assign(d, { ...(location !== undefined ? { location } : {}), locationAttempted, text, tagIds: clone(tagIds), attachments: attachmentIds ? resolveAttachments(attachmentIds) : d.attachments || [] });
  },
  async discardDraft({ profileKey }) {
    drafts.delete(profileKey);
    collectBrowserMedia();
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
export const bridge = platform === "android" ? registerPlugin<MuseamoBridge>("Museamo")
  : platform === "desktop" ? desktopBridge() : browser;
