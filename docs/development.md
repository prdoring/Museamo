# Development

Start with the [README](../README.md) for the app's behavior. The browser preview is temporary and resets on refresh; it never opens a native library.

## Browser preview

Install Node.js 22 or newer:

```sh
npm ci
npm run dev
```

Open the printed local URL. The preview provides sample thoughts, a light/dark/system theme switch, and a phone/desktop layout switch. `?previewLayout=desktop` selects the desktop layout. Settings includes reset, empty-library, large-library, and simulated-save-failure tools. Stop the preview with Ctrl+C.

```sh
npm run typecheck
npm test
npm run build
npm run test:release
```

## Android

For a Mac walkthrough covering permanent Rust installation, phone installation, and a shared release key in 1Password, see [Mac setup](mac-setup.md).

Build Android on macOS arm64/x64, Linux x64, or Windows x64. Install JDK 21, Android SDK platform 36, build-tools 36.0.0, NDK 30.0.14904198, and Rust's Android targets. Set `JAVA_HOME` to the JDK and `ANDROID_HOME` to the SDK. Verify Android Studio's bundled JBR is version 21 before using it. Alternatively, Gradle can locate the SDK through ignored `android/local.properties` (`sdk.dir=...`); the direct sync-core command needs `ANDROID_HOME` or an explicit NDK directory.

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm run android:sync
cd android
./gradlew :app:assembleDebug :app:lintDebug
```

On Windows use `gradlew.bat`. Gradle's pre-build task builds and packages the Rust sync core. The direct `npm run android:sync-core` command is available when you only need native libraries. The builder uses pinned NDK 30.0.14904198, or `ANDROID_NDK_HOME` when set. Cargo uses locked dependencies and honors `CARGO_TARGET_DIR`. Unselected and stale generated sync-core libraries are removed before building; other JNI libraries are preserved.

The development APK is `android/app/build/outputs/apk/debug/app-debug.apk`. Install it with Android Studio or `adb install -r`. Minimum device: Android 7/API 24, with WebView 111 or newer.

For emulator-only development, set `SYNC_ANDROID_ABIS=x86_64` on Linux/Windows or `arm64-v8a` for an Apple Silicon emulator. Clear it before making distributable builds. `-PsyncCoreRelease` optimizes native libraries in a debug APK; release builds optimize them automatically. The Android release builder always includes all four ABIs.

Signed APKs use the existing `MUSEAMO_KEYSTORE`, `MUSEAMO_KEY_ALIAS`, `MUSEAMO_STORE_PASSWORD`, and `MUSEAMO_KEY_PASSWORD` environment variables. On Unix hosts, import the portable backup of the original signing key. The saved DPAPI credential helper remains Windows-only. A new key cannot update an installation signed with the old one.

With a disposable emulator/device attached:

```sh
./gradlew :app:connectedDebugAndroidTest
```

Instrumented tests can replace or clear test data. Use test installations and preserve backups. See the [device checklist](device-checklist.md) for launcher and lifecycle checks, and [paper verification](paper-verification.md) for the isolated visual-test package.

## iOS

Build iOS on macOS with Xcode 26 or newer, which Capacitor 8 requires, and Node 22. Dependencies come through Swift Package Manager; CocoaPods is unnecessary. Install an iOS simulator runtime, 16.4 or newer, in Xcode Settings > Components.

```sh
npm run ios:build
npm run ios:launch
```

`ios:build` builds the web app, syncs it into `ios/App`, and makes an unsigned Debug simulator build at `ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app`. `ios:launch` boots an iPhone simulator when none is running, then installs and opens that build; reinstalling preserves app data. `npm run ios:run` does both. Set `IOS_DEVICE_ID` to a UDID from `xcrun simctl list devices available` to choose a simulator. Use `npm run ios:open` to run from Xcode with a debugger instead.

The iOS host uses the Swift SQLite repository and registered Capacitor bridge for offline text capture, durable drafts, search, Gems, tags/checklists, and local Recovery. Media, location, backups, linked devices, shared hashtags, and widgets remain unavailable on iOS.

Run the Swift package tests with `npm run test:ios`. Local persistence UI tests use the committed `AppUITests` target: run `npm run ios:sync` (or `ios:build`) before `npm run test:ios:ui` to refresh the web bundle. Set `IOS_TEST_DEVICE_ID` to choose an available iPhone simulator. CI is configured for Swift tests and an unsigned simulator build; the hosted job is not yet verified and does not run UI tests.

Follow [iOS development](ios-development.md) for the native boundaries and [the iPhone device checklist](ios-device-checklist.md) for local signing, installation, and manual hardware checks. Signed physical-device installation remains to be verified.

## Windows

Install Node.js 22+, Rust's MSVC toolchain, Visual Studio C++ build tools with a Windows SDK, and Microsoft Edge WebView2 Runtime.

```sh
npm ci
npm run desktop:dev
cargo test --workspace
npm run desktop:build
```

The default build produces `target/release/museamo-desktop.exe` and an NSIS installer under `target/release/bundle/nsis/`. The release command builds an explicit x64 target under `target/x86_64-pc-windows-msvc/release/`. NSIS includes WebView2's offline installer; the standalone app EXE requires an installed runtime.

Closing the real Windows app keeps its tray process running. Quit it from the tray before replacing its executable. Libraries are stored in the Windows profile, separately from the executable.

## macOS and Linux desktop

See [desktop packaging](desktop-packaging.md) for the complete prerequisites, browser baseline, commands, and output paths. Desktop builds do not require Java or the Android SDK. Use the committed Rust toolchain and npm lockfile.

```sh
npm ci
npm run desktop:doctor
npm run desktop:dev
```

Build on the target OS. Initial distributable targets are Apple Silicon macOS 14 and Ubuntu 22.04 x64 with security updates. macOS uses native window controls, Command shortcuts, and Keychain for private device identity. Closing hides the window; reopen through the Dock or menu-bar icon, or quit through the application menu. Linux uses an unlocked Secret Service provider for private identity. Closing quits the Linux app, so it remains usable on desktops without tray support. Startup on Linux opens the window.

Native libraries remain outside the executable, in Tauri's per-user application data directory. Use portable export/import to move data between devices; do not copy a database and expect its OS-protected private identity to unlock on another machine.

## Final test handoff

When working with an agent under this repository's test-execution restriction, run typechecks, lint, and compilation first. The user runs tests last and reports results. Do not invoke release verification from an agent, because it runs tests.

```sh
npm test
npm run test:release
node --test scripts/build-sync-android.test.mjs
cargo test --workspace --locked -- --test-threads=1
```

On Android build hosts, run `./gradlew :app:testDebugUnitTest` from `android/`. Use `cargo test -p museamo-sync-core --locked` instead of the workspace command if desktop dependencies are not installed. Run instrumented tests only on a disposable device or emulator. Native smoke checks must use disposable libraries and cover restart persistence, protected identity recovery, backups, links, media, lifecycle, startup, discovery, and sync.

## Repository map

| Directory | Responsibility |
| --- | --- |
| `src/` | React interface, bridge contracts, browser preview, frontend tests |
| `android/app/src/main/` | Kotlin bridge, Room storage, capture, widgets, lifecycle |
| `ios/App/`, `native/ios/MuseamoNative/` | Capacitor iPhone host, Swift bridge, SQLite text storage |
| `desktop/src/` | Tauri commands, SQLite, backups, tray, desktop sync |
| `crates/sync-core/` | Shared protocol, identity, pairing, discovery, replication |
| `scripts/` | Platform builders and local release tooling |
| `docs/` | User/developer guides, screenshots, verification records |

Persistence errors must remain visible; real apps must never fall back to preview data. Use [architecture](architecture.md), [sync](offline-sync.md), and [DESIGN.md](../DESIGN.md) when changing those boundaries.

## CI and releases

GitHub Actions selects frontend, Rust, Android unit/lint, emulator, iOS Swift/simulator/archive, and Windows/macOS/Linux desktop checks from the changed files. Documentation uses lightweight checks; known test/tooling changes do not release; isolated platform changes avoid unrelated native builds. Feature branches run through PR checks, and newer PR updates cancel older runs. Manual `Checks` dispatch still runs full validation. See [CI scope and required checks](ci.md).

Desktop validation bundles are retained as short-lived workflow artifacts. Successful mainline validation of app or bundle changes starts automatic Windows/Android publication and independent TestFlight upload; documentation-, test-, and known tooling-only merges skip that work. Local build/publication commands remain available; see [the release guide](releases.md).
