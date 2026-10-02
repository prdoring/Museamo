import { Presence } from "./Motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../data";
import { mediaLinks, type Attachment, type MediaLink } from "../media";
import { PhotoViewer } from "./PhotoViewer";
import { ImagePlus, X } from "lucide-react";
import { createPortal } from "react-dom";

function useVisible() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let intersects = false;
    const update = () => setVisible(intersects && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { intersects = entry.isIntersecting; update(); });
    if (ref.current) observer.observe(ref.current);
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  return { ref, visible };
}
function Video({ url, poster, failed }: { url: string; poster?: string; failed: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const pause = () => { if (document.hidden) video.current?.pause(); };
    document.addEventListener("visibilitychange", pause);
    return () => document.removeEventListener("visibilitychange", pause);
  }, []);
  return <video ref={video} src={url} poster={poster} controls playsInline preload="metadata" onError={failed} />;
}
function EmbeddedVideo({ url, failed }: { url: string; failed: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const failure = useRef(failed);
  failure.current = failed;
  useEffect(() => {
    if (loaded) return;
    const timer = window.setTimeout(() => failure.current(), 20000);
    return () => window.clearTimeout(timer);
  }, [loaded]);
  return <iframe src={url} title={url.includes("youtube") ? "YouTube video" : "Vimeo video"}
    onLoad={() => setLoaded(true)} onError={() => failure.current()}
    allow="fullscreen; picture-in-picture; encrypted-media" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />;
}
function MediaItem({ attachment, link, open }: { attachment?: Attachment; link?: MediaLink; open?: (url: string) => void }) {
  const { ref, visible } = useVisible();
  const [resolved, setResolved] = useState<{ url: string; thumbnailUrl?: string; availability?: "available" | "pending" | "unsupported" }>();
  const [error, setError] = useState(false);
  const kind = attachment?.kind || link!.kind;
  useEffect(() => {
    if (!visible || !attachment || resolved) return;
    let alive = true;
    void bridge.resolveMedia({ id: attachment.id }).then(r => { if (alive) setResolved(r); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [visible, attachment, resolved]);
  useEffect(() => {
    if (!visible || !attachment || resolved?.availability !== "pending") return;
    const timer = window.setTimeout(() => setResolved(undefined), 5000);
    return () => clearTimeout(timer);
  }, [visible, attachment, resolved]);
  const url = resolved?.url || link?.url;
  const picture = <img src={resolved?.thumbnailUrl || url} alt={attachment?.filename || "Linked photo"} onError={() => setError(true)} />;
  return <div ref={ref} className={`media-item media-${kind}`}>
    <div className="media-content">
    {visible && url && !error && (kind === "image" ?
      (open ? <button className="media-photo" aria-label={`View ${attachment?.filename || "linked photo"}`} onClick={() => open(url)}>{picture}</button> : picture)
      : kind === "video" ? <Video url={url} poster={resolved?.thumbnailUrl} failed={() => setError(true)} /> :
        <EmbeddedVideo url={url} failed={() => setError(true)} />)}
    {!visible && <span className="muted">{kind === "image" ? "Photo" : "Video"}</span>}
    {visible && resolved?.availability === "pending" && <p className="media-error" role="status">Original waiting to sync. Connect a linked device with this attachment.</p>}
    {visible && resolved?.availability === "unsupported" && <p className="media-error" role="status">The original is saved, but this device cannot preview its format.</p>}
    </div>
    {error && <p className="media-error" role="status">{attachment ? "Could not preview this original. It stays in your library and backups." : "Media unavailable. Check your connection or try a supported file format."} <button onClick={() => { setError(false); setResolved(undefined); }}>Retry</button></p>}
    {link && <button className="text-button" onClick={() => void bridge.openExternal({ url: link.source }).catch(() => setError(true))}>Open original link</button>}
  </div>;
}

export function MediaGallery({ attachments = [], text = "" }: { attachments?: Attachment[]; text?: string }) {
  const links = useMemo(() => mediaLinks(text), [text]);
  const [viewing, setViewing] = useState<number>();
  const images = useMemo(() => [...attachments.filter(a => a.kind === "image"), ...links.filter(l => l.kind === "image")], [attachments, links]);
  function show(index: number) { setViewing(index); }
  return <>
    <div className="media-grid">
      {attachments.map(a => <MediaItem key={a.id} attachment={a} open={() => void show(images.indexOf(a))} />)}
      {links.map(l => <MediaItem key={l.url} link={l} open={() => void show(images.indexOf(l))} />)}
    </div>
    <Presence>{viewing !== undefined && <PhotoViewer images={images} initial={viewing} close={() => setViewing(undefined)} />}</Presence>
  </>;
}

export function AttachmentEditor({ attachments, disabled, change, report, importing, retain, toolbar }: {
  attachments: Attachment[]; disabled: boolean; change: (items: Attachment[]) => void;
  report: (message: string) => void; importing: (busy: boolean) => void;
  retain: (ids: string[]) => void; toolbar: HTMLElement | null;
}) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function pick() {
    importing(true); report("");
    try {
      const result = await bridge.pickMedia({ remaining: 10 - attachments.length });
      retain(result.attachments.map(a => a.id));
      if (mounted.current) change([...attachments, ...result.attachments]);
      else await bridge.releaseMedia({ ids: result.attachments.map(a => a.id) });
    } catch (e) { if (mounted.current) report(e instanceof Error ? e.message : "Could not import media. Try again."); }
    finally { if (mounted.current) importing(false); }
  }
  return <div className="attachment-editor">
    {toolbar && createPortal(<button className="composer-icon" type="button" aria-label="Attach photos/videos" title="Attach photos/videos" disabled={disabled || attachments.length >= 10} onClick={() => void pick()}><ImagePlus size={22} /></button>, toolbar)}
    <div className="attachment-rail">
      {attachments.map(a => <div className="attachment-tile" key={a.id}>
        <AttachmentThumbnail attachment={a} />
        <button className="attachment-remove" type="button" disabled={disabled} aria-label={`Remove ${a.filename}`} onClick={() => change(attachments.filter(item => item.id !== a.id))}><X size={17} /></button>
      </div>)}
    </div>
  </div>;
}
function AttachmentThumbnail({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let alive = true;
    void bridge.resolveMedia({ id: attachment.id }).then(r => { if (alive) setUrl(r.thumbnailUrl || (attachment.kind === "image" ? r.url : "")); }).catch(() => {});
    return () => { alive = false; };
  }, [attachment.id, attachment.kind]);
  return <>{url ? <img src={url} alt={attachment.filename} /> : <span>{attachment.kind === "video" ? "Video" : "Photo"}</span>}{attachment.kind === "video" && <span className="attachment-video-badge">Video</span>}</>;
}
