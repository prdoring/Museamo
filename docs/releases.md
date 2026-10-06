# Automatic mainline releases and local builds

Successful **Checks** runs for pushes to `main` start **Mainline release**, which first verifies the originating run's change-scope record. Documentation-, test-, and known tooling-only changes skip version reservation, release builds, publication, and TestFlight. App or bundle changes remain eligible for automatic delivery. Pull requests, other branches, manual check runs, and failed checks do not release. See [CI scope](ci.md) for the file policy and required checks.

For eligible app changes, GitHub-hosted runners build Windows x64 and signed Android downloads, verify both, and publish a stable GitHub Release. A separate Mac job uploads the same version to internal TestFlight; an Apple failure does not block Windows and Android publication.

## Automatic versions and recovery

Release runs queue without canceling each other (`queue: max`, currently up to 100 pending runs). The checked main commit is captured when CI finishes. Each run reserves the next numeric patch version above existing release tags and the source version, beginning with `0.4.1` after `v0.4.0`. Android's versionCode increases above all existing reservations and the source value. Manually raising the source version establishes a new version floor; the automatic release still advances its patch.

The workflow updates package.json, package-lock.json, the Cargo workspace and Cargo.lock, Tauri, and Android versions in a **release commit parented by the checked main commit**. It generates notes from commit subjects since the newest ancestor reservation. This commit is tagged `vVERSION`; it is not pushed to main. Numeric versions on main therefore remain the development baseline. The annotated tag records the original source commit, version, Android code, and owning Actions run ID. A tag reserves a version even if builds fail; gaps are expected. Do not delete, move, or reuse reserved tags.

All three build jobs use the exact release commit. A repeated Checks event for the same source detects its existing reservation and links to the owning release run instead of building or uploading again. **Retry failed jobs in that original Mainline release run.** Reruns keep the version and tag. iPhone build numbers increase with run attempts.

Verified Windows and Android artifacts are retained for 30 days. A full rerun restores those original files rather than rebuilding them, preserving exact bytes for interrupted draft uploads. Missing or expired artifacts and changed draft assets require manual recovery; never replace existing draft downloads to conceal a mismatch. Published releases are skipped on rerun. TestFlight can be retried independently after GitHub publication.

The final Actions summary reports Windows, Android, GitHub publication, and TestFlight separately. A successful upload means Apple accepted the package, not that processing has finished. Enable automatic distribution on the internal tester group in App Store Connect. External TestFlight groups and App Store publication are outside this workflow.

## One-time automatic release configuration

Apple's existing configuration is described in [TestFlight setup](testflight-setup.md). Certificates and profiles must remain valid. Renew an expiring profile/certificate and update the corresponding secrets before the next release; preserve the bundle ID and team.

Android requires these repository Actions settings:

| Type | Name | Purpose |
| --- | --- | --- |
| Secret | `MUSEAMO_KEYSTORE_BASE64` | Base64 contents of the existing signing keystore |
| Secret | `MUSEAMO_KEY_ALIAS` | Existing private-key alias |
| Secret | `MUSEAMO_STORE_PASSWORD` | Keystore password |
| Secret | `MUSEAMO_KEY_PASSWORD` | Private-key password |
| Variable | `MUSEAMO_ANDROID_CERT_SHA256` | Trusted certificate SHA-256, 64 hex characters without colons |

From the Windows account that owns the saved signing configuration, with GitHub CLI logged in, JAVA_HOME set, and Android build-tools 36.0.0 installed, run:

```sh
npm run release:configure-ci
```

The helper loads the saved identity or a complete explicit environment override, downloads the published signed `v0.4.0` APK, and verifies that its certificate matches the existing key before sending credentials directly to encrypted GitHub Actions secrets through standard input. It never creates a key or prints passwords. If the key differs, restore the original published signing identity; do not generate a replacement. Partial secret uploads can be retried. Repository settings may also be configured manually using a verified original-key backup.

To use a portable PKCS12 backup instead of the saved identity, run the command below in your own interactive terminal. It asks for the backup password with input hidden, uses `museamo-release` as the default alias (override with `--alias ALIAS`), verifies private-key access and the published certificate, and sends the backup directly to Actions secrets without changing local signing configuration:

```sh
node scripts/release-configure-ci.mjs --keystore ../museamo-signing-backup.p12
```

The Android runner decodes the keystore only into protected temporary storage, requires the trusted fingerprint, checks the APK signature and all four ABIs, and removes the temporary file on success or failure. Private signing files are never included in uploaded artifacts. Only reservation and publication jobs have repository contents-write permission. The existing pre-push hook now allows ordinary development pushes.

