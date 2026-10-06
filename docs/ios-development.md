# iOS development

The initial iPhone implementation reuses React in Capacitor and stores text libraries in native SQLite. It supports durable drafts, capture/edit/delete/undo, search, Gems, tags/checklists, profiles at the repository boundary, and local Recovery. The iOS interface hides media, location, backup, linked devices, shared hashtags, and widgets until their native implementations are ready. This is an initial development build, not full Android/Windows parity.

See [verification results](ios-verification.md) for the completed checks and remaining device coverage.

## Requirements and build

- macOS with Xcode 26 or newer and its iOS simulator platform installed.
- Node.js 22 or newer, preferably a supported LTS release.
- iOS **16.4 or newer**. This target matches the existing Tailwind 4 / Safari baseline; Capacitor's lower minimum alone is insufficient for this interface.

```sh
npm ci
npm run ios:build
npm run ios:open
```

`ios:build` builds the web assets, runs Capacitor sync, resolves Swift packages, and compiles an unsigned simulator application into `ios/DerivedData`. `ios:launch` installs and opens that already-built app in an iPhone simulator; `ios:run` combines build and launch. Set `IOS_DEVICE_ID` to select an available iPhone simulator UUID. `ios:open` opens Xcode for debugging or device installation. After frontend edits, run `ios:sync` to rebuild and update the bundled web assets before running from Xcode.

The committed Xcode project uses Swift Package Manager: Capacitor 8.5.2 and the local `native/ios/MuseamoNative` package. The app links the local package directly, so Capacitor's regeneration of `CapApp-SPM/Package.swift` does not remove the repository dependency. CocoaPods is not required.

For physical-device signing, installation, and manual checks, follow the [iPhone device checklist](ios-device-checklist.md). The repository defaults to `com.prdoring.museamo` and does not commit a signing team or credentials. Signed installation and hardware behavior remain an owner-run handoff.

For installation from a Windows development machine, follow [the TestFlight setup guide](testflight-setup.md). The manually triggered `iPhone TestFlight` GitHub workflow signs and exports an iPhone Release build using encrypted Actions secrets; upload to Apple is a separate checkbox. Regular CI checks an unsigned Release archive without accessing signing credentials.

## Icon and launch screen

`npm run ios:assets` generates the iPhone asset catalog from `src/assets/branding/lantern.json`, the same master geometry used by the web/Android/desktop branding exporter. It creates an opaque square 1024×1024 App Store icon, transparent light/dark launch marks at 1×/2×/3×, and an adaptive cream/navy launch background. The storyboard centers an 88×128-point lantern using Auto Layout; it does not crop a full-screen splash bitmap. The native web view uses the same background during startup. iOS applies its own home-screen icon mask.

`ios:sync` runs generation and validation before the web build and Capacitor sync, so local, simulator, CI, and TestFlight builds use the latest master artwork. Generated assets are committed for direct Xcode use. Run `npm run ios:assets:check` to detect missing, stale, incorrectly sized, or transparent icon exports; PNG checks compare decoded pixels rather than compression bytes. `npm run test:ios:assets` exercises bad icons, missing launch images, changed artwork, and broken launch-screen wiring using disposable files.

The Mac CI archive and signed TestFlight archive also inspect the compiled `Assets.car` and `LaunchScreen.storyboardc` before export/upload. These checks confirm the icon and launch artwork were bundled; they do not substitute for viewing light/dark cold launches on an iPhone. On-device checks should cover portrait/landscape, launch-to-interface transitions, and the installed home-screen icon. iOS may cache launch screens across upgrades; changing source files alone does not change an already installed build.

## Checks

```sh
npm test
npm run test:ios:assets
npm run ios:assets:check
npm run test:ios
npm run ios:sync
npm run test:ios:ui
npm run test:release
npm run ios:build
```

The Swift package tests use temporary databases and verify reopen persistence, transactional rollback, idempotent saves, cursor queries, stale revisions, local Recovery, and shared hashtag fixtures. The UI test drives the real React editor and native bridge, saving a thought and reopening an unsent draft across app termination. It creates a unique test tag without clearing the library. The macOS CI job is configured to run Swift tests and the unsigned simulator build alongside the existing platform jobs; its hosted result has not yet been verified. UI tests are local only.

`test:ios:ui` requires current web assets: run `ios:sync` (or `ios:build`) first. It builds the native UI test target and selects an available iPhone simulator, preferring a booted one. Set `IOS_TEST_DEVICE_ID` to choose a specific available simulator UUID. The test leaves its synthetic thought and draft in that simulator's library.

The native bridge serializes repository work on one queue and emits `dataChanged` after durable library mutations and on scene activation. Draft updates are written as editing changes arrive. Background completion grants already queued writes a limited chance to finish; it is not a background sync service. Storage failures propagate to the interface; native startup never falls back to sample data.

To check the main user flow, create a thought, terminate/relaunch the app, and verify it remains in Stream. Then type an unsent draft, terminate/relaunch, reopen capture, and verify the draft returns. Also test tags, Gems, checklists, edit/delete/undo, Recovery, keyboard avoidance, and app switching on hardware before using valuable data.

## Storage and future sync

The library resides at `Application Support/Museamo/library.sqlite` in the app sandbox, with SQLite WAL and explicit schema migration. Application code owns the database location; the WebView cannot select arbitrary paths. Local revisions guard stale edits and local Recovery retains earlier versions. These are not yet signed sync envelopes.

Before enabling LAN sync, implement and test a one-time enrollment transaction that translates existing entries, tags, and retained Recovery into the shared journal. Record the migration/enrollment marker atomically, preserve entry identities, and keep drafts local. Do not expose device linking before that migration and native identity/receipt callbacks are complete.

This branch does not include a Rust iOS feature, Apple framework builder, or iOS Keychain identity implementation. The separate Rust feasibility snapshot is not part of the text-library app. LAN sync and native identity remain future work; see [the remaining roadmap](ios-roadmap.md).
