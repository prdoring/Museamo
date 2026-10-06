# MuseamoNative

Swift storage and native services for Museamo's iPhone app. The Capacitor host keeps database operations on one serial queue and Rust runtime work on a separate queue. Native callbacks own signing, persistence, replication, sharing, and attachment transfer; private keys never cross the WebView bridge.

Schema version 2 migrates the existing offline library transactionally after a consistent SQLite snapshot. Thoughts, drafts, tags, profiles, Gems, checklist state, and Recovery retain their identities. Enrollment journals existing saved content once; drafts and profiles stay local. Shared tags expose only their selected content, attachments, saved location, and completion state.

The package links the versioned Rust C interface through `MuseamoSyncCore.xcframework`. Build that framework on a Mac with Xcode before running Swift tests:

```sh
node scripts/build-sync-ios.mjs
swift test --package-path native/ios/MuseamoNative
```

The framework contains ARM64 iPhone, ARM64/Intel simulator, and ARM64/Intel macOS slices. The app supports iOS 16.4 and later; package tests run on macOS 13 and later. GitHub's Mac runners build and test this code when developing from Windows.

The iPhone services provide QR rendering/scanning, original photo/video import and previews, manual location capture, and Apple Bonjour discovery. Sync runs while the app is active. Portable backup export/import, widgets, and automatic location capture remain unavailable.

Tests cover storage durability, migration rollback, interrupted enrollment, signed replication and receipts, attachment checksums and resumable writes, sharing privacy, and real Swift repositories communicating through Rust listeners. Camera, Photos, playback, location, permissions, and suspension behavior require physical iPhone verification.

See [development](../../../docs/ios-development.md), [privacy inventory](../../../docs/ios-privacy-inventory.md), and [hardware acceptance](../../../docs/ios-sharing-acceptance.md) for the build procedure and release checks.
