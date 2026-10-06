import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const art = JSON.parse(await readFile(path.join(root, "src/assets/branding/lantern.json"), "utf8"));
const mark = (ink, flame) => `<g fill="${ink}">${art.mark.frame.map(d => `<path d="${d}"/>`).join("")}</g><path fill="${flame}" fill-rule="evenodd" d="${art.mark.flame}"/>`;
let x = 0;
const letters = [...art.wordmark.letters].map(letter => {
  const glyph = art.wordmark.glyphs[letter], offset = x;
  x += glyph.width + art.wordmark.tracking;
  return `<path transform="translate(${offset} 0)" d="${glyph.path}" fill-rule="evenodd"/>`;
}).join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="480" viewBox="0 0 1600 480" role="img" aria-labelledby="title desc">
<title id="title">Museamo — a place for your thoughts</title>
<desc id="desc">A warm lantern and custom Museamo wordmark on deep navy, with the words Capture. Keep. Rediscover. Android, Windows, macOS, and iOS beta. Local first.</desc>
<rect width="1600" height="480" fill="#12303A"/>
<path d="M80 60H1520M80 420H1520" stroke="#D3922E" stroke-width="2"/>
<g transform="translate(82 95) scale(.55)">${mark("#F4E7C7", "#D3922E")}</g>
<g transform="translate(310 116) scale(2)" fill="#F4E7C7">${letters}</g>
<text x="310" y="332" font-family="Georgia,serif" font-size="40" fill="#F4E7C7">A place for your thoughts.</text>
<text x="310" y="379" font-family="Arial,sans-serif" font-size="19" letter-spacing="2" fill="#D3922E">CAPTURE. KEEP. REDISCOVER.</text>
<path d="M1160 105V380" stroke="#F4E7C7" stroke-opacity=".25"/>
<text x="1220" y="172" font-family="Arial,sans-serif" font-size="18" fill="#F4E7C7" letter-spacing="1">ANDROID + WINDOWS</text>
<text x="1220" y="212" font-family="Arial,sans-serif" font-size="18" fill="#F4E7C7" letter-spacing="1">macOS + iOS BETA</text>
<path d="M1220 246H1460" stroke="#D3922E" stroke-width="3"/>
<text x="1220" y="291" font-family="Arial,sans-serif" font-size="17" fill="#F4E7C7">Your thoughts.</text>
<text x="1220" y="325" font-family="Arial,sans-serif" font-size="17" fill="#F4E7C7">Your devices.</text>
<text x="1220" y="359" font-family="Arial,sans-serif" font-size="17" fill="#F4E7C7">Local first.</text>
</svg>\n`;
await mkdir(path.join(root, "docs/images"), { recursive: true });
await writeFile(path.join(root, "docs/images/banner.svg"), svg);
console.log("Updated docs/images/banner.svg");
