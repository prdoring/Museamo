import { Component, createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { animateFeedUpdate, type FeedUpdate } from "../feedMotion";

const Exiting = createContext(false);
export const useExiting = () => useContext(Exiting);
export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export const motion = { feedback: 120, exit: 160, enter: 180, layout: 200, ease: "cubic-bezier(.2,.7,.2,1)" };

/** Cancels on a live OS preference change, not just on the next render. */
export function animateElement(element: HTMLElement, frames: Keyframe[], duration = motion.enter) {
  if (reducedMotion() || !element.animate) return () => {};
  const animation = element.animate(frames, { duration, easing: motion.ease });
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const cancel = () => { animation.cancel(); preference.removeEventListener("change", changed); };
  const changed = () => { if (preference.matches) cancel(); };
  preference.addEventListener("change", changed);
  void animation.finished.then(() => preference.removeEventListener("change", changed), () => preference.removeEventListener("change", changed));
  return cancel;
}

/** Keep closing surfaces mounted until their exit finishes, including portal content. */
export function Presence({ children, duration = motion.exit }: { children: ReactNode; duration?: number }) {
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
    const timer = window.setTimeout(remove, duration);
    return () => { window.clearTimeout(timer); preference.removeEventListener("change", finish); };
  }, [visible, retained, duration]);
  return <Exiting.Provider value={!visible}>{visible ? children : retained ? last.current : null}</Exiting.Provider>;
}

/** Animate a view change without remounting its editor, map, or feed state. */
export function PageMotion({ view, ready = true, searchKey = "", children }: { view: string; ready?: boolean; searchKey?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef({ view, searchKey });
  useLayoutEffect(() => {
    if (!ready || !ref.current) return;
    const navigation = previous.current.view !== view;
    const search = previous.current.searchKey !== searchKey;
    previous.current = { view, searchKey };
    if (!navigation && !search) return;
    return animateElement(ref.current, navigation
      ? [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }]
      : [{ opacity: .5 }, { opacity: 1 }], navigation ? motion.enter : motion.feedback);
  }, [view, ready, searchKey]);
  return <div ref={ref} className="page-motion">{children}</div>;
}

export function Disclosure({ children }: { children: ReactNode }) {
  const exiting = useExiting();
  return <div className="motion-disclosure" data-exiting={exiting} inert={exiting} aria-hidden={exiting || undefined}><div>{children}</div></div>;
}

export type MotionItem = { key: string; content: ReactNode };
type ListProps = { items: MotionItem[]; scope: string; reason?: FeedUpdate; beforeLayout?: () => void; className?: string; empty?: ReactNode };
type ListState = { source: MotionItem[]; scope: string; items: MotionItem[]; exiting: Set<string> };
type Box = { top: number; left: number; height: number; width: number; viewportTop: number; visible: boolean };

