import { useEffect, useState } from "react";
import { PaperIcon } from "./PaperIcon";
import { Download, Upload } from "lucide-react";
import { bridge, preview, type Library } from "../data";
import { isPreview, isDesktop, capabilities } from "../platform";
import { Devices } from "./Devices";
import { Recovery } from "./Recovery";
export function Settings({
  library,
  report,
  run,
  refresh,
}: {
  library: Library;
  report: (s: string) => void;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  refresh: () => void;
}) {
  const [locationEnabled, setLocationEnabled] = useState(false);
  const [startupEnabled, setStartupEnabled] = useState(false);
  useEffect(() => {
    if (capabilities.automaticLocation) void run(async () => setLocationEnabled((await bridge.locationSettings()).enabled));
    if (isDesktop) void run(async () => setStartupEnabled((await bridge.getStartupSettings()).enabled));
  }, []);
  return (
    <div className="settings">
      {!isPreview && <Devices />}
      <Recovery report={report} />
      {isDesktop && <section>
        <h2>Windows</h2>
        <label className="startup-setting"><input type="checkbox" checked={startupEnabled} onChange={e => { const enabled = e.target.checked; void run(async () => setStartupEnabled((await bridge.setStartupEnabled({ enabled })).enabled)); }} /> Start Museamo when I sign in</label>
        <p>Closing the window keeps Museamo in the system tray so linked devices can sync. Choose Quit from the tray menu to stop it.</p>
      </section>}
      {capabilities.automaticLocation && <section>
        <h2>Post locations</h2>
        <label><input type="checkbox" checked={locationEnabled} onChange={e => {
          const enabled = e.target.checked;
          void run(async () => { const result = await bridge.setLocationEnabled({ enabled }); setLocationEnabled(result.enabled); if (enabled && !result.enabled) report("Location permission was not granted. Posts will save without location."); });
        }} /> Automatically save location</label>
        <p>Museamo asks for location permission on first opening. After you allow it, every new post tries to add a location automatically—you do not need to press the pin. Tap the pin to skip location for one post, or turn this setting off for all new posts. If services are off or unavailable, your post saves without a location. No background tracking.</p>
        <p className="muted">Address lookup may send coordinates to your device’s geocoding service. Opening maps requests map tiles from OpenStreetMap. Saved locations sync only with devices you link.</p>
      </section>}
      {capabilities.widgets && <section>
        <h2>Widgets</h2>
        <p>
          Add Museamo from your homescreen’s widget menu. Choose fixed tags or a
          tag picker.
        </p>
        {library.profiles.map((p) => (
          <button
            key={p.id}
            className="widget-setting"
            onClick={() =>
              void run(() => bridge.configureWidget({ profileId: p.id }))
            }
          >
            <span className="widget-preview">
              <PaperIcon name="plus" size={20} />
              <strong>{p.label}</strong>
              {p.mode === "picker" && <span className="widget-picker-preview"># <PaperIcon name="down" size={14} /></span>}
            </span>
            <span className="setting-detail">
              {p.mode === "picker"
                ? `Tag picker · ${library.tags.find((t) => t.id === p.selectedTagId)?.name || "No tag"}`
                : `Fixed tags · ${
                    p.tagIds
                      .map((id) => library.tags.find((t) => t.id === id)?.name)
                      .filter(Boolean)
                      .join(", ") || "No tag"
                  }`}
              <PaperIcon name="next" size={18} />
            </span>
          </button>
        ))}
        {!library.profiles.length && (
          <p className="muted">Your widgets will appear here.</p>
        )}
      </section>}
      <section>
        <h2>Backup</h2>
        <p>
          Export a ZIP archive with your thoughts, Recovery, original photos/videos, tags, and widget settings. Older JSON backups can still be imported. Imports keep
          conflicting content as separate copies.
        </p>
        <div className="action-row">
          <button
            className="secondary"
            onClick={() =>
              void run(async () => {
                if (!(await bridge.exportBackup()).cancelled)
                  report("Backup exported.");
              })
            }
          >
            <Download size={18} />
            Export
          </button>
          <button
            className="secondary"
            onClick={() =>
              void run(async () => {
                if (!(await bridge.importBackup()).cancelled)
                  report("Backup imported.");
              })
            }
          >
            <Upload size={18} />
            Import
          </button>
        </div>
      </section>
      <section>
        <h2>About & storage</h2>
        <p>Museamo · a place for your thoughts.</p>
        <p className="muted">
          Original attachments stay in your local library and sync directly with devices you link. Linked media loads from its host when visible. No account or cloud sync. Removing
          app data deletes your library; export a backup first.
        </p>
      </section>
      {isPreview && (
        <section>
          <h2>Preview tools</h2>
          <p>Temporary examples, separate from your phone.</p>
          <div className="preview-tools">
            <button
              className="secondary"
              onClick={() => {
                preview.reset();
                refresh();
              }}
            >
              Reset examples
            </button>
            <button
              className="secondary"
              onClick={() => {
                preview.reset(true);
                refresh();
              }}
            >
              Empty library
            </button>
            <button
              className="secondary"
              onClick={() => {
                preview.stress();
                refresh();
              }}
            >
              Large library
            </button>
            <button
              className="secondary"
              onClick={() => {
                preview.failNext();
                report("The next save will fail once.");
              }}
            >
              Fail next save
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
