import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = JSON.parse(readFileSync(path.join(root, "src/assets/branding/lantern.json"), "utf8"));
const { navy, cream, ochre } = source.palette;
const assets = path.join(root, "public/assets/branding");
const pack = path.join(root, "output/branding/museamo-logo-pack");
const res = path.join(root, "android/app/src/main/res");
const write = (name, contents) => { mkdirSync(path.dirname(name), { recursive: true }); writeFileSync(name, contents + "\n"); };
const svg = (width, height, body, description) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">Museamo</title><desc id="desc">${description}</desc>${body}</svg>`;
const mark = (ink, flame = ochre) => `<g fill="${ink}">${source.mark.frame.map(d => `<path d="${d}"/>`).join("")}</g><path fill="${flame}" fill-rule="evenodd" d="${source.mark.flame}"/>`;
let wordWidth = 0;
const letterPaths = [...source.wordmark.letters].map((letter, i) => {
  const glyph = source.wordmark.glyphs[letter], x = wordWidth;
  wordWidth += glyph.width + (i < source.wordmark.letters.length - 1 ? source.wordmark.tracking : 0);
  return `<path transform="translate(${x} 0)" fill-rule="evenodd" d="${glyph.path}"/>`;
}).join("");
const word = ink => `<g fill="${ink}">${letterPaths}</g>`;
const horizontal = (ink, flame = ochre) => `<g transform="translate(10 8) scale(.224)">${mark(ink, flame)}</g><g transform="translate(98 22) scale(.96)">${word(ink)}</g>`;
const stacked = (ink, flame = ochre) => `<g transform="translate(160 12) scale(.6)">${mark(ink, flame)}</g><g transform="translate(38 324) scale(1.198)">${word(ink)}</g>`;
const icon = (rounded = true) => svg(512, 512, `<rect width="512" height="512"${rounded ? ' rx="88"' : ""} fill="${navy}"/><g transform="translate(116.8 54.16) scale(.87)">${mark(cream)}</g>`, "Carved lantern app icon; cream and ochre on navy.");
const foreground = (monochrome = false) => svg(108, 108, `<g transform="translate(33.84 24.768) scale(.126)">${mark(monochrome ? "#FFFFFF" : cream, monochrome ? "#FFFFFF" : ochre)}</g>`, "Android adaptive-icon foreground, contained within the central safe circle.");
const exported = {
  "mark-on-dark.svg": svg(320, 464, mark(cream), "Carved lantern mark for navy and other dark surfaces."),
  "mark-on-light.svg": svg(320, 464, mark(navy), "Carved lantern mark for cream and other light surfaces."),
  "mark-mono-cream.svg": svg(320, 464, mark(cream, cream), "Single-color cream lantern, with transparent negative space."),
  "mark-mono-ink.svg": svg(320, 464, mark(navy, navy), "Single-color navy lantern, with transparent negative space."),
  "wordmark-on-dark.svg": svg(wordWidth, 80, word(cream), "MUSEAMO in original outlined poster lettering, for dark surfaces."),
  "wordmark-on-light.svg": svg(wordWidth, 80, word(navy), "MUSEAMO in original outlined poster lettering, for light surfaces."),
  "logo-horizontal-on-dark.svg": svg(460, 120, horizontal(cream), "Horizontal lantern and outlined MUSEAMO wordmark, for dark surfaces."),
  "logo-horizontal-on-light.svg": svg(460, 120, horizontal(navy), "Horizontal lantern and outlined MUSEAMO wordmark, for light surfaces."),
  "logo-stacked-on-dark.svg": svg(512, 448, stacked(cream), "Stacked lantern and outlined MUSEAMO wordmark, for dark surfaces."),
  "logo-stacked-on-light.svg": svg(512, 448, stacked(navy), "Stacked lantern and outlined MUSEAMO wordmark, for light surfaces."),
  "logo-horizontal-mono-cream.svg": svg(460, 120, horizontal(cream, cream), "Single-color cream horizontal logo."),
  "logo-horizontal-mono-ink.svg": svg(460, 120, horizontal(navy, navy), "Single-color navy horizontal logo."),
  "logo-stacked-mono-cream.svg": svg(512, 448, stacked(cream, cream), "Single-color cream stacked logo."),
  "logo-stacked-mono-ink.svg": svg(512, 448, stacked(navy, navy), "Single-color navy stacked logo."),
  "app-icon.svg": icon(),
  "app-icon-square.svg": icon(false),
  "android-background.svg": svg(108, 108, `<path fill="${navy}" d="M0 0H108V108H0Z"/>`, "Navy adaptive-icon background."),
  "android-foreground.svg": foreground(),
  "android-monochrome.svg": foreground(true),
};
for (const [name, contents] of Object.entries(exported)) {
  write(path.join(assets, name), contents);
  write(path.join(pack, "svg", name), contents);
}
const vectorPaths = (ink, flame = ink) => source.mark.frame.map(d => `    <path android:fillColor="${ink}" android:pathData="${d}"/>`).join("\n") + `\n    <path android:fillColor="${flame}" android:fillType="evenOdd" android:pathData="${source.mark.flame}"/>`;
const vector = (size, viewport, contents) => `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="${size}dp" android:height="${size}dp" android:viewportWidth="${viewport}" android:viewportHeight="${viewport}">\n${contents}\n</vector>`;
const adaptiveVector = monochrome => vector(108, 108, `  <group android:translateX="33.84" android:translateY="24.768" android:scaleX=".126" android:scaleY=".126">\n${vectorPaths(monochrome ? "#FFFFFF" : cream, monochrome ? "#FFFFFF" : ochre)}\n  </group>`);
const nativeFiles = {
  "drawable/museamo_icon.xml": vector(108, 108, `  <path android:fillColor="${navy}" android:pathData="M0 0H108V108H0Z"/>\n  <group android:translateX="24.6375" android:translateY="11.424" android:scaleX=".1836" android:scaleY=".1836">\n${vectorPaths(cream, ochre)}\n  </group>`),
  "drawable/museamo_launcher_foreground.xml": adaptiveVector(false),
  "drawable/museamo_launcher_monochrome.xml": adaptiveVector(true),
  "drawable/widget_open_app.xml": vector(24, 464, `  <group android:translateX="72">\n${vectorPaths("@color/widget_text")}\n  </group>`),
  "values/ic_launcher_background.xml": `<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="ic_launcher_background">${navy}</color></resources>`,
};
for (const [name, contents] of Object.entries(nativeFiles)) {
  write(path.join(res, name), contents);
  write(path.join(pack, "android-vector", name), contents);
}
for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
  for (const api of [26, 33]) {
    const contents = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@color/ic_launcher_background"/>\n  <foreground android:drawable="@drawable/museamo_launcher_foreground"/>${api === 33 ? '\n  <monochrome android:drawable="@drawable/museamo_launcher_monochrome"/>' : ""}\n</adaptive-icon>`;
    write(path.join(res, `mipmap-anydpi-v${api}`, name), contents);
    write(path.join(pack, "android-vector", `mipmap-anydpi-v${api}`, name), contents);
  }
}
const preview = svg(1200, 1200, `<rect width="1200" height="1200" fill="${navy}"/><g transform="translate(344 24)">${stacked(cream)}</g><g transform="translate(92 560) scale(1.2)">${horizontal(cream)}</g><g transform="translate(940 548) scale(.34)">${icon()}</g><path fill="${cream}" d="M0 760H1200V1200H0Z"/><g transform="translate(54 806) scale(1.85)">${horizontal(navy)}</g><g transform="translate(956 822) scale(.32)">${icon()}</g><g transform="translate(300 1060) scale(.16)">${mark(navy, navy)}</g><g transform="translate(410 1060) scale(.16)">${mark(navy)}</g><g transform="translate(520 1060) scale(.16)">${mark(navy)}</g><g transform="translate(654 1090) scale(.5)">${word(navy)}</g>`, "Museamo production SVG logo pack: stacked, horizontal, app icon and single-color treatments.");
write(path.join(pack, "preview.svg"), preview);
write(path.join(pack, "source.json"), JSON.stringify(source, null, 2));
write(path.join(pack, "platform-manifest.json"), JSON.stringify({ default: "svg/app-icon.svg", bg_color: navy, android_bg: "svg/android-background.svg", android_fg: "svg/android-foreground.svg", android_fg_scale: 100, android_monochrome: "svg/android-monochrome.svg" }, null, 2));
write(path.join(pack, "README.txt"), `MUSEAMO / CARVED LANTERN\n\nSelected concept: E1, rebuilt as clean filled vector paths.\n\nUse *-on-dark.svg on navy surfaces: cream lettering and frame, ochre flame.\nUse *-on-light.svg on paper surfaces: navy lettering and frame, ochre flame.\nThe mono marks use one ink and real transparent negative space.\nHorizontal logos are intended for headers; stacked logos for larger placements.\nApp icons have navy backgrounds. Android foregrounds include safe padding.\n\nAll logo lettering is custom outlined geometry. No fonts, embedded raster images, network assets, gradients or filters are required. Optional paper texture belongs on the host surface, separate from the logo.\n\nKeep clear space around the mark, at least the width of one lantern side post. Avoid stretching or clipping the handle. For tiny header/tray uses, prefer the mark alone.\n\nMaster geometry: src/assets/branding/lantern.json\nRegenerate SVGs and native drawables: node scripts/generate-branding.mjs\nRegenerate platform PNG/ICO/ICNS exports too: node scripts/generate-branding.mjs --platform-icons\nThe platform export step uses the project's already-installed Tauri CLI.\n`);

