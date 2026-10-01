# Checklist categories verification

Verified September 28, 2026.

## Automated checks

- TypeScript check and Vite production build pass. Vitest: 66 tests pass across 9 files.
- Android unit tests: 11 pass. Android lint: 0 errors, 72 warnings.
- API 34 project emulator: 46 instrumented tests pass, 1 optional isolated paper-theme capture test skips by design (47 in the XML report).
- Room migrations from versions 1, 2, and 3 validate against committed schema 4, preserving entries, drafts, profiles, and widget bindings while adding Standard/unchecked defaults.
- Repository and real WebView bridge tests cover shared completion, type changes, remembered state, unchanged edit timestamps, Undo, restart, backup v4 round trips, legacy imports, invalid metadata, and same-name tag conflicts.
- Browser and native tests paginate 137 mixed items across tied timestamps, then toggle a boundary item, refresh the loaded prefix, and continue without missing or duplicating items. Search/star filters and ordinary chronological ordering are covered.
- Native capture tests verify Checklist tags still capture unchecked items, picker changes retain independent draft tags, and attachment-only posts retain their media through completion changes.
- Widget tests cover 14 size combinations with Standard/Checklist tags, fixed/picker profiles, and 1×/2× font sizes. Live tag-type changes update the indicator; compact tiles retain their existing controls.

## Browser interaction and visual checks

An isolated Chrome session at 390 × 844 exercised the category editor, 137-item pagination, optimistic completion, failed-save retry, failed-refresh pagination blocking, keyboard Space activation, Stream/Gems/Map, the location sheet, scoped search, and switching back to Standard. No browser page errors were observed. Light/dark screenshots were inspected; the completed rich text is crossed out while location and post actions remain separate.

Local evidence is in `artifacts/checklist/`; the task’s browser harness is `.tools/checklist-ui.cjs`. Native execution details are in `artifacts-checklist-verified.log`. The APK is `android/app/build/outputs/apk/debug/app-debug.apk`.

The final APK was rebuilt after validation. Test-rendered widget screenshots at 100 × 120, 260 × 40, and 320 × 280 dp were also inspected: checklist icons stay within the existing picker space, narrow cards keep both actions, and long tag names truncate without covering controls.

The pre-existing widget bridge test now requests a wide layout explicitly instead of assuming an unbound responsive RemoteViews map contains a text label. Activity tests use a shared rule to temporarily opt out of automatic location and restore the preference, preventing unrelated first-open permission dialogs from interrupting capture/media assertions.

## Checklist layout revision

The tag editor now uses one Checklist switch with a short explanation. Selected Checklist categories use compact rows with the checkbox aligned beside the text; the current tag chip is omitted, other tags stay visible, and time/location/Gems actions are available from the item menu. Section headings share the first date line. Attachment-only rows align the photo with the checkbox.

After this revision, all 66 web tests, typecheck, production build, and Android debug assembly passed. The original 137-item browser regression was rerun successfully. Additional browser checks cover menu actions, location opening, Gems, editing, deletion/Undo, photo completion and viewing, long-text expansion, keyboard operation of the switch, new-tag defaults, 320/390/640px layouts, and 2× thought text. Checkbox and menu targets remain at least 48px. Light/dark screenshots were inspected. Revised evidence is in `artifacts/checklist-ux/`, with harnesses `.tools/checklist-layout.cjs` and `.tools/checklist-ux-regression.cjs`. Native storage and widget code did not change during this layout revision; the native test results above refer to the initial implementation.

## Mixed-feed alignment

The subsequent mixed-feed alignment correction was verified with 90 passing web tests, typecheck, production build, and Android debug assembly. Browser checks compare text/location/tag/media geometry at 320/390/640px in Stream, Gems, and search; they also cover 48px checkbox targets, keyboard toggles, chronological order, text expansion, enlarged thought text, and the dedicated Checklist layout. Light/dark screenshots are in `artifacts/mixed-feed/`; the harness is `.tools/mixed-feed-layout.cjs`. This correction changes only presentation and does not change storage or install anything on the physical phone.

## Stream To-dos filter

The single toolbar toggle was verified with 91 web tests, 12 Android JVM tests, typecheck, production build, Android assembly, and lint (0 errors, 79 warnings). Twelve instrumented tests passed on `emulator-5554`, including native multi-tag pagination, schema migration preservation, and activating the actual button through the WebView bridge. Browser checks exercise 120 checklist items older than 60 regular entries, checked/unchecked inclusion, three pages, completion after pagination, search, cached view switching, late requests, Settings return, saving a regular thought, tag removal/type changes, and the empty state. The button fits 320/390/640px layouts and works with keyboard activation and light/dark themes. Evidence is in `artifacts/todo-filter/` and `artifacts-todo-filter-instrumented.log`; the browser harness is `.tools/todo-filter-ui.cjs`. No physical-phone installation or storage migration was performed.

## Remaining manual checks

- Real launcher placement/resizing and TalkBack spoken output on hardware remain manual checks. Automated checks cover bounds, keyboard operation, checkbox roles/states, and native indicator descriptions.
- The opt-in isolated paper-theme screenshot suite was not run; it requires the separate `.paperpreview` application ID.
- Build warnings include the existing Vite texture placeholder/chunk-size warnings and Android lint findings; no new dependency was added.
