import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const [light, darkSection] = css.split("@media (prefers-color-scheme: dark)");
const dark = darkSection.slice(0, darkSection.indexOf("}"));
const previewDark = css.split(':root[data-preview-theme="dark"]')[1];
const roles = { bg: "background", surface: "surface", ink: "text", thought: "thought", muted: "muted", accent: "accent", line: "border", soft: "soft", star: "star", danger: "danger", "action-bg": "action_bg", "action-text": "action_text", "selection-bg": "selection_bg", "selection-text": "selection_text", focus: "focus", "focus-halo": "focus_halo", nav: "nav", "nav-text": "nav_text" };
function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map(part => {
    const n = parseInt(part, 16) / 255;
    return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
  });
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
describe("paper theme", () => {
  it("keeps the browser dark preview identical to the OS dark theme", () => {
    const values = (text: string) => Object.fromEntries([...text.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map(m => [m[1], m[2].toUpperCase()]));
    expect(values(previewDark)).toEqual(values(dark));
  });
  for (const [mode, block] of [["values", light], ["values-night", dark]] as const) {
    const colors = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map(m => [m[1], m[2].toUpperCase()]));
    it(`matches every Android semantic role in ${mode}`, () => {
      const xml = readFileSync(new URL(`../android/app/src/main/res/${mode}/widget.xml`, import.meta.url), "utf8");
      for (const [web, android] of Object.entries(roles)) {
        expect(colors[web], web).toBeTruthy();
        expect(xml.match(new RegExp(`<color name="widget_${android}">(#[0-9A-Fa-f]+)</color>`))?.[1].toUpperCase(), web).toBe(colors[web]);
      }
    });
    it(`keeps text and functional icons legible in ${mode}`, () => {
      for (const [fg, bg, minimum] of [["thought", "surface", 4.5], ["muted", "surface", 4.5], ["muted", "bg", 4.5], ["accent", "surface", 4.5], ["action-text", "action-bg", 4.5], ["selection-text", "selection-bg", 4.5], ["nav-text", "nav", 4.5], ["danger", "surface", 4.5], ["star", "surface", 3]] as const) {
        const a = luminance(colors[fg]), b = luminance(colors[bg]);
        expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05), `${fg} on ${bg}`).toBeGreaterThanOrEqual(minimum);
      }
    });
  }
});
