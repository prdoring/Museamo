import { createContext, useContext, useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isDesktop } from "../platform";

export const DesktopLayout = createContext(false);
export const useDesktopLayout = () => useContext(DesktopLayout);

/** Window chrome deliberately lives outside the application's modal/inert region. */
export function WindowControls({ report }: { report: (message: string) => void }) {
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    const window = getCurrentWindow();
    const update = () => void window.isMaximized().then(value => { if (!disposed) setMaximized(value); }).catch(() => {});
    update();
    void window.isFocused().then(value => { if (!disposed) setFocused(value); }).catch(() => {});
    const resize = window.onResized(update).catch(() => undefined);
    const focus = window.onFocusChanged(({ payload }) => { if (!disposed) setFocused(payload); }).catch(() => undefined);
    return () => { disposed = true; void resize.then(remove => remove?.()); void focus.then(remove => remove?.()); };
  }, []);
  const run = (action: "minimize" | "toggleMaximize" | "close") => {
    if (!isDesktop) return;
    void getCurrentWindow()[action]().catch(() => report("Could not change the window. Please try again."));
  };
  return <div className="window-controls" data-focused={focused} aria-label="Window controls">
    <button aria-label="Minimize window" title="Minimize" onClick={() => run("minimize")}><Minus size={16} /></button>
    <button aria-label={maximized ? "Restore window" : "Maximize window"} title={maximized ? "Restore" : "Maximize"} onClick={() => run("toggleMaximize")}>
      {maximized ? <Copy size={14} /> : <Square size={14} />}
    </button>
    <button className="window-close" aria-label="Close window" title="Close to tray" onClick={() => run("close")}><X size={18} /></button>
  </div>;
}
