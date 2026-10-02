# Local release preparation verification

Verified on **October 2, 2026**, on x64 Windows, for version **0.4.0**. These checks cover the current working changes; no source push, release upload, or repository visibility change was performed.

## Passed

- Frontend: 118 tests, type checking, and production builds.
- Release tooling: 3 tests covering version mismatches, debug prerelease labeling, incomplete/modified downloads, dirty or stale source, and checksum changes.
- Native Rust: 24 Windows tests and 47 shared-core tests. A timing-sensitive discovery test failed under concurrent test execution and passed in the full sequential run. The local release command runs native tests sequentially.
- Android: all four optimized Rust libraries, debug APK build, 12 unit tests, and lint. APK signature verified; all four ABIs present; restricted Trailhead font absent.
- Stable APK signing guard: an unsigned release request stopped with the expected missing-credentials message in a Gradle dry run.
- Windows: optimized x64 executable and NSIS installer, including offline WebView2 setup and the AGPL license file.
- Local push guard: ordinary `origin` pushes rejected; release-command gate accepted in a hook-only test with no network push.
- Documentation: 44 local links/assets resolved; GitHub Markdown rendering succeeded; banner and all eight screenshot images loaded in the preview.
- Current-tree hygiene: 356 tracked/unignored paths checked for private-key/token patterns and generated/private file names, with no matches. This targeted scan does not establish a full history/security audit.

The generated bundle under ignored `releases/0.4.0/` includes the Android APK, Windows installer, standalone EXE, committed-source archive, release notes, SHA-256 list, and a manifest. It is marked as a dirty local preview and cannot be published. Its source ZIP contains the committed tree, rather than the uncommitted changes. Rebuild from a clean commit for an actual release.

## Remaining before public distribution

- Confirm or remove the restricted Trailhead assets in old Git history; current-tree removal does not remove historical copies.
- Choose and retain the Android signing identity. Current test builds use the existing local debug key; stable releases require a dedicated key supplied locally.
- Smoke-test the installer and APK on disposable devices, including launcher, Wi-Fi/firewall, background sync, and media behavior. Connected-device instrumentation was not rerun for this documentation/release-tooling change.
- Review source and asset provenance, commit the intended release, then publish through the local release command.

See [release instructions](releases.md) and [licensing](licensing.md). Local diagnostic logs live under ignored `artifacts/`.
