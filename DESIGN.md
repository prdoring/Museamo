# Museamo design system

Museamo is a private feed: newest thoughts first, immediate capture, useful review. Writing is the primary content. No avatars, social counters, hero slogans, decorative dashboards, or chat-bubble alignment.

## Printed paper and ink

Adapted from ../newwebsite/WPA_STYLE_GUIDE.md and its production DESIGN.md. The existing capture/feed interaction model remains authoritative.

| Role | Light | Dark |
| --- | --- | --- |
| Surrounding stock | #E7D6AD | #0B1F26 |
| Reading surface | #F4E7C7 | #12303A |
| Primary ink | #12303A | #F4E7C7 |
| Thought text | #262A27 | #F4E7C7 |
| Muted text | #4A554C | #C3BDA5 |
| Links/actions | #A9412B | #D3922E |
| Primary button text | #F4E7C7 | #12303A |
| Selected fill/text | #A9412B / #F4E7C7 | #A9412B / #F4E7C7 |
| Navigation fill/text | #12303A / #F4E7C7 | #12303A / #F4E7C7 |
| Stars | #765000 | #D3922E |
| Errors | #A9412B | #FFAE98 |

Trailhead Clean: 24px mastheads, 22px sheet and section headings. Dynamic tag titles use DM Sans in natural case. Source Serif 4 regular/semibold: 17px thoughts, composition and preview, 1.55 web line height. DM Sans: controls, metadata and settings. Widgets use the launcher font. Font sources are bundled in full, with generic fallbacks for characters outside each font. Italic thought text permits synthetic slant; bold uses the supplied semibold face.

Use the actual neutral construction-paper tile for surrounding stock, dock and sheet chrome at 768px; use the ink tile at 320px for navy bands and dark stock. Reading surfaces use quiet grain at 4% in light mode (2.5% web dark), never layered over construction-paper shading. Texture does not paint over control text or intercept input. Native tiles scale with density; RemoteViews keeps an explicit 40dp inner row so bitmap intrinsic dimensions cannot enlarge widgets.

Navigation is a rectangular navy band with brick selected items and cream labels. Controls have 4px corners; structural panels are square; sheets have 12px corners. Widgets are borderless paper strips with a 4dp outer inset; launcher rounding must never cut through a contrasting frame. Fields have 2px ink borders, feed entries have fine rules, and day dividers have short brick rules. Keep 16px gutters and 48px app touch targets, with existing 40dp widget targets. Focus has an ink/cream outline and ochre reinforcement. No blurred shadows or decorative arrival animations.

The selected document, star, gear and utility glyphs use scoped geometry through PaperIcon. The original sources and native VectorDrawable adaptations are documented in docs/paper-assets.md. The post star retains its existing outline/filled state; uncovered actions retain clean Lucide glyphs. Do not add portfolio identity, social marks, landscape scenes or Deco ornaments.

Theme values live in src/styles.css and Android day/night resources; src/paper.css holds typography and surface treatments. src/theme.test.ts checks each corresponding semantic role and critical contrast pairs. Production follows the OS preference. The ephemeral browser preview alone offers a system/light/dark switch for visual QA. Never fetch fonts or UI assets at runtime.

## Interaction rules

- Stream, Gems, Tags; newest first. Search stays scoped to the current view.
- Enable Checklist with a single switch in the tag editor. Checklist feeds use compact rows: a 48px checkbox target beside the text, an overflow menu on the right, and no repeated chip for the current category. The menu holds timestamp, location, and Gems actions. Other tags and attachments remain visible. Unchecked items come first, newest first in each group; small Checked/Unchecked headings share a line with the first date, with date dividers for subsequent days. Other views retain chronological order and their existing post metadata. Eligible items have one shared checkbox across the app; completed body text is crossed out, while attachments and actions stay usable. Widget tags show a small checklist-list icon distinct from selection ticks.
- Mixed feeds place the checklist control in the metadata action row beside Gems and the menu. Text, locations, tags, and attachments share the same left edge and full content width for every entry; only dedicated Checklist categories use an indented checkbox column.
- Stream has one checklist-icon toggle button in its existing toolbar, using the same ListChecks icon as Checklist categories. Its accessible label is “To-dos only”; a filled selected state and `aria-pressed` indicate filtering. The filter keeps Stream’s chronological order and includes both checked and unchecked items; it combines with text search and adds no extra filter row.
- A persistent bottom message bar opens capture. Do not focus the keyboard while browsing.
- Post text is selectable. Hashtags and tag chips open tag feeds; ordinary text never enters edit mode.
- Star is optimistic with rollback/retry. Post overflow contains Edit, Copy text, Delete. Each deletion has its own Undo until dismissed during the session.
- Native capture uses a compact bottom surface, visible tags, multiline text, and Send at lower right. Draft discard is secondary. Return only after durable save.
- Fixed-tag and picker widgets have separate capture and tag targets, plus an Open Museamo icon. Setup uses a normal full-screen activity with persistent Cancel/Save controls. Below 260dp the picker becomes `# ▾`; wider widgets show a bounded tag name. Existing drafts keep their selections if widget defaults change.
- Hashtags remain inline. Single words use `#word`; multiword names use `#"Cool words"`. Completion preserves the token; new inline tags are created at save. Explicit tags can be selected without inserting text. Removing an inline tag chip removes the matching tokens.
- Keyboard, navigation, and bottom-system insets must not obscure actions. All sheets restore focus, support dismissal, and preserve unsaved capture. Editing requires a discard decision when changed.

