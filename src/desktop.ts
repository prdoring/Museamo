import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { MuseamoBridge } from "./data";

/** Native failures propagate to the app; real libraries never fall back to browser examples. */
export function desktopBridge(): MuseamoBridge {
  return new Proxy({} as MuseamoBridge, {
    get(_target, key: keyof MuseamoBridge) {
      if (key === "addListener") return async (event: string, callback: () => void) => {
        const remove = await listen(event, callback);
        return { remove: async () => remove() };
      };
      return async (input: unknown = {}) => {
        try {
          const result = await invoke("library_command", { method: key, input });
          if (key === "pickMedia") {
            const picked = result as { attachments: import("./media").Attachment[] };
            for (const attachment of picked.attachments) {
              const resolved = await invoke<{ url: string }>("library_command", { method: "resolveMedia", input: { id: attachment.id } });
              try {
                const metadata = await mediaMetadata(attachment.kind, resolved.url);
                Object.assign(attachment, await invoke("library_command", { method: "setMediaMetadata", input: { id: attachment.id, ...metadata } }));
              } catch { /* Preserve the original even if Windows cannot decode it. */ }
            }
          }
          return result;
        }
        catch (error) {
          const message = typeof error === "object" && error && "message" in error ? String(error.message) : String(error);
          const failure = new Error(message);
          if (typeof error === "object" && error) Object.assign(failure, error);
          throw failure;
        }
      };
    },
  });
}

function mediaMetadata(kind: "image" | "video", url: string): Promise<{ width: number; height: number; duration?: number }> {
  return new Promise((resolve, reject) => {
    const element = kind === "image" ? new Image() : document.createElement("video");
    const finish = () => { clearTimeout(timer); element.onload = null; element.onerror = null; if (element instanceof HTMLVideoElement) { element.onloadedmetadata = null; element.removeAttribute("src"); element.load(); } };
    const fail = () => { finish(); reject(new Error("Unsupported media")); };
    const timer = window.setTimeout(fail, 15000);
    element.onerror = fail;
    if (element instanceof HTMLVideoElement) {
      element.preload = "metadata";
      element.onloadedmetadata = () => { const result = { width: element.videoWidth, height: element.videoHeight, duration: element.duration * 1000 }; finish(); resolve(result); };
    } else element.onload = () => { const result = { width: element.naturalWidth, height: element.naturalHeight }; finish(); resolve(result); };
    element.src = url;
  });
}
