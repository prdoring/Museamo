import { useEffect, useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { bridge, preview, type Library, type Tag } from "../data";
import { isPreview, isDesktop, capabilities, desktopName, desktopCloseDescription } from "../platform";
import { useDesktopLayout, useDesktopRuntime } from "./Desktop";
import { Devices } from "./Devices";
import { Recovery } from "./Recovery";
import { SearchField, TagList } from "./LibraryViews";
import { SettingRow, SettingsBack, SettingsFailure, settingsError, useSettingsResource } from "./SettingsControls";
import { createDevicePreview } from "../devicePreview";

export type SettingsSection = "home" | "tags" | "recovery" | "devices" | "backup" | "location" | "widgets" | "behavior" | "about" | "preview";
export const settingsTitles: Record<SettingsSection, string> = { home: "Settings", tags: "Manage tags", recovery: "Recovery", devices: "Linked devices", backup: "Backup", location: "Post locations", widgets: "Widgets", behavior: "App behavior", about: "About & privacy", preview: "Preview tools" };
const demoDevices = createDevicePreview();

export function Settings({ library, report, refresh, section: controlledSection, onSectionChange, editTag, openTag, tagQuery, onTagQueryChange }: {
  library: Library; report: (s: string) => void; run?: (fn: () => Promise<unknown>) => Promise<void>; refresh: () => void;
  section?: SettingsSection; onSectionChange?: (section: SettingsSection) => void; editTag?: (tag: Tag | "new") => void; openTag?: (id: string) => void;
  tagQuery?: string; onTagQueryChange?: (query: string) => void;
}) {
  const desktopLayout = useDesktopLayout();
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1100px)").matches);
  const [localSection, setLocalSection] = useState<SettingsSection>("home");
  const section = controlledSection ?? localSection;
  const selected = section === "home" && desktopLayout && wide ? "tags" : section;
  const change = (next: SettingsSection) => { if (onSectionChange) onSectionChange(next); else setLocalSection(next); };
  const [localQuery, setLocalQuery] = useState("");
  const query = tagQuery ?? localQuery, setQuery = onTagQueryChange ?? setLocalQuery;
  const heading = useRef<HTMLHeadingElement>(null);
  const previousSection = useRef(selected);
  const demo = demoDevices;
  const deviceApi = isPreview ? demo : bridge;
  const devices = useSettingsResource(() => deviceApi.getSyncState(), { enabled: capabilities.sync || isPreview, poll: true });
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1100px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (selected !== previousSection.current) {
      const previous = previousSection.current; previousSection.current = selected;
      if (selected === "home") document.querySelector<HTMLElement>(`[data-setting="${previous}"]`)?.focus();
      else heading.current?.focus({ preventScroll: true });
    }
  }, [selected]);
  const groups = [
    { title: "Organize your library", items: [{ id: "tags", detail: `${library.tags.length} ${library.tags.length === 1 ? "tag" : "tags"}` }, ...(capabilities.recovery ? [{ id: "recovery", detail: "Deleted thoughts and saved versions" }] : [])] },
    { title: "Devices and backups", items: [...(capabilities.sync || isPreview ? [{ id: "devices", detail: isPreview ? "Simulated devices" : devices.value ? `${devices.value.devices.length} linked · ${devices.value.phase === "syncing" ? "Syncing" : devices.value.enabled ? "Local network" : "Needs attention"}` : "Your own devices" }] : []), ...(capabilities.backups ? [{ id: "backup", detail: "Export or import your library" }] : [])] },
    { title: "This device", items: [...(capabilities.automaticLocation ? [{ id: "location", detail: "Location for new thoughts" }] : []), ...(capabilities.widgets ? [{ id: "widgets", detail: `${library.profiles.length} widget profiles` }] : []), ...(isDesktop ? [{ id: "behavior", detail: "Startup and window behavior" }] : [])] },
    { title: "Information", items: [{ id: "about", detail: "Local storage and privacy" }, ...(isPreview ? [{ id: "preview", detail: "Temporary examples and test states" }] : [])] },
  ];
  return <div className="settings settings-workspace" data-section={selected} data-controlled={!!onSectionChange}>
    <nav className="settings-topics" aria-label="Settings topics" hidden={selected !== "home" && !(desktopLayout && wide)}>
      {groups.filter(group => group.items.length).map(group => <div className="settings-topic-group" key={group.title}>
        <h2>{group.title}</h2>
        {group.items.map(item => <button key={item.id} className="setting-row" data-setting={item.id} aria-current={selected === item.id ? "page" : undefined} onClick={() => change(item.id as SettingsSection)}>
          <span className="setting-row-copy"><strong>{settingsTitles[item.id as SettingsSection]}</strong><span>{item.detail}</span></span><span aria-hidden="true">›</span>
        </button>)}
      </div>)}
    </nav>
    <div className="settings-content" hidden={selected === "home"}>
      {!onSectionChange && !(desktopLayout && wide) && <SettingsBack onClick={() => change("home")}>Settings</SettingsBack>}
      <h2 className="settings-page-title" ref={heading} tabIndex={-1}>{settingsTitles[selected]}</h2>
      {selected === "tags" && <><SearchField tags query={query} change={setQuery} /><TagList manage tags={library.tags} query={query} open={openTag ?? (() => {})} edit={editTag ?? (() => {})} changed={async () => { refresh(); }} /></>}
      {selected === "recovery" && capabilities.recovery && <Recovery report={report} />}
      {(capabilities.sync || isPreview) && <Devices active={selected === "devices"} controller={devices} api={deviceApi} demo={isPreview} />}
      {selected === "backup" && capabilities.backups && <BackupSettings refresh={refresh} report={report} />}
      {selected === "location" && capabilities.automaticLocation && <LocationSettings />}
      {selected === "behavior" && isDesktop && <DesktopSettings />}
      {selected === "widgets" && capabilities.widgets && <WidgetSettings library={library} />}
      {selected === "about" && <section className="settings-page"><p>Museamo · a place for your thoughts.</p>
        <SettingRow title="Saved on this device" detail="Thoughts, drafts, and original attachments live in your local library." children={<span />} />
        <SettingRow title="Your linked devices" detail="Saved content syncs directly over your local network. No account or cloud sync." children={<span />} />
        <details className="settings-help"><summary>Privacy and external services</summary><p>Linked media loads from its host when visible. Maps request tiles from OpenStreetMap. Address lookup may send coordinates to your device’s geocoding service.</p><p>Sharing a tag also shares its saved locations and attachments with its members.</p></details>
        <p className="muted">Removing app data deletes this device’s library.{capabilities.backups ? " Export a backup first." : " Backup export and import are not available yet on iPhone. Keep this installation to preserve your local library."}</p>
      </section>}
      {selected === "preview" && isPreview && <section className="settings-page"><p>Temporary examples. No changes to installed apps or real devices.</p>
        <div className="preview-tools">{[["Reset examples", () => preview.reset()], ["Empty library", () => preview.reset(true)], ["Large library", () => preview.stress()], ["Fail next save", () => { preview.failNext(); report("The next save will fail once."); }]].map(([label, action]) => <button className="secondary" key={String(label)} onClick={() => { (action as () => void)(); refresh(); }}>{String(label)}</button>)}</div>
        <h3>Device scenarios</h3><div className="preview-tools">{(["empty", "linked", "unavailable", "incoming"] as const).map(scenario => <button className="secondary" key={scenario} onClick={() => { demo.scenario(scenario); void devices.refresh(); change("devices"); }}>{scenario === "empty" ? "No linked devices" : scenario === "linked" ? "Linked devices" : scenario === "incoming" ? "Incoming request" : "Discovery unavailable"}</button>)}</div>
      </section>}
    </div>
  </div>;
}

