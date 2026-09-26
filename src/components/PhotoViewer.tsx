import { useExiting, lockOverlay } from "./Motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { bridge } from "../data";
import type { Attachment, MediaLink } from "../media";

type Point = { x: number; y: number };
type Transform = Point & { scale: number };
const identity: Transform = { x: 0, y: 0, scale: 1 };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function PhotoViewer({ images, initial, close }: { images: (Attachment | MediaLink)[]; initial: number; close: () => void }) {
  const exiting = useExiting();
  const [dragging, setDragging] = useState(false);
  const [index, setIndex] = useState(initial);
  const [url, setUrl] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [transform, setTransform] = useState(identity);
  const current = useRef(identity);
  const stage = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef({ start: identity, points: [] as Point[], swiping: false });
  const lastTap = useRef({ time: 0, point: { x: 0, y: 0 } });
  const callbacks = useRef({ close, index });
  callbacks.current = { close: exiting ? () => {} : close, index };
  function update(value: Transform) { current.current = value; setTransform(value); }
  function bounded(value: Transform): Transform {
    const area = stage.current, img = picture.current;
    if (!area || !img?.naturalWidth) return identity;
    const fit = Math.min(area.clientWidth / img.naturalWidth, area.clientHeight / img.naturalHeight);
    const maxX = Math.max(0, (img.naturalWidth * fit * value.scale - area.clientWidth) / 2);
    const maxY = Math.max(0, (img.naturalHeight * fit * value.scale - area.clientHeight) / 2);
    return { scale: value.scale, x: Math.max(-maxX, Math.min(maxX, value.x)), y: Math.max(-maxY, Math.min(maxY, value.y)) };
  }
  function zoom(point: Point) {
    const area = stage.current!.getBoundingClientRect();
    update(current.current.scale > 1 ? identity : bounded({ scale: 2.5, x: -(point.x - area.left - area.width / 2) * 1.5, y: -(point.y - area.top - area.height / 2) * 1.5 }));
  }
  useEffect(() => {
    let alive = true;
    setUrl(""); setReady(false); setError(""); update(identity); lastTap.current.time = 0;
    const image = images[index];
    void ("id" in image ? bridge.resolveMedia({ id: image.id }) : Promise.resolve({ url: image.url }))
      .then(result => { if (alive) setUrl(result.url); }).catch(() => { if (alive) setError("This photo is unavailable."); });
    return () => { alive = false; };
  }, [index, images]);
  useEffect(() => {
    const unlock = lockOverlay();
    dialog.current?.focus();
    const back = (event?: Event) => { event?.preventDefault(); callbacks.current.close(); };
    const resize = () => update(identity);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") back();
      if (e.key === "ArrowRight") setIndex(i => Math.min(images.length - 1, i + 1));
      if (e.key === "ArrowLeft") setIndex(i => Math.max(0, i - 1));
      if (e.key === "+" || e.key === "=") update(bounded({ ...current.current, scale: Math.min(5, current.current.scale + .5) }));
      if (e.key === "-") update(bounded({ ...current.current, scale: Math.max(1, current.current.scale - .5) }));
      if (e.key === "0") update(identity);
      if (e.key === "Tab") { e.preventDefault(); dialog.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
    };
    document.addEventListener("keydown", key);
    window.addEventListener("museamoBack", back);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("keydown", key); window.removeEventListener("museamoBack", back);
      window.removeEventListener("resize", resize);
      unlock();
    };
  }, [images.length]);
  return createPortal(<div className="photo-lightbox" data-exiting={exiting} inert={exiting} role="dialog" aria-modal="true" aria-label="Photo viewer" tabIndex={-1} ref={dialog}>
    <header className="photo-lightbox-header"><span aria-live="polite">{index + 1} / {images.length}</span><button aria-label="Close photo viewer" onClick={close}><X size={24} /></button></header>
    <div className="photo-stage" data-dragging={dragging} ref={stage}
      onPointerDown={e => {
        setDragging(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        gesture.current = { start: current.current, points: [...pointers.current.values()], swiping: pointers.current.size === 1 && current.current.scale === 1 };
      }}
      onPointerMove={e => {
        if (!pointers.current.has(e.pointerId)) return;
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const points = [...pointers.current.values()], { start, points: base } = gesture.current;
        if (points.length >= 2 && base.length >= 2) {
          const scale = Math.max(1, Math.min(5, start.scale * distance(points[0], points[1]) / Math.max(1, distance(base[0], base[1]))));
          const a = middle(base[0], base[1]), b = middle(points[0], points[1]);
          const rect = e.currentTarget.getBoundingClientRect(), ratio = scale / start.scale;
          update(bounded({ scale, x: (start.x - (a.x - rect.left - rect.width / 2)) * ratio + b.x - rect.left - rect.width / 2, y: (start.y - (a.y - rect.top - rect.height / 2)) * ratio + b.y - rect.top - rect.height / 2 }));
        } else if (points.length === 1 && base.length === 1) {
          const value = { ...start, x: start.x + points[0].x - base[0].x, y: start.y + points[0].y - base[0].y };
          update(gesture.current.swiping ? { ...value, y: 0 } : bounded(value));
        }
      }}
      onPointerUp={e => {
        const g = gesture.current;
        const start = g.points[0];
        const delta = start ? e.clientX - start.x : 0;
        const tap = start && distance(start, { x: e.clientX, y: e.clientY }) < 10 && g.points.length === 1;
        pointers.current.delete(e.pointerId);
        if (pointers.current.size) { gesture.current = { start: current.current, points: [...pointers.current.values()], swiping: false }; lastTap.current.time = 0; return; }
        setDragging(false);
        if (g.swiping && Math.abs(delta) > Math.min(80, e.currentTarget.clientWidth * .2)) {
          setIndex(i => Math.max(0, Math.min(images.length - 1, i + (delta < 0 ? 1 : -1)))); update(identity);
        } else {
          update(bounded(current.current));
          if (tap) {
            const point = { x: e.clientX, y: e.clientY }, now = Date.now();
            if (now - lastTap.current.time < 300 && distance(point, lastTap.current.point) < 30) { zoom(point); lastTap.current.time = 0; }
            else lastTap.current = { time: now, point };
          }
        }
      }}
      onPointerCancel={() => { setDragging(false); pointers.current.clear(); update(bounded(current.current)); }}
      onWheel={e => {
        const scale = Math.max(1, Math.min(5, current.current.scale - e.deltaY * .005));
        update(bounded({ ...current.current, scale }));
      }}>
      {url && !error && <img key={url} ref={picture} data-ready={ready} onLoad={() => setReady(true)} draggable={false} src={url} alt={"filename" in images[index] ? (images[index] as Attachment).filename : "Linked photo"} onError={() => setError("Could not display this photo.")} style={{ transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})` }} />}
      {error ? <p role="alert">{error}</p> : !ready && <p role="status">Loading photo…</p>}
    </div>
  </div>, document.body);
}
