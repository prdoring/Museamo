# Paper theme verification — 2026-09-13

## Completed

- 42 web tests passed; web typecheck and production build passed; the emitted CSS contains resolved texture asset URLs and no unresolved Vite asset placeholders.
- Semantic theme tests compare every Android day/night color with its corresponding CSS role, compare forced dark preview with OS dark mode, and measure critical text/icon contrast pairs.
- Browser visual review: Stream, composer, Tags and Settings in both light and dark. Phone widths 390px and 320px, plus desktop. The 320px composer has no page overflow; the formatting toolbar scrolls within its own area.
- Browser interactions: rich-text preview and saving, hashtag completion, edit/save, star/Gems, deletion/Undo, scoped search, close/reopen draft preservation. Existing formatting/paste/hashtag/data tests remain in the automated suite.
- Android assembleDebug and lintDebug passed; all 7 native JVM unit tests passed. The isolated physical-device screenshot/regression test also passed.
- Physical-device visual instrumentation runs only with the isolated `com.prdoring.museamo.paperpreview` application ID. It captures actual native composer/configuration views and inflated production RemoteViews in both themes, at 180dp and 320dp widget widths.
- A regression discovered in screenshot review was fixed: tiled bitmap intrinsic dimensions had expanded the widget. The inner row is now explicitly 40dp and the visual test asserts it stays under 48dp.

## Evidence

Native screenshots are in `artifacts/paper-theme/`. The web screenshots were inspected in the task's browser output. The browser preview remains ephemeral and uses example data, never native storage.

The isolated preview APK can be built with:

```powershell
cd android
./gradlew.bat --init-script ../scripts/paper-preview.init.gradle :app:assembleDebug :app:assembleDebugAndroidTest
```

Before installation, assert the two output-metadata.json application IDs are `com.prdoring.museamo.paperpreview` and `com.prdoring.museamo.paperpreview.test`. Run only `com.prdoring.museamo.PaperThemeTest` with that test package. The test skips normal application IDs. Run a normal build without the init script to produce the deliverable Museamo APK.

## Remaining manual checks

TalkBack traversal, enlarged OS font sizes, real launcher placement/resizing, and a full keyboard/rotation/inset matrix still need manual device verification. Widget screenshots exercise the real RemoteViews layout and width logic, but are not screenshots of widgets placed in a launcher. Native screenshots capture the app's own view, excluding the keyboard and surrounding device screen.

## Device installation note

The initial attempt to create an isolated build was overridden by the app's Gradle configuration; its installer updated the existing debug app. No fixture tests ran against that package and no data-clear command was issued. The corrected finalizeDsl override and explicit package checks were used for all subsequent fixture tests. This distinction is recorded rather than claiming the original app was never touched.

Widget border follow-up: square frames replace rounded masks in both themes and setup previews. A 4dp outer inset protects the stroke. Device instrumentation verifies all four border corners at 180dp and 320dp and compact height (allowing one pixel for independent density rounding). Web build and Android build, unit tests, and lint passed. Actual launcher clipping remains launcher-dependent.

Superseding widget border follow-up: removed the outer stroke entirely in day/night backgrounds and both setup previews because launcher rounding still clipped it. Isolated device visual checks pass for borderless narrow/wide widgets. Composer now uses on-demand formatting; selected-text Bold verified in browser, expanded controls inspected at 320px with no horizontal overflow. Typecheck, 42 web tests, web build, Android unit tests/build/lint, and device visual instrumentation pass. Updated debug installed without clearing user data.

Visual composing: typecheck and 42 web tests pass; web build passes (editor increases bundle size). Android build/unit/lint pass. Device regression tests cover visual bold/italic, source-to-visual draft round-trip, tag removal preserving formatting, typed emphasis shortcuts, and list continuation/exit. Browser verified formatted selection, automatic lists, hashtag suggestions, save, and reopening in the visual editor. Native light/dark composer specimens updated. Keyboard-specific IME behavior and accessibility still need broader device checks.
