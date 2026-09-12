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

Long-press your launcher, open Widgets, and add Museamo. Choose a label and either fixed default tags (including none), or a tag picker. Add as many widgets as you like. Each has its own draft. Back preserves a draft; Send saves it exactly once and closes. A picker change affects the next fresh draft, never a draft already in progress. Existing/imported profile settings can be copied when configuring another widget, keeping instances independent.

Stream shows everything, Gems shows starred thoughts, and Tags provides collections. Settings manages capture profiles and JSON backup. Uninstalling or clearing app storage removes local data: keep exports somewhere safe. Android cloud backup and device-transfer backup are disabled for app data. Exports are plain JSON; choose their destination yourself.

## Architecture and validation

See [architecture](docs/architecture.md) for native bridge, persistence, and future routing contracts. See [device checklist](docs/device-checklist.md) for launcher checks that require hardware. No external integrations, account system, or analytics are implemented.

See the [verification record](docs/verification.md) for completed checks and remaining device validation. The native suite currently contains 13 integration/persistence tests. CI runs the suite on an Android emulator as well as building a downloadable debug APK.
