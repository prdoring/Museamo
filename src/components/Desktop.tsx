import { createContext, useContext, useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isDesktop, type DesktopRuntimeState } from "../platform";

export const DesktopLayout = createContext(false);
export const useDesktopLayout = () => useContext(DesktopLayout);
export const DesktopRuntime = createContext<DesktopRuntimeState>({ status: "loading" });
export const useDesktopRuntime = () => useContext(DesktopRuntime);

/** Window chrome deliberately lives outside the application's modal/inert region. */
export function WindowControls({ report }: { report: (message: string) => void }) {
  const runtime = useDesktopRuntime();
  const custom = runtime.status === "ready" && runtime.info.windowControls === "custom";
  const controlNativeWindow = isDesktop && custom && runtime.status === "ready" && runtime.info.os !== "preview";
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    if (!controlNativeWindow) return;
    let disposed = false;
    const window = getCurrentWindow();
    const update = () => void window.isMaximized().then(value => { if (!disposed) setMaximized(value); }).catch(() => {});
    update();
    void window.isFocused().then(value => { if (!disposed) setFocused(value); }).catch(() => {});
    const resize = window.onResized(update).catch(() => undefined);
    const focus = window.onFocusChanged(({ payload }) => { if (!disposed) setFocused(payload); }).catch(() => undefined);
    return () => { disposed = true; void resize.then(remove => remove?.()); void focus.then(remove => remove?.()); };
  }, [controlNativeWindow]);
  const run = (action: "minimize" | "toggleMaximize" | "close") => {
    if (!controlNativeWindow) return;
    void getCurrentWindow()[action]().catch(() => report("Could not change the window. Please try again."));
  };
  if (!custom || runtime.status !== "ready") return null;
  const preview = runtime.info.os === "preview";
  const closeTitle = preview ? "Preview window controls" : runtime.info.closeBehavior === "background" ? "Close to tray" : "Quit Museamo";
  return <div className="window-controls" data-focused={focused} aria-label="Window controls">
    <button disabled={preview} aria-label="Minimize window" title={preview ? "Preview window controls" : "Minimize"} onClick={() => run("minimize")}><Minus size={16} /></button>
    <button disabled={preview} aria-label={maximized ? "Restore window" : "Maximize window"} title={preview ? "Preview window controls" : maximized ? "Restore" : "Maximize"} onClick={() => run("toggleMaximize")}>
      {maximized ? <Copy size={14} /> : <Square size={14} />}
    </button>
    <button disabled={preview} className="window-close" aria-label="Close window" title={closeTitle} onClick={() => run("close")}><X size={18} /></button>
  </div>;
}