/** Retains keyed children on removal; surviving posts, editors and players never remount. */
export class MotionList extends Component<ListProps, ListState, Map<string, Box>> {
  state: ListState = { source: this.props.items, scope: this.props.scope, items: this.props.items, exiting: new Set() };
  private nodes = new Map<string, HTMLDivElement>();
  private boxes = new Map<string, Box>();
  private timers = new Map<string, number>();
  private animations = new Map<string, () => void>();
  private preference: MediaQueryList | undefined;
  static getDerivedStateFromProps(props: ListProps, state: ListState): ListState | null {
    if (props.items === state.source && props.scope === state.scope) return null;
    if (props.scope !== state.scope || !animateFeedUpdate(props.reason ?? "mutation") || reducedMotion())
      return { source: props.items, scope: props.scope, items: props.items, exiting: new Set() };
    const keys = new Set(props.items.map(item => item.key));
    const items = [...props.items], exiting = new Set<string>();
    state.items.forEach((item, index) => {
      if (!keys.has(item.key)) { items.splice(Math.min(index, items.length), 0, item); exiting.add(item.key); }
    });
    return { source: props.items, scope: props.scope, items, exiting };
  }
  private measure() {
    const boxes = new Map<string, Box>();
    this.nodes.forEach((node, key) => {
      const rect = node.getBoundingClientRect();
      boxes.set(key, { top: node.offsetTop, left: node.offsetLeft, width: node.offsetWidth, height: node.offsetHeight,
        viewportTop: rect.top, visible: rect.bottom > 0 && rect.top < window.innerHeight });
    });
    return boxes;
  }
  private reduce = () => {
    if (!this.preference?.matches) return;
    this.animations.forEach(cancel => cancel()); this.animations.clear();
    this.timers.forEach(timer => window.clearTimeout(timer)); this.timers.clear();
    this.setState({ items: this.props.items, exiting: new Set() });
  };
  componentDidMount() {
    this.boxes = this.measure();
    this.preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.preference.addEventListener("change", this.reduce);
  }
  getSnapshotBeforeUpdate() { return this.measure(); }
  componentDidUpdate(previous: ListProps, _state: ListState, before: Map<string, Box>) {
    this.props.beforeLayout?.();
    const changed = previous.items !== this.props.items;
    const animate = changed && previous.scope === this.props.scope && animateFeedUpdate(this.props.reason ?? "mutation") && !reducedMotion();
    this.nodes.forEach((node, key) => {
      const old = before.get(key);
      if (this.state.exiting.has(key)) {
        if (this.timers.has(key)) return;
        node.querySelectorAll("video").forEach(video => video.pause());
        const remove = () => {
          this.timers.delete(key); this.animations.get(key)?.(); this.animations.delete(key);
          this.setState(state => ({ items: state.items.filter(item => item.key !== key), exiting: new Set([...state.exiting].filter(id => id !== key)) }));
        };
        if (!animate || !old?.visible) { this.timers.set(key, window.setTimeout(remove, 0)); return; }
        this.animations.get(key)?.();
        this.animations.set(key, animateElement(node, [{ opacity: 1 }, { opacity: 0, transform: "translateY(-4px)" }], motion.exit));
        this.timers.set(key, window.setTimeout(remove, motion.exit));
        return;
      }
      const timer = this.timers.get(key);
      if (timer !== undefined) { window.clearTimeout(timer); this.timers.delete(key); }
      if (!changed && timer === undefined) return;
      if (timer === undefined && old && old.top === node.offsetTop && old.left === node.offsetLeft && old.height === node.offsetHeight && previous.scope === this.props.scope) return;
      this.animations.get(key)?.(); this.animations.delete(key);
      if (!animate) return;
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) return;
      if (!old || timer !== undefined) {
        this.animations.set(key, animateElement(node, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }]));
      } else {
        const delta = old.viewportTop - rect.top;
        const horizontal = old.left - node.offsetLeft;
        if (Math.abs(delta) > .5 || Math.abs(horizontal) > .5 || Math.abs(old.height - node.offsetHeight) > .5) {
          const clip = Math.max(0, 1 - old.height / Math.max(1, node.offsetHeight)) * 100;
          this.animations.set(key, animateElement(node, [
            { transform: `translate(${horizontal}px, ${delta}px)`, clipPath: `inset(0 0 ${clip}% 0)` },
            { transform: "none", clipPath: "inset(0)" },
          ], motion.layout));
        }
      }
    });
    // Scope replacement can unmount an exiting node before its timeout fires.
    this.timers.forEach((timer, key) => { if (!this.nodes.has(key)) { window.clearTimeout(timer); this.timers.delete(key); } });
    this.animations.forEach((cancel, key) => { if (!this.nodes.has(key)) { cancel(); this.animations.delete(key); } });
    this.boxes = this.measure();
  }
  componentWillUnmount() {
    this.preference?.removeEventListener("change", this.reduce);
    this.timers.forEach(timer => window.clearTimeout(timer));
    this.animations.forEach(cancel => cancel());
  }
  render() {
    const onlyExits = this.state.items.length > 0 && this.state.items.every(item => this.state.exiting.has(item.key));
    const minHeight = onlyExits ? Math.max(0, ...[...this.boxes.values()].map(box => box.top + box.height)) : undefined;
    return <div className={`motion-list ${this.props.className ?? ""}`} style={{ minHeight }}>{!this.state.items.length && this.props.empty}{this.state.items.map(item => {
      const exiting = this.state.exiting.has(item.key), box = this.boxes.get(item.key);
      return <div key={item.key} className="motion-row" data-motion-key={item.key} data-exiting={exiting}
        ref={node => { if (node) this.nodes.set(item.key, node); else this.nodes.delete(item.key); }}
        inert={exiting} aria-hidden={exiting || undefined}
        style={exiting && box ? { position: "absolute", top: box.top, left: box.left, width: box.width, height: box.height } : undefined}>
        <Exiting.Provider value={exiting}>{item.content}</Exiting.Provider>
      </div>;
    })}</div>;
  }
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
