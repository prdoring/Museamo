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
- Create and retain a portable backup of the configured Android release key with `npm run release:signing:backup`. Current debug installations still require the original debug key for ordinary in-place updates.
- Smoke-test the installer and APK on disposable devices, including launcher, Wi-Fi/firewall, background sync, and media behavior. Connected-device instrumentation was not rerun for this documentation/release-tooling change.
- Review source and asset provenance, commit the intended release, then publish through the local release command.

See [release instructions](releases.md) and [licensing](licensing.md). Local diagnostic logs live under ignored `artifacts/`.

## Signing setup follow-up

Also verified on October 2, 2026:

These signing checks ran in the agent's execution environment. The maintainer's terminal subsequently reported that the configuration was absent at the same path under the same Windows account. The maintainer must run `npm run release:signing` in the terminal used for publishing before creating a retained backup or releasing. The test key below does not establish that the maintainer's terminal has been configured.

- A permanent 4096-bit RSA release key was created outside the repository, with its generated password protected by Windows account encryption. Directory permissions allow the owner, administrators, and SYSTEM only.
- Automatic credential loading worked without manual signing variables. Repeating setup retained the same certificate fingerprint. All 5 release-tooling tests passed, including saved credential loading, explicit overrides, partial overrides, malformed configuration, and lost keys.
- `:app:assembleRelease -PsyncCoreRelease` succeeded with `--no-daemon`. APK signature verification passed, the certificate matched the configured release key, and all four Android native libraries were present.
- The backup command exported the same signing identity under a different password and verified private-key access. This used a temporary test backup that was deleted immediately; the maintainer still needs a retained recovery backup.
- Release builds now use a fresh Gradle process to avoid reusing a development daemon with different key-access permissions or retaining credentials in that daemon.

No source push or release upload was performed during this signing fix. The existing `releases/0.4.0/` preview remains unchanged; use `npm run release` to create and publish a fresh bundle from the clean commit.
