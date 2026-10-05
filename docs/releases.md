# Local builds and GitHub Releases

Build each platform on its supported host from the same clean commit. Build, verification, assembly, and publication are separate commands. GitHub Actions checks source; local release commands create the reviewed downloads.

The old `npm run release` build-and-push shortcut is removed. It now checks release source only. `release:build` defaults to Windows and builds that platform only. Android needs `--platform android`. Publication requires an explicit reviewed assembly directory.

## One-time setup

Install the [development prerequisites](development.md) for the platform you are building. Publication also needs [GitHub CLI](https://cli.github.com/) and `gh auth login`. Android builders need JDK 21, SDK 36, build-tools 36.0.0, NDK 30.0.14904198, and all four Rust Android targets. Set `JAVA_HOME` and `ANDROID_HOME`. Use the committed Gradle wrapper.

Run `npm run release:setup` to install the repository's local pre-push guard. It sets this checkout's `core.hooksPath` to `.githooks`, and refuses to overwrite another hook directory. After setup, direct pushes to `origin` are blocked with instructions to build, verify, assemble, and explicitly publish. Only `release:publish` sets the hook override after validating the assembly. The hook is local: collaborators must install it in their own checkout if they want the same behavior. GitHub does not enforce local hooks.

## Android signing

For first-key creation on macOS, 1Password backup/sharing, and local signed APK installation, follow [Mac setup](mac-setup.md#choose-the-android-signing-key). If an existing release already has a signing key, restore that key instead of creating another.

Public stable APKs need a dedicated signing key. On Windows, set it up once:

```sh
npm run release:signing
```

Run this setup in the terminal you will use for releases. An agent's execution environment can have a different view of user-profile storage even when the Windows account and displayed paths match; successful agent-side checks do not establish that your terminal is configured.

With no signing variables set, this creates a 4096-bit RSA key valid for 10,000 days in `%LOCALAPPDATA%\Museamo\release-signing\museamo-release.p12`. The keystore password is randomly generated and saved in `signing.json` using Windows account encryption (DPAPI). Access to the directory is restricted to your account, administrators, and SYSTEM. These files stay outside the repository. Repeating setup verifies the existing key; it never replaces it.

On Windows, signed Android `release:build -- --platform android` commands load the saved key automatically. Passwords are passed to build tools only in their process environment, never in command-line arguments, release manifests, or GitHub secrets.

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

Bundle verification checks integrity and all platform verification receipts. It does not rerun tests on the publication host. Publication repeats validation, requires the current clean commit, and rejects an already published version before creating a tag or pushing. Only this explicit command creates `vVERSION`, atomically pushes the current branch and tag to `origin`, uploads a draft, and publishes after uploads succeed. It uses the configured GitHub repository, including forks.

An interrupted upload leaves a recoverable draft. Retry with the same clean commit and assembly. Publication copies the reviewed assembly to a separate snapshot before uploading. It downloads every new or existing draft asset and verifies its size and hash against the captured expectations, including release notes, the manifest, and checksum list. It rechecks the clean source and original assembly immediately before publishing. Existing draft assets must have identical bytes; they are verified and skipped, never clobbered. A mismatch leaves the draft unpublished. Unexpected or different draft assets stop publication for manual review. Published releases and their tags are immutable. Use a new version for a different download set, signing mode, or source. Do not run competing publishers for the same version.

The commands never stage, commit, merge, force-push, change repository visibility, or upload ignored private files. The source archive comes from the committed tree only.

## Before changing repository visibility

Confirm the chosen [license and asset rights](licensing.md), review the full Git history for secrets and restricted assets, and verify the first release on disposable devices. Ignoring or removing a file in a new commit does not remove it from older commits. The historical Trailhead font requires attention before making the existing history public. Repository visibility is a separate, explicit action.

References: [GitHub release CLI](https://cli.github.com/manual/gh_release_create) and [Tauri Windows distribution](https://v2.tauri.app/distribute/windows-installer/).

See the [local verification record](release-verification.md) for the initial validation results and remaining public-release work.
