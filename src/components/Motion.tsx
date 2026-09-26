import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

const Exiting = createContext(false);
export const useExiting = () => useContext(Exiting);
export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Keep closing surfaces mounted until their exit finishes, including portal content. */
export function Presence({ children }: { children: ReactNode }) {
  const visible = !!children;
  const last = useRef(children);
  const [retained, setRetained] = useState(visible);
  useLayoutEffect(() => {
    if (visible) { last.current = children; setRetained(true); }
  }, [children, visible]);
  useEffect(() => {
    if (visible || !retained) return;
    const remove = () => { last.current = null; setRetained(false); };
    if (reducedMotion()) { remove(); return; }
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finish = () => { if (preference.matches) remove(); };
    preference.addEventListener("change", finish);
    const timer = window.setTimeout(remove, 160);
    return () => { window.clearTimeout(timer); preference.removeEventListener("change", finish); };
  }, [visible, retained]);
  return <Exiting.Provider value={!visible}>{visible ? children : retained ? last.current : null}</Exiting.Provider>;
}

/** Animate a view change without remounting its editor, map, or feed state. */
export function PageMotion({ view, children }: { view: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (reducedMotion()) return;
    const animation = ref.current?.animate([{ opacity: .35 }, { opacity: 1 }], { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)" });
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const cancel = () => { if (preference.matches) animation?.cancel(); };
    preference.addEventListener("change", cancel);
    return () => { animation?.cancel(); preference.removeEventListener("change", cancel); };
  }, [view]);
  return <div ref={ref}>{children}</div>;
}

export function Disclosure({ children }: { children: ReactNode }) {
  const exiting = useExiting();
  return <div className="motion-disclosure" data-exiting={exiting} inert={exiting}><div>{children}</div></div>;
}

// Overlapping exit/enter animations must not unlock the background prematurely.
const locks = new Set<symbol>();
let originalOverflow = "";
let originalInert = false;
let returnFocus: HTMLElement | null = null;
export function lockOverlay(trigger = document.activeElement as HTMLElement | null) {
  const token = Symbol();
  const shell = document.querySelector<HTMLElement>(".app-shell");
  if (!locks.size) {
    originalOverflow = document.body.style.overflow;
    originalInert = shell?.inert ?? false;
    returnFocus = trigger;
  }
  locks.add(token);
  document.body.style.overflow = "hidden";
  if (shell) shell.inert = true;
  return () => {
    locks.delete(token);
    if (locks.size) return;
    document.body.style.overflow = originalOverflow;
    if (shell) shell.inert = originalInert;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  };
}