function LocationSettings() {
  const settings = useSettingsResource(() => bridge.locationSettings());
  const [message, setMessage] = useState("");
  return <section className="settings-page">
    <label className="setting-row setting-switch"><span className="setting-row-copy"><strong>Automatically save location</strong><span>Add a location to new thoughts. No background tracking.</span></span>
      <input type="checkbox" role="switch" checked={settings.value?.enabled ?? false} disabled={!settings.value || settings.busy || !!settings.readError} onChange={event => {
        const enabled = event.target.checked; setMessage("");
        void settings.run(async () => { const result = await bridge.setLocationEnabled({ enabled }); if (enabled && !result.enabled) setMessage("Location permission was not granted. Thoughts will save without location."); });
      }} /></label>
    {!settings.value && !settings.readError && <p role="status">Loading location preference…</p>}
    {settings.busy && <p role="status">Saving preference…</p>}
    {settings.value && !settings.value.permitted && <p className="muted">Location permission is off. Enable automatic location to request permission.</p>}
    {message && <p role="status">{message}</p>}
    <SettingsFailure error={settings.actionError || settings.readError} retry={() => { if (settings.actionError) void settings.retryAction(); else void settings.refresh(); }} />
    <details className="settings-help"><summary>How location works</summary><p>New thoughts try to add a location after permission is allowed. Tap the pin to skip it for one thought. Unavailable location never prevents saving.</p><p>Drafts keep their saved location. Location services and app permission are controlled by Android.</p></details>
  </section>;
}

