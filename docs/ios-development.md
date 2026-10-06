# iOS development

The connected iPhone candidate reuses React in Capacitor, Swift/SQLite storage, and the same Rust protocol as Android/desktop. It adds QR tag invitations, personal-device linking, photos/videos and manual locations. Automatic location, widgets and portable backups remain unavailable. See [candidate acceptance](ios-sharing-acceptance.md) and [verification](ios-verification.md); physical hardware results are required before calling this feature complete.

## Build from Windows

Windows can edit and test the frontend/Rust protocol. Apple compilation requires macOS and Xcode's SDKs, so use a draft PR's Checks workflow for Swift tests, the simulator build, and unsigned iPhone archives. The trusted-main TestFlight workflow retains existing signing credentials and cleanup. Do not upload an unverified candidate or use the text-only encryption answer; see [privacy/encryption inventory](ios-privacy-inventory.md).

## Build on a Mac

Requirements: Node 22+, Rust 1.99.0, Xcode 26+ and iOS simulator SDKs. The app supports iPhone on **iOS 16.4+**. Native tests require macOS 13+. CocoaPods is not required.

```sh
npm ci
npm run ios:sync-core
npm run test:ios
npm run ios:build
npm run ios:open
```

The reproducible framework builder compiles static Rust libraries for ARM64 iPhones, ARM64/Intel simulators and ARM64/Intel macOS tests, then packages an ignored XCFramework in the local native package. Rebuild it after Rust/interface changes. `ios:build` builds this framework, generates/checks branding, builds the web interface, runs Capacitor sync and compiles an unsigned simulator app. `ios:launch` installs an already-built app; `ios:run` combines build and launch. Set `IOS_DEVICE_ID` to select a simulator.

Capacitor's generated `CapApp-SPM/Package.swift` stays managed. The app directly links the separate local `MuseamoNative` package. For Xcode use, run `ios:sync-core` and `ios:sync` first. CI builds the framework before Swift tests and both simulator/device compilation. [TestFlight setup](testflight-setup.md) explains the existing signing flow.

## Verification

```sh
npm run typecheck
npm test
npm run test:sync
node --test scripts/build-sync-ios.test.mjs scripts/ci-changes.test.mjs
npm run test:ios:distribution
npm run test:ios:assets
npm run test:ios
npm run test:ios:ui
```

Swift tests use temporary databases and injected in-memory signing identities, including real Swift callbacks behind Rust listeners. They cover migration rollback/snapshots, enrollment, signed/causal journals, duplicate delivery, private sharing fields and original transfer/retention. Tests never rely on the runner's Keychain. The existing UI persistence smoke test exercises the real React editor and SQLite across relaunch. Hardware still must verify camera permissions, WKWebView video seeking, Bonjour/local-network permissions and suspension.

## Native boundaries and lifetime

The ABI is version 1. Runtime handles are opaque; commands/shutdown run on a dedicated serial queue. Rust owns returned buffers; callback responses are freed with the Swift allocator callback. Rust retains callback contexts until every worker finishes. Inputs are bounded and Rust entry points contain unwinding panics. Repository callbacks dispatch synchronously onto the database queue; that queue never synchronously calls a runtime, preventing callback deadlocks.

Keychain keys remain native-only, nonsynchronizing and `WhenUnlockedThisDeviceOnly`. Missing/corrupt enrolled keys disable sync instead of replacing an identity. Each durable local commit appends signed personal/shared journal work and wakes sync. Replicated commits refresh the interface without creating new shared edits.

Apple Bonjour/DNS-SD handles discovery on iPhone; Rust's raw multicast is disabled on iOS. QR scanning asks for Camera on demand. PHPicker copies only selected originals. Manual location asks for When In Use permission; automatic collection is off. Capacitor's native file mapping serves typed original URLs and supports byte ranges. The original remains saved when its codec is unsupported.

## Storage and lifecycle

The app owns `Application Support/Museamo/library.sqlite`, original/staging files and previews. Schema 2 removes global tag-name uniqueness while retaining private-tag validation. Migration first takes a consistent SQLite snapshot including committed WAL data, then transactionally rebuilds tags/associations and adds journals, memberships, pending sharing work and attachment metadata. One-time enrollment of saved content and Recovery preserves IDs and commits its marker atomically. Drafts/profiles remain local.

Permanent clearing commits signed erasure proofs/projections/receipts before physical cleanup. Cleanup is durable/retryable and removes the migration snapshot, cleared original references and old WAL pages. Network failures do not switch storage to preview data.

Sync runs while active. Backgrounding dismisses the camera, stops discovery and fences the old runtime; queued durable writes receive bounded background completion. Reopening resumes enrolled libraries and catches up. No continuous background-sync promise is made.

The migration snapshot is not a portable backup and cannot protect uninstall/reset. In quarantine, local access stays available and sync is disabled. Do not reset an installation to recover: iPhone backup export is deferred. Use sample content until [physical acceptance](ios-sharing-acceptance.md) is recorded.
