# Development

Start with the [README](../README.md) for the app's behavior. The browser preview is temporary and resets on refresh; it never opens an Android or Windows library.

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

Install JDK 21, Android SDK platform 36, build-tools 36.0.0, an Android NDK (currently tested with 30.0.14904198), and Rust's Android targets. Android Studio's bundled JBR works. Set `JAVA_HOME` to the JDK and `ANDROID_HOME` to the SDK. Alternatively, Gradle can locate the SDK through ignored `android/local.properties` (`sdk.dir=...`); the direct sync-core command needs `ANDROID_HOME`.

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm run android:sync
cd android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

On Windows use `gradlew.bat`. Gradle's pre-build task builds and packages the Rust sync core. The direct `npm run android:sync-core` command is available when you only need native libraries. The builder uses the newest installed NDK, or `ANDROID_NDK_HOME` when set.

The development APK is `android/app/build/outputs/apk/debug/app-debug.apk`. Install it with Android Studio or `adb install -r`. Minimum device: Android 7/API 24, with WebView 105 or newer.

For emulator-only development, set `SYNC_ANDROID_ABIS=x86_64`; clear it before making distributable builds. `-PsyncCoreRelease` optimizes native libraries in a debug APK; release builds optimize them automatically. The release command always includes all four ABIs.

With a disposable emulator/device attached:

```sh
./gradlew :app:connectedDebugAndroidTest
```

Instrumented tests can replace or clear test data. Use test installations and preserve backups. See the [device checklist](device-checklist.md) for launcher and lifecycle checks, and [paper verification](paper-verification.md) for the isolated visual-test package.

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

## Repository map

| Directory | Responsibility |
| --- | --- |
| `src/` | React interface, bridge contracts, browser preview, frontend tests |
| `android/app/src/main/` | Kotlin bridge, Room storage, capture, widgets, lifecycle |
| `desktop/src/` | Tauri commands, SQLite, backups, tray, desktop sync |
| `crates/sync-core/` | Shared protocol, identity, pairing, discovery, replication |
| `scripts/` | Platform builders and local release tooling |
| `docs/` | User/developer guides, screenshots, verification records |

Persistence errors must remain visible; real apps must never fall back to preview data. Use [architecture](architecture.md), [sync](offline-sync.md), and [DESIGN.md](../DESIGN.md) when changing those boundaries.

## CI and releases

GitHub Actions runs frontend, Rust, Android unit/lint, emulator, and Windows native checks. Test reports may be attached to workflow runs. Downloadable releases are built and published locally; see [the release guide](releases.md).
