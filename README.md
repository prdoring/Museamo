# Museamo

A private stream of thoughts. Tap a homescreen widget, type, send. Come back later to find the gems.

## Development

Requires Node 22+, JDK 21, Android SDK 36 and build-tools 36.0.0. Android Studio's bundled JBR works. Minimum device: Android 7 (API 24), with WebView 105 or newer.

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run android:sync
cd android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

On Windows use `gradlew.bat`, set `JAVA_HOME` to Android Studio's `jbr`, and set `ANDROID_HOME` to your SDK folder. Alternatively create ignored `android/local.properties` with `sdk.dir` pointing to that SDK. `npm run android:open` opens Android Studio. The browser shows an explicitly labeled, ephemeral design preview: real user data lives only in native Room storage.

APK: `android/app/build/outputs/apk/debug/app-debug.apk`. Install using `adb install -r` or Android Studio. Instrumented database/lifecycle checks run with `./gradlew :app:connectedDebugAndroidTest` when an emulator/device is attached. CI attaches a debug APK to successful workflow runs. Debug signing is for development; store publishing requires a separate release key and review.

## Capture

Widgets default to a single homescreen row (3 × 1; exact size depends on the launcher). After upgrading, resize an existing widget or remove and re-add it if your launcher retains its previous size.

While composing, type `#` to see matching tags. Completion keeps the hashtag inline. Multiword names use `#"Cool words"`. Choose **Use new tag** or leave a complete hashtag in the message; missing inline tags are created when you send. **Add tag** also supports explicit selection and creation without inserting text. Removing an inline tag chip removes its tokens. URL fragments are not tags.

Long-press your launcher, open Widgets, and add Museamo. Choose a label and either fixed default tags (including none), or a tag picker. Add as many widgets as you like. Each has its own draft. Back preserves a draft; Send saves it exactly once and closes. A picker change affects the next fresh draft, never a draft already in progress. Existing/imported profile settings can be copied when configuring another widget, keeping instances independent.

Stream shows everything, Gems shows starred thoughts, and Tags provides collections. Settings manages widgets and JSON backup. Uninstalling or clearing app storage removes local data: keep exports somewhere safe. Android cloud backup and device-transfer backup are disabled for app data. Exports are plain JSON; choose their destination yourself.

## Architecture and validation

See [architecture](docs/architecture.md) for native bridge, persistence, and future routing contracts. See [device checklist](docs/device-checklist.md) for launcher checks that require hardware. No external integrations, account system, or analytics are implemented.

See the [verification record](docs/verification.md) for completed checks and remaining device validation. CI runs the suite on an Android emulator as well as building a downloadable debug APK.

## UX redesign

The app now uses a compact private feed, a bottom capture bar, explicit post actions, searchable tags with counts, and independent Undo notifications. Browser preview supports capture, editing, tags, stars, drafts, and simulated failures in memory; it never writes Android data.

Formatting: select text and use **B**, *I*, bullets, numbering, or quote controls in the app editor or native widget composer. Editing shows lightweight Markdown; **Preview** shows the formatted result. Standard Paste preserves supported structure and emphasis when the clipboard supplies formatted text, using Museamo's typography. Copy text includes HTML formatting with a plain-text fallback. Drafts and JSON backups retain the Markdown without a database migration.

See [DESIGN.md](DESIGN.md) for interaction rules and [UX verification](docs/ux-verification.md) for the remaining physical-device checks. No automatic preview server is required: run npm run dev in your own terminal and stop it with Ctrl+C.

Saved web addresses (`https://`, `http://`, and `www.`) are clickable and open outside Museamo. Links are rendered locally; the app does not fetch previews. Widgets also have a separate Open Museamo icon. Widget setup explains the two tag modes and uses a normal screen with Cancel and Add widget/Save changes controls.
