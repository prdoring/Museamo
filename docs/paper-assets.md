# Paper theme asset inventory

Source: `../newwebsite` (copied 2026-09-13). The source repository was not edited. Only the selected assets are included; no runtime paths leave Museamo.

## Textures

`src/assets/wpa/textures/` contains the original filenames:

- `construction-paper-shading.avif` and `.webp`: 768px paper stock, dock, sheet chrome.
- `construction-paper-ink-shading.avif` and `.webp`: 320px navy navigation and dark stock.
- `paper-grain.svg`: quiet reading-field layer, never combined with the shading plate.

Android `drawable-mdpi/paper_shading.webp` and `ink_shading.webp` are byte-for-byte copies of the corresponding WebP files. `paper_grain.png` is a 256px transparent rasterization of the grain SVG with its opaque paper rectangle removed and its charcoal role resolved. Android filenames use underscores as required by the resource compiler. `PaperSurface` owns the host color, density scaling and clipping. Widget drawables use the same tiles; their row height is independent of bitmap intrinsic size.

## Pictograms and utilities

Original standalone files live in `public/assets/wpa/`. `src/components/PaperIcon.tsx` contains only their geometry, without global styles or document IDs. Ink uses currentColor, paper knockouts use the host surface, and small accent dots use the main ink for legibility.

| Original | Placement |
| --- | --- |
| pictograms/document.svg | Stream navigation and empty state |
| pictograms/projects-star.svg | Gems navigation and empty state |
| pictograms/gear.svg | Settings entry |
| utility/plus.svg | Capture and Add tag |
| utility/close.svg | Dismissal and removable tags |
| utility/checkmark.svg | Selected tags |
| utility/chevron-left.svg | Back |
| utility/chevron-right.svg | Tag/settings disclosure |
| utility/chevron-down.svg | Widget picker |
| utility/arrow-right.svg | Send, rotated upward |

Native utility geometry is adapted into `drawable/paper_*.xml`. Existing search, hash, edit, copy, delete, overflow and formatting controls keep their established glyphs. Individual post stars keep the existing toggle treatment.

## Fonts

- `SourceSerif4-Regular.otf.woff2` and `SourceSerif4-Semibold.otf.woff2`: full official source assets from `fonts/SourceSerif4/`, not the portfolio's generated subsets. Native OTF files were decompressed with fontTools without changing glyphs.
- DM Sans is the UI and heading font; Android uses the bundled `dm_sans.ttf` with bold headings.

The SIL Open Font License notices for Source Serif 4 and DM Sans are preserved in `public/fonts/`. Trailhead was removed from distributable source and binaries during public-release preparation because its supplied personal-use notice prohibited sharing the asset. Original files are retained only in the ignored local `output/licensing/` folder. Older verification screenshots may show the previous headings.

## Deliberate exclusions

No full sprite, PRD seal, personal wordmark, social marks, role illustrations, landscape scenes, halftones, misregistration effects or Art Deco assets are copied. Buttons, bands, rules and forms are real UI elements, not SVG pictures of controls.
