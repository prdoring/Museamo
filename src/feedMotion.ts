export type FeedUpdate = "initial" | "navigation" | "search" | "pagination" | "mutation" | "refresh";
export const animateFeedUpdate = (reason: FeedUpdate) => reason === "pagination" || reason === "mutation" || reason === "refresh";

/** offset geometry is unaffected by in-flight FLIP or page transforms. */
export function layoutTop(element: HTMLElement) {
  let top = 0;
  for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null) top += node.offsetTop;
  return top;
}
export type ReadingAnchor = { id?: string; top?: number; scroll: number };
export function captureReadingAnchor(excludeId?: string): ReadingAnchor {
  const header = document.documentElement.dataset.layout === "desktop" ? 52 : 0;
  const element = [...document.querySelectorAll<HTMLElement>("[data-entry-id]")].find(node =>
    node.dataset.entryId !== excludeId && !node.closest('[data-exiting="true"]') && node.getBoundingClientRect().bottom > header);
  return { id: element?.dataset.entryId, top: element ? layoutTop(element) - window.scrollY : undefined, scroll: window.scrollY };
}
export function restoreReadingAnchor(anchor: ReadingAnchor) {
  const element = anchor.id ? document.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(anchor.id)}"]`) : null;
  window.scrollTo(0, element && anchor.top !== undefined ? layoutTop(element) - anchor.top : anchor.scroll);
}
