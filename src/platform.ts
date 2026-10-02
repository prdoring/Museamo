import { Capacitor } from "@capacitor/core";

export type Platform = "android" | "desktop" | "preview";
declare global { interface Window { __TAURI_INTERNALS__?: unknown } }
export const platform: Platform = Capacitor.isNativePlatform() ? "android"
  : typeof window !== "undefined" && "__TAURI_INTERNALS__" in window ? "desktop" : "preview";
export const isPreview = platform === "preview";
export const isDesktop = platform === "desktop";
export const capabilities = { nativeCapture: platform === "android", widgets: platform === "android", automaticLocation: platform !== "desktop" };
