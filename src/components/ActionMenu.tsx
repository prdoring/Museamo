import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useExiting } from "./Motion";

export function ActionMenu({ anchor, close, children }: { anchor: RefObject<HTMLButtonElement | null>; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const exiting = useExiting();
  const [position, setPosition] = useState({ top: 60, left: 8 });
  const closeRef = useRef(close); closeRef.current = close;
  const exitingRef = useRef(exiting); exitingRef.current = exiting;
  useLayoutEffect(() => {
    const trigger = anchor.current;
    const menuElement = ref.current;
    const place = () => {
      const bounds = trigger?.getBoundingClientRect(), menu = ref.current;
      if (!bounds || !menu) return;
      const height = menu.offsetHeight;
      setPosition({ left: Math.max(8, Math.min(bounds.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)),
        top: bounds.bottom + height + 8 < window.innerHeight ? bounds.bottom + 4 : Math.max(60, bounds.top - height - 4) });
    };
    place();
    const buttons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    buttons().forEach(button => button.setAttribute("role", "menuitem"));
    buttons()[0]?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (exitingRef.current) return;
      const list = buttons(), index = list.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); }
        closeRef.current();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
        list[next]?.focus();
      }
    };
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) closeRef.current();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true);
      // Do not steal focus from a newly opened editor or an outside-click target.
      if (menuElement?.contains(document.activeElement) || document.activeElement === document.body) {
        const target = trigger?.isConnected && !trigger.closest('[data-exiting="true"]') ? trigger : document.querySelector<HTMLElement>(".toolbar button");
        target?.focus({ preventScroll: true });
      }
    };
  }, [anchor]);
  return createPortal(<div ref={ref} className="action-menu" role="menu" aria-label="Thought actions" data-exiting={exiting}
    aria-hidden={exiting || undefined} inert={exiting} style={position}>{children}</div>, document.body);
}