## Optional local release commands

Build each platform on its supported host from the same clean commit. Build, verification, assembly, and publication remain separate commands for local use. Local commands do not participate in the automatic version allocator; coordinate manual releases with pending automatic runs to avoid conflicting tags.

The old `npm run release` build-and-push shortcut is removed. It now checks release source only. `release:build` defaults to Windows and builds that platform only. Android needs `--platform android`. Publication requires an explicit reviewed assembly directory.

## One-time setup

Install the [development prerequisites](development.md) for the platform you are building. Publication also needs [GitHub CLI](https://cli.github.com/) and `gh auth login`. Android builders need JDK 21, SDK 36, build-tools 36.0.0, NDK 30.0.14904198, and all four Rust Android targets. Set `JAVA_HOME` and `ANDROID_HOME`. Use the committed Gradle wrapper.

Run `npm run release:setup` to install the repository's hooks. It sets this checkout's `core.hooksPath` to `.githooks`, and refuses to overwrite another hook directory. Normal pushes are allowed, including in checkouts that previously installed the release-only guard. Mainline publication is enforced by the Actions workflow rather than a local push restriction.

## Android signing

For first-key creation on macOS, 1Password backup/sharing, and local signed APK installation, follow [Mac setup](mac-setup.md#choose-the-android-signing-key). If an existing release already has a signing key, restore that key instead of creating another.

Public stable APKs need a dedicated signing key. On Windows, set it up once:

```sh
npm run release:signing
```

Run this setup in the terminal you will use for releases. An agent's execution environment can have a different view of user-profile storage even when the Windows account and displayed paths match; successful agent-side checks do not establish that your terminal is configured.

With no signing variables set, this creates a 4096-bit RSA key valid for 10,000 days in `%LOCALAPPDATA%\Museamo\release-signing\museamo-release.p12`. The keystore password is randomly generated and saved in `signing.json` using Windows account encryption (DPAPI). Access to the directory is restricted to your account, administrators, and SYSTEM. These files stay outside the repository. Repeating setup verifies the existing key; it never replaces it.

On Windows, signed Android `release:build -- --platform android` commands load the saved key automatically. Passwords are passed to build tools only in their process environment, never in command-line arguments or release manifests. Automatic runners receive the same identity through encrypted GitHub Actions secrets.

Create a portable recovery backup before publishing:

```sh
npm run release:signing:backup
```

The backup command asks for a new `.p12` path outside the repository and a password of at least 12 characters, entered without displaying it. It exports the same signing identity under that password and verifies the certificate and private-key access. Keep the backup on separate protected storage and its password in your password manager. The local `signing.json` alone cannot recover your password on a new Windows installation. Never distribute your private keystore.

If you already have a release key, set all four variables below in your local shell before running `release:signing` on an unconfigured PC. It saves your existing key's configuration instead of creating a new identity. You can also provide all four variables to override the saved configuration for a build:

```powershell
$env:MUSEAMO_KEYSTORE = 'C:\path\outside\repo\museamo-release.jks'
$env:MUSEAMO_KEY_ALIAS = 'your-key-alias'
$storePassword = Read-Host 'Keystore password' -AsSecureString
$keyPassword = Read-Host 'Key password' -AsSecureString
$env:MUSEAMO_STORE_PASSWORD = [System.Net.NetworkCredential]::new('', $storePassword).Password
$env:MUSEAMO_KEY_PASSWORD = [System.Net.NetworkCredential]::new('', $keyPassword).Password
npm run release:signing
$storePassword.Dispose()
$keyPassword.Dispose()
Remove-Item Env:MUSEAMO_STORE_PASSWORD, Env:MUSEAMO_KEY_PASSWORD
Remove-Item Env:MUSEAMO_KEYSTORE, Env:MUSEAMO_KEY_ALIAS
```

macOS and Linux builders must supply all four variables explicitly, using the project's release key or its protected recovery backup. They cannot load Windows DPAPI configuration. The Mac setup guide covers creating the first key manually; no Unix release command creates a replacement signing identity.

Partial overrides are rejected rather than mixed with saved credentials. If a previously configured key is missing or cannot be decrypted, restore the original key; generating a replacement would prevent existing users from receiving ordinary updates. The Gradle release build refuses an unsigned APK. See [Android's signing documentation](https://developer.android.com/studio/publish/app-signing) and [Microsoft's DPAPI documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertfrom-securestring).

Run signing setup, backup, and releases under the same Windows account. Use `whoami` to check the terminal's account. A Codex sandbox account cannot read a key protected for your normal Windows account; run these commands in your normal Windows terminal. The helper reports the account and configuration path when a configuration is missing or inaccessible. Do not create a replacement key or loosen its permissions to work around a different account.

To preserve compatibility with current debug-key installations, choose `--platform android --android debug`. It builds a debug-signed APK with optimized Rust libraries and automatically marks the GitHub release as a **prerelease**. Keep using the same PC's debug keystore for updates; a newly generated debug key will not match existing installations. Never distribute your private keystore.

Changing from a debug key to a release key prevents an ordinary in-place update. Export the saved library first. Drafts are not in the export. Keep the original app installed until you have a verified backup.

## Prepare a version

1. Set the same `major.minor.patch` in `package.json`, `package-lock.json` (including its root package), `Cargo.toml`, and `desktop/tauri.conf.json`.
2. Set Android's `versionName` to the same value and increase its `versionCode` in `android/app/build.gradle`.
3. Refresh `Cargo.lock` so both Museamo packages have that version.
4. Write `docs/release-notes/VERSION.md`, update screenshots if behavior changed, and commit everything intended for that release.
5. Run `npm run release:check`. It rejects mismatched versions, missing notes, and a dirty checkout.

Use a fresh version for every published release. Never move a published tag to new source or replace its downloads. This applies when moving from a test prerelease to a stable signed build.

## Build each platform

Check out the same clean commit on every builder. Run only the command for that host:

```sh
# Android on supported Windows, macOS, or Linux hosts.
npm run release:build -- --platform android
# Or retain the existing debug identity for a test prerelease.
npm run release:build -- --platform android --android debug

# Windows x64.
npm run release:build -- --platform windows
# Apple Silicon macOS 14+.
npm run release:build -- --platform macos
# Linux x64. Build packages on the Ubuntu 22.04 baseline.
npm run release:build -- --platform linux
```

Build commands install locked frontend dependencies and compile/package the chosen platform. Android includes all four ABIs and verifies the APK signature and native libraries. Desktop commands use the matching Tauri platform config and Cargo `--locked`. Linux release builds also run `desktop:doctor --release` and refuse a host outside the declared Ubuntu 22.04 baseline before packaging. macOS compilation needs no signing secrets. The collector records `developer-id-notarized` only when native checks validate Developer ID signing and notarization for both the app and DMG; otherwise it records `preview` and forces a prerelease. They never run tests, create tags, push, or publish. Close preview servers before building to avoid locked native files on Windows.

Each build writes `releases/VERSION/PLATFORM/manifest.json` and its artifacts. The manifest records schema 2, version, Android versionCode, clean-source status, commit, target, artifact kind, filename, byte size, and SHA-256. Android also records its signing certificate SHA-256 and debug/release mode. Set `MUSEAMO_ANDROID_CERT_SHA256` to the existing certificate fingerprint to reject a different signing identity during APK collection. Obtain that public fingerprint from a trusted previously distributed APK using `apksigner verify --print-certs`, and keep using the original keystore.

Dirty previews are local only:

```sh
npm run release:build -- --platform android --android debug --allow-dirty
```

A dirty manifest cannot pass release verification or assembly. Commit the intended source and rebuild cleanly before release. A failed build invalidates the previous manifest before compiling, so an old successful bundle cannot pass as a new build.

## Verify on each build host

Run verification explicitly on the machine that built each platform:

```sh
npm run release:verify -- --platform android
npm run release:verify -- --platform windows
npm run release:verify -- --platform macos
npm run release:verify -- --platform linux
```

Each invocation runs release-tooling and frontend tests. Desktop verification runs Rust workspace tests. Android verification runs sync-core Rust tests, Android builder Node tests, Gradle unit tests, and lint, so it does not need desktop GUI dependencies. Verification checks the source and artifact bytes before and after those checks. It writes `verification.json` only after every required command succeeds. The receipt binds the platform, commit, version, and complete build manifest hash. Desktop-only verification needs no Android SDK.

These commands intentionally run tests. Do not run them in an agent session where tests are forbidden. The maintainer must run them before publication. A receipt records automated checks; it does not establish native runtime acceptance, signing/notarization success, or hardware compatibility.

Inspect apps on disposable devices before publishing. Check saved data and identity after restart, backup import/export, discovery/sync, external links, media, window close/reopen/quit, startup behavior, and permission denial/recovery. Test Windows installation and WebView2 behavior. Review macOS signing, notarization, quarantine/Gatekeeper, and Linux package installation, browser/media dependencies, and tray fallback. Preserve Android signing identity when updating existing installations.

## Assemble reviewed downloads

Copy each platform directory, including `manifest.json` and `verification.json`, to the publication checkout. Keep the source checkout at the same clean commit. Build outputs and receipts may come from separate machines.

```sh
npm run release:assemble -- --manifest /builds/android/manifest.json --manifest /builds/windows/manifest.json --manifest /builds/macos/manifest.json --manifest /builds/linux/manifest.json
```

Without `--manifest`, assembly reads the four default platform directories in this checkout. Its default platform selection is Android, Windows, macOS, and Linux. A deliberately smaller release must declare its complete selection:

```sh
# Retain the earlier Windows + Android download set.
npm run release:assemble -- --platforms android,windows
# Or a desktop-only release from an imported build.
npm run release:assemble -- --platforms macos --manifest /builds/macos/manifest.json
```

Assembly rejects missing or duplicate platforms/artifact kinds, inconsistent source or versions, dirty sources, path traversal, symlinks in artifact files, and changed bytes. It creates a fresh `releases/VERSION/assembly-*` directory, copies the artifacts, archives the clean committed source, writes release notes, and records checksums. `--directory PATH` can choose an empty destination. Existing directories with contents are refused.

Assembly can collect clean builds before verification, but publication requires every selected platform's valid receipt. After running a missing verification step, assemble again in a fresh directory. Stale receipts are refused. Debug APKs, unsigned or unnotarized macOS previews, and any prerelease build force the assembled release to remain a prerelease; `--prerelease` may also mark an assembly.

| Download | Purpose |
| --- | --- |
| `Museamo-VERSION-android.apk` | Signed Android release |
| `Museamo-VERSION-android-debug.apk` | Debug signed test prerelease |
| `Museamo-VERSION-windows-x64-setup.exe` | NSIS installer including WebView2 offline setup |
| `Museamo-VERSION-windows-x64.exe` | Standalone app requiring installed WebView2 |
| `Museamo-VERSION-macos-arm64.app.tar.gz` | App bundle archive retaining bundle modes and symlinks |
| `Museamo-VERSION-macos-arm64.dmg` | Apple Silicon disk image |
| `Museamo-VERSION-linux-x64.deb` | Debian package |
| `Museamo-VERSION-linux-x64.AppImage` | Linux AppImage |
| `Museamo-VERSION-source.zip` | Corresponding committed source |
| `SHA256SUMS.txt` | Checksums for downloads and release notes |
| `manifest.json` | Assembly, build metadata, and verification receipts |
| `release-notes.md` | Version notes and download/update guidance |

Only selected platform downloads appear. Published artifacts must match this assembly exactly.

## Explicit publication

Review the assembly, then validate it and publish using its explicit path:

```sh
npm run release:verify -- --directory releases/VERSION/assembly-XXXXXX
npm run release:publish -- --directory releases/VERSION/assembly-XXXXXX
```

Bundle verification checks integrity and all platform verification receipts. It does not rerun tests on the publication host. Local publication repeats validation, requires the current clean commit and a branch, and rejects an already published version before creating a tag or pushing. It creates `vVERSION`, atomically pushes the current branch and tag to `origin`, uploads a draft, and publishes after uploads succeed. CI uses `release:publish -- --ci --directory PATH`: it requires GitHub Actions, an existing annotated reservation, and the matching remote tag; it never pushes a branch. Both modes use the configured GitHub repository.

An interrupted upload leaves a recoverable draft. Retry with the same clean commit and assembly. Publication copies the reviewed assembly to a separate snapshot before uploading. It downloads every new or existing draft asset and verifies its size and hash against the captured expectations, including release notes, the manifest, and checksum list. It rechecks the clean source and original assembly immediately before publishing. Existing draft assets must have identical bytes; they are verified and skipped, never clobbered. A mismatch leaves the draft unpublished. Unexpected or different draft assets stop publication for manual review. Published releases and their tags are immutable. Use a new version for a different download set, signing mode, or source. Do not run competing publishers for the same version.

Local build, verification, assembly, and publication commands never stage, commit, merge, force-push, change repository visibility, or upload ignored private files. Automatic preparation stages only the version files and generated notes in its isolated runner checkout and pushes only its new tag. The source archive comes from the release's committed tree.

## Before changing repository visibility

Confirm the chosen [license and asset rights](licensing.md), review the full Git history for secrets and restricted assets, and verify the first release on disposable devices. Ignoring or removing a file in a new commit does not remove it from older commits. The historical Trailhead font requires attention before making the existing history public. Repository visibility is a separate, explicit action.

References: [GitHub release CLI](https://cli.github.com/manual/gh_release_create) and [Tauri Windows distribution](https://v2.tauri.app/distribute/windows-installer/).

See the [local verification record](release-verification.md) for the initial validation results and remaining public-release work.
