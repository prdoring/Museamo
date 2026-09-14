import { PaperIcon } from "./PaperIcon";
import { Download, Upload } from "lucide-react";
import { bridge, isNative, preview, type Library } from "../data";
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
  return (
    <div className="settings">
      <section>
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
      </section>
      <section>
        <h2>Backup</h2>
        <p>
          Keep a copy of your thoughts, tags, and widgets. Imports keep
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
          Stored on this device. No account or background uploads. Uninstalling
          removes local data; export a backup first.
        </p>
      </section>
      {!isNative && (
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
