# UX redesign verification — 2026-09-13

## Automated checks

- TypeScript checks; production Vite build.
- Frontend tests: shared hashtag fixture cases, completion/removal, failed-save preservation, duplicate-save protection, independent drafts, cursor pagination with an intervening save, independent Undo, and theme-token parity.
- Android JVM tests: same hashtag fixtures plus cursor and oversized-token checks.
- Android debug build, lint, and compilation of instrumentation tests.
- No schema change: database remains version 1; existing backup schema remains unchanged.

The native instrumentation suite has been updated for the new UI, but is not run on local hardware or an emulator during this pass. Existing verification reports describe earlier builds and must not be treated as verification of this redesign.

## Physical-device acceptance still required

Use Pixel and Samsung launchers, Gboard/Samsung Keyboard, and both system navigation modes:

- Add fixed and picker widgets at 3×1; resize narrow/wide/tall. Confirm capture and tag targets, long label truncation, light/dark and 200% text. Re-add an old widget if its launcher retains the old footprint.
- Cold launch widget → focused text → Send → home. Measure time to usable keyboard with a screen recording; target under one second. No measurement was taken in this pass.
- Save offline, repeated Send taps, save failure/retry, Back/outside dismissal, rotation and process death. Confirm no lost draft or duplicate entry.
- Two widgets: independent picker selections and drafts. Change default while a draft exists; confirm the draft retains its actual tags. Delete its selected tag; picker falls back to No tag.
- Complete an existing hashtag, a new tag, a quoted multiword tag, and Unicode. Remove a chip; confirm the token does not recreate the assignment.
- Scroll well into old thoughts, capture through a widget, then resume. Confirm reading position is preserved and New thoughts appears.
- Edit an old entry without losing loaded pages; switch tabs and return. Search/filter membership should update correctly.
- Star/unstar, edit and copy, delete two entries and Undo them separately. Verify tag counts and backup round trips with the updated build.
- TalkBack labels/order/focus, reduced motion, system bars, keyboard overlap, and physical tap targets.

## Preview

Start and stop the preview yourself:

```powershell
npm run dev
# Open http://127.0.0.1:5173/ and use a narrow browser viewport.
# Ctrl+C stops the foreground server.
```

Settings → Preview tools offers empty/large libraries and a one-time simulated failure. Preview data never becomes Android data. No preview server or emulator was started by the agent. A generated self-contained local HTML preview was blocked by the browser URL policy, so browser visual checks remain unverified.

## Results for 0.2.0

TypeScript and production build passed. All 17 frontend tests and 4 Android JVM tests passed. Android debug packaging, lint, and instrumentation-test compilation passed. Instrumentation tests were compiled, not executed on a device during this pass.

APK: `artifacts/Museamo-0.2.0-debug.apk`

SHA-256: `4CDC6C1B95F3B6996FA9976D31FBB55AA05E0091AD0677A47386EB37DE811AC8`

The build used a single-use Gradle daemon with Kotlin compilation in-process; the build session exited. No development server or emulator was started.

## Widget/setup and link update — 0.2.1

- Added a separate Open Museamo icon to fixed and picker widgets. Narrow picker widgets omit the decorative capture icon to preserve room for the label.
- Configuration now uses a non-floating activity with a persistent Cancel/Add widget (or Save changes) footer. It returns the widget ID on cancellation, renders the initial widget before returning success, and hides the keyboard before finishing. This addresses likely integration issues; the reported launcher dismissal behavior still needs confirmation on the user's launcher.
- Setup explains “Use the same tags each time” versus “Choose a tag on the widget,” with examples, a labeled preview, and descriptions of defaults versus editable composer tags.
- Saved thoughts automatically link HTTP(S) and www addresses without modifying stored text or fetching previews. Android opens web links through an external activity. Sentence punctuation is excluded; balanced URL parentheses remain intact. Text stays selectable.
- Added link-parser regression tests and instrumentation assertions for the Open app control and non-floating configuration theme. Instrumentation execution still requires a device/emulator.

0.2.1 verification: TypeScript, all 21 frontend tests, 4 Android JVM tests, production build, Android debug build and lint passed. Instrumentation tests compile; the launcher-specific dismissal fix is not yet physically verified. APK: `artifacts/Museamo-0.2.1-debug.apk`. No preview server or emulator was started.

## Formatting update — 0.3.0

- App editing and native capture offer bold, italic, bullets, numbering, quotes, and a Write/Preview toggle. The editor displays Markdown source; the feed displays formatted text.
- Standard formatted Paste converts supported HTML/styled clipboard content into Markdown, preserving structure and emphasis with Museamo typography. Plain-only clipboard sources remain plain text. No images, source fonts/colors/sizes, or embedded active content are imported.
- Copy text includes semantic HTML and a readable plain fallback. Drafts, saved edits, Undo and backup version 1 preserve Markdown. Leading whitespace is retained so indentation survives saving.
- Shared fixtures cover definitions, definition lists, numbered/bulleted/nested lists, quotes, links, Unicode, source styles, unsafe elements and whitespace around emphasis. Existing hashtag fixtures now include formatted hashtags.

Verification: TypeScript, all 39 frontend tests, all 7 Android JVM tests, production build, Android debug packaging, and lint passed (0 errors; 43 warnings). Instrumentation tests compile, including a new formatted draft/save/edit/backup round-trip test; they were not run on a phone. Rendering/interaction tests use static rendering and unit fixtures, not browser visual verification.

Manual acceptance still required:

- Copy a dictionary definition in Chrome and Samsung Internet, then use standard Paste in widget capture and in-app editing. Compare paragraphs, emphasis, links and numbered/bulleted lists in Preview and the saved feed.
- Check plain-text clipboard sources, Paste as plain text, and keyboard clipboard suggestions; only sources that provide styled content can preserve it.
- Select text and apply/toggle formatting; edit selected lines into lists. Check caret behavior and Send visibility with Gboard/Samsung Keyboard, 200% text, TalkBack, and light/dark themes.
- Interrupt and resume a formatted draft, rotate the composer, save offline, edit, copy into a rich-text destination, and export/import a backup. Verify nothing silently loses text or formatting.
- Read and expand a long formatted post; verify list indentation, URL/tag actions, and scroll position. Existing literal Markdown syntax may now appear formatted; the underlying text remains unchanged.

APK: `artifacts/Museamo-0.3.0-debug.apk`. No preview server or emulator was started.

SHA-256: `71CB70F4BB6EC93B08F4F769A7DF9DE619E690AFEC2113017EECBD76148EEBA0`. Final APK contents were checked against the production CSS/JS asset filenames after Capacitor sync. The final single-use Gradle build exited successfully.
