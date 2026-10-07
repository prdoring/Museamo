import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PaperIcon } from "./PaperIcon";

export function settingsError(error: unknown) {
  return error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String(error.message) : String(error);
}

/** One reader per resource. An action invalidates any older, in-flight read. */
export function useSettingsResource<T>(read: () => Promise<T>, { enabled = true, poll = false, resourceKey = "", initial }: { enabled?: boolean; poll?: boolean; resourceKey?: string; initial?: T } = {}) {
  const [value, setValue] = useState<T | undefined>(initial);
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const reader = useRef(read); reader.current = read;
  const alive = useRef(false), generation = useRef(0), pending = useRef(false);
  const lastAction = useRef<(() => Promise<unknown>) | undefined>(undefined);
  const flight = useRef<{ generation: number; promise: Promise<T | undefined> } | undefined>(undefined);
  const refresh = useCallback((): Promise<T | undefined> => {
    if (!alive.current) return Promise.resolve(undefined);
    const version = generation.current;
    if (flight.current?.generation === version) return flight.current.promise;
    const promise = Promise.resolve().then(() => reader.current()).then(next => {
      if (alive.current && generation.current === version) { setValue(next); setReadError(""); }
      return generation.current === version ? next : undefined;
    }).catch(error => {
      if (alive.current && generation.current === version) setReadError(settingsError(error));
      return undefined;
    }).finally(() => { if (flight.current?.promise === promise) flight.current = undefined; });
    flight.current = { generation: version, promise };
    return promise;
  }, []);
  useEffect(() => {
    alive.current = true;
    generation.current++;
    if (!enabled) return () => { alive.current = false; generation.current++; };
    const update = () => { if (!document.hidden && !pending.current) void refresh(); };
    update();
    const timer = poll ? window.setInterval(update, 2000) : undefined;
    document.addEventListener("visibilitychange", update);
    return () => { alive.current = false; generation.current++; if (timer !== undefined) clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [enabled, poll, resourceKey, refresh]);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (pending.current) return false;
    lastAction.current = action;
    pending.current = true; generation.current++; setBusy(true); setActionError("");
    try {
      await action();
      generation.current++;
      // A committed action remains successful even if the subsequent read fails.
      if (alive.current) await refresh();
      return true;
    } catch (error) {
      generation.current++;
      if (alive.current) { setActionError(settingsError(error)); await refresh(); }
      return false;
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  }, [refresh]);
  const retryAction = useCallback(() => lastAction.current ? run(lastAction.current) : Promise.resolve(false), [run]);
  return { value, readError, actionError, busy, refresh, run, retryAction };
}

export type SettingsResource<T> = ReturnType<typeof useSettingsResource<T>>;

export function SettingRow({ title, detail, onClick, children, disabled = false }: { title: string; detail?: string; onClick?: () => void; children?: ReactNode; disabled?: boolean }) {
  const content = <><span className="setting-row-copy"><strong>{title}</strong>{detail && <span>{detail}</span>}</span>{children || <PaperIcon name="next" size={18} />}</>;
  return onClick ? <button className="setting-row" onClick={onClick} disabled={disabled}>{content}</button> : <div className="setting-row">{content}</div>;
}

export function SettingsFailure({ error, retry }: { error?: string | null; retry?: () => void }) {
  return error ? <div className="settings-error" role="alert"><p>{error}</p>{retry && <button className="text-button" onClick={retry}>Retry</button>}</div> : null;
}

export function SettingsBack({ onClick, children = "Back" }: { onClick: () => void; children?: ReactNode }) {
  return <button className="text-button settings-back" onClick={onClick}><PaperIcon name="back" size={18} />{children}</button>;
}