function DesktopSettings() {
  const runtime = useDesktopRuntime();
  const info = runtime.status === "ready" ? runtime.info : undefined;
  const startup = useSettingsResource(() => bridge.getStartupSettings(), { enabled: !!info?.startupSupported });
  return <section className="settings-page">
    {runtime.status === "loading" && <p role="status">Loading desktop options…</p>}
    {runtime.status === "error" && <p role="alert">Desktop options are unavailable. Use Retry desktop options above.</p>}
    {info && <><h3>{desktopName(info)}</h3>{info.startupSupported ? <>
      <label className="setting-row setting-switch startup-setting"><span className="setting-row-copy"><strong>Start Museamo when I sign in</strong><span>Keep linked devices available for sync.</span></span><input type="checkbox" role="switch" checked={startup.value?.enabled ?? false} disabled={!startup.value || startup.busy || !!startup.readError} onChange={event => { const enabled = event.target.checked; void startup.run(() => bridge.setStartupEnabled({ enabled })); }} /></label>
      {!startup.value && !startup.readError && <p role="status">Checking sign-in settings…</p>}
      {startup.busy && <p role="status">Saving sign-in preference…</p>}
      <SettingsFailure error={startup.actionError} retry={() => void startup.retryAction()} />
      {startup.readError && <div className="settings-error" role="alert"><p>Sign-in settings could not be loaded.</p><button className="text-button" onClick={() => void startup.refresh()}>Retry sign-in settings</button></div>}
    </> : <p className="muted">Starting at sign-in is unavailable in this app session.</p>}
      <SettingRow title={info.closeBehavior === "background" ? "Closing keeps Museamo running" : "Closing quits Museamo"} detail={info.closeBehavior === "background" ? "Your linked devices can continue syncing." : "Sync resumes when you reopen Museamo."} children={<span className="muted">Automatic</span>} />
      <details className="settings-help"><summary>Closing and quitting</summary><p>{desktopCloseDescription(info)}</p></details>
    </>}
  </section>;
}

function BackupSettings({ refresh, report }: { refresh: () => void; report: (message: string) => void }) {
  const [operation, setOperation] = useState<"export" | "import">();
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  const pending = useRef(false);
  async function perform(kind: "export" | "import") {
    if (pending.current) return;
    pending.current = true; setOperation(kind); setMessage(""); setError("");
    try {
      const result = await (kind === "export" ? bridge.exportBackup() : bridge.importBackup());
      const next = result.cancelled ? "Cancelled. Your library has not changed." : kind === "export" ? "Backup exported." : "Backup imported.";
      setMessage(next); if (!result.cancelled) { report(next); if (kind === "import") refresh(); }
    } catch (failure) { setError(settingsError(failure)); }
    finally { pending.current = false; setOperation(undefined); }
  }
  return <section className="settings-page"><p>Keep a portable copy of your saved library.</p>
    <div className="backup-actions"><button className="primary" disabled={!!operation} onClick={() => void perform("export")}><Download size={18} />Export backup</button><button className="secondary" disabled={!!operation} onClick={() => void perform("import")}><Upload size={18} />Import backup</button></div>
    <p className="muted">Exported ZIP files are not encrypted. Store them somewhere private.</p>
    {operation && <p role="status">{operation === "export" ? "Exporting backup…" : "Importing backup…"}</p>}{message && <p role="status">{message}</p>}
    <SettingsFailure error={error} />
    <details className="settings-help"><summary>What’s included</summary><p>Saved thoughts, tags, original photos/videos, locations, Recovery, and widget settings. Drafts and device identity are excluded.</p><p>Older supported JSON and ZIP backups remain importable. Imports retain conflicting content as separate copies.</p></details>
  </section>;
}

function WidgetSettings({ library }: { library: Library }) {
  const [error, setError] = useState("");
  return <section className="settings-page"><p>Add Museamo from your home screen’s widget menu.</p>
    {library.profiles.map(profile => <SettingRow key={profile.id} title={profile.label} detail={profile.mode === "picker" ? `Tag picker · ${library.tags.find(tag => tag.id === profile.selectedTagId)?.name || "No tag"}` : `Fixed tags · ${profile.tagIds.map(id => library.tags.find(tag => tag.id === id)?.name).filter(Boolean).join(", ") || "No tag"}`} onClick={() => { setError(""); void bridge.configureWidget({ profileId: profile.id }).catch(failure => setError(settingsError(failure))); }} />)}
    {!library.profiles.length && <p className="empty-state">Your widgets will appear here after you add one.</p>}
    <SettingsFailure error={error} />
  </section>;
}