if (process.argv.includes("--platform-icons")) {
  const cli = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
  const platformDir = path.join(pack, "platform-icons");
  const generate = args => {
    const result = spawnSync(process.execPath, [cli, "icon", ...args], { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Platform icon export failed (${result.status}).`);
  };
  generate([path.join(pack, "platform-manifest.json"), "--output", platformDir]);
  for (const name of readdirSync(platformDir).filter(name => /\.(png|ico|icns)$/.test(name))) copyFileSync(path.join(platformDir, name), path.join(root, "desktop/icons", name));
  const android = path.join(platformDir, "android");
  for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
    const dir = path.join(android, `mipmap-${density}`);
    if (!existsSync(dir)) throw new Error(`Missing generated Android icons: ${dir}`);
    for (const name of readdirSync(dir).filter(name => name.endsWith(".png"))) copyFileSync(path.join(dir, name), path.join(res, `mipmap-${density}`, name));
  }
  const png = path.join(pack, "png");
  generate([path.join(assets, "app-icon.svg"), "--output", png, "--png", "32", "--png", "180", "--png", "512"]);
  copyFileSync(path.join(png, "32x32.png"), path.join(assets, "favicon-32.png"));
  copyFileSync(path.join(png, "180x180.png"), path.join(assets, "apple-touch-icon.png"));
}
console.log(`Museamo SVG pack: ${pack}`);