## Thought formatting

Thoughts support bold, italic, bullets, numbered lists, quotes, and HTTP(S) links. The app renders those structures using DM Sans, the existing 17px body size, and theme colors. Imported headings become modest bold text; source fonts, colors, sizes, images, and executable content are not retained. Pasted definitions preserve paragraphs, emphasis, lists, and links when the source supplies HTML or styled clipboard text. Plain-only clipboard content cannot restore formatting the source omitted.

Both editors expose a compact formatting toolbar and a Write/Preview toggle. Editing uses visible Markdown markers; this is not a WYSIWYG editor. Select text before applying bold or italic; list/quote controls affect selected lines. Formatting controls never send a thought. Standard native Paste converts available HTML or styled text; Paste as plain text keeps the platform fallback. Keyboard clipboard suggestions may supply only plain text.

Markdown is stored in the existing text field, keeping draft isolation, IDs, backup version 1, and the Room schema intact. Preserve leading/trailing whitespace on save because indentation and line endings can carry meaning. Older thoughts containing Markdown syntax now render with formatting, but their stored text is not rewritten. Search still queries stored text. Future destination adapters must deliberately choose Markdown, rendered plain text, or the destination's supported format.

Copy text writes semantic HTML plus a readable plain-text fallback. Web clipboard implementations without HTML support receive plain text. No remote content is fetched to render a thought. Native capture continues to operate without a WebView.

Parser references: [react-markdown](https://github.com/remarkjs/react-markdown), [Turndown](https://github.com/mixmark-io/turndown), [Markwon](https://noties.io/Markwon/docs/v4/core/getting-started.html), and [Android clipboard](https://developer.android.com/develop/ui/views/touch-and-input/copy-paste). Browser and Kotlin converters share `test-fixtures/formatting.json`; differences in unsupported HTML structures are not a promise of source-page fidelity.

## State and copy rules

Use direct labels: Message yourself, Send, Add tag, Choose tag, Save widget, Backup. Avoid motivational headings and fake social vocabulary.

Loading is announced; empty libraries and search misses are distinct. Errors stay beside the operation with retry; never imply a failed save succeeded. No confetti or decorative content arrival animations. Navigation fades over 180ms; sheets and photo lightboxes enter in 180ms and exit in 160ms. Search and composer panels expand/collapse over the same interval. Button and star feedback takes 120ms. Web transitions honor reduced motion; native window transitions use Android’s system animation scale.

Browser preview is in-memory and interactive, resets on refresh, and has explicit example/reset/failure tools. Android Room data stays separate. Visual, launcher, keyboard, TalkBack, and latency acceptance require device verification; automated build success is not that evidence.


Composer formatting stays behind a quiet Aa control below the writing field. Web reveals five 20px icons with 48px targets that wrap at narrow widths; Android uses an anchored native menu. Preview sits separately on the same quiet row. No permanent instruction paragraph or scrolling button strip.

Visual composing supersedes the Markdown/Preview interaction: writing displays bold, italic, lists, and quotes directly. Aa applies document formatting; Markdown shortcuts convert while typing. There is no Preview mode. Web uses Tiptap; Android uses editable spans. Markdown remains the saved representation, with no schema or public bridge changes.
