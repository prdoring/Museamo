# Local builds and GitHub Releases

All downloadable binaries are built on the maintainer's Windows PC. GitHub Actions checks source and retains test reports; it does not create or publish release binaries.

## One-time setup

Install the [development prerequisites](development.md) for both Android and Windows, plus [GitHub CLI](https://cli.github.com/). Sign in with `gh auth login`. Set `JAVA_HOME` to JDK 21 and `ANDROID_HOME` to your Android SDK. Install all four Rust Android targets.

Run `npm run release:setup` to install the repository's local pre-push guard. It sets this checkout's `core.hooksPath` to `.githooks`, and refuses to overwrite another hook directory. After setup, direct pushes to `origin` are blocked with instructions to use the release command, so downloads are built before a push. The hook is local: collaborators must install it in their own checkout if they want the same behavior. GitHub does not enforce local hooks.

## Android signing

Public stable APKs need a dedicated signing key. On Windows, set it up once:

```sh
npm run release:signing
```

Run this setup in the terminal you will use for releases. An agent's execution environment can have a different view of user-profile storage even when the Windows account and displayed paths match; successful agent-side checks do not establish that your terminal is configured.

With no signing variables set, this creates a 4096-bit RSA key valid for 10,000 days in `%LOCALAPPDATA%\Museamo\release-signing\museamo-release.p12`. The keystore password is randomly generated and saved in `signing.json` using Windows account encryption (DPAPI). Access to the directory is restricted to your account, administrators, and SYSTEM. These files stay outside the repository. Repeating setup verifies the existing key; it never replaces it.

`npm run release` and signed `release:build` commands load the saved key automatically. Passwords are passed to build tools only in their process environment, never in command-line arguments, release manifests, or GitHub secrets.

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

Partial overrides are rejected rather than mixed with saved credentials. If a previously configured key is missing or cannot be decrypted, restore the original key; generating a replacement would prevent existing users from receiving ordinary updates. The Gradle release build refuses an unsigned APK. See [Android's signing documentation](https://developer.android.com/studio/publish/app-signing) and [Microsoft's DPAPI documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertfrom-securestring).

Run signing setup, backup, and releases under the same Windows account. Use `whoami` to check the terminal's account. A Codex sandbox account cannot read a key protected for your normal Windows account; run these commands in your normal Windows terminal. The helper reports the account and configuration path when a configuration is missing or inaccessible. Do not create a replacement key or loosen its permissions to work around a different account.

To preserve compatibility with current debug-key installations, choose `--android debug`. It builds a debug-signed APK with optimized Rust libraries and automatically marks the GitHub release as a **prerelease**. Keep using the same PC's debug keystore for updates; a newly generated debug key will not match existing installations. Never distribute your private keystore.

Changing from a debug key to a release key prevents an ordinary in-place update. Export the saved library first. Drafts are not in the export. Keep the original app installed until you have a verified backup.

## Prepare a version

1. Set the same `major.minor.patch` in `package.json`, `package-lock.json` (including its root package), `Cargo.toml`, and `desktop/tauri.conf.json`.
2. Set Android's `versionName` to the same value and increase its `versionCode` in `android/app/build.gradle`.
3. Refresh `Cargo.lock` so both Museamo packages have that version.
4. Write `docs/release-notes/VERSION.md`, update screenshots if behavior changed, and commit everything intended for that release.
5. Run `npm run release:check`. It rejects mismatched versions, missing notes, and a dirty checkout.

Use a fresh version for every published release. Never move a published tag to new source or replace its downloads. This applies when moving from a test prerelease to a stable signed build.

## Build, push, and publish

For a stable signed release:

```sh
npm run release
```

For a test release compatible with debug installations:

```sh
npm run release -- --android debug
```

Close preview servers before building: Windows can lock native dependencies while a preview is running. This command installs locked frontend dependencies, runs release-tooling/frontend/Rust tests, builds the web interface, builds all Android ABIs and the APK, runs Android unit/lint checks, and builds the x64 Windows EXE and NSIS installer. It records file sizes and SHA-256 checksums, creates a source archive from the committed tree, and checks that source stayed clean.

Only after builds pass does it create `vVERSION`, atomically push the current branch and tag to `origin`, and upload a GitHub release draft. It publishes the draft after all downloads upload successfully. Debug APKs become prereleases; signed release APKs become stable releases unless `--prerelease` was requested.

The command uses the configured GitHub repository, so forks are supported. Run it from the branch you want to push. It never stages, commits, merges, force-pushes, changes repository visibility, or uploads ignored local files.

## Review locally before publishing

```sh
npm run release:build
# Or a debug-signed local preview of your current working changes:
npm run release:build -- --android debug --allow-dirty
```

Files appear under ignored `releases/VERSION/`:

| File | Purpose |
| --- | --- |
| `Museamo-VERSION-android.apk` | Signed stable Android build |
| `Museamo-VERSION-android-debug.apk` | Alternative test prerelease |
| `Museamo-VERSION-windows-x64-setup.exe` | NSIS installer including WebView2 offline setup |
| `Museamo-VERSION-windows-x64.exe` | Standalone app; needs installed WebView2 |
| `Museamo-VERSION-source.zip` | Corresponding committed source |
| `SHA256SUMS.txt` | Checksums for downloads and release notes |
| `manifest.json` | Source commit, version, Android mode, sizes, hashes, and local build time |
| `release-notes.md` | Version notes plus installation/update guidance |

A dirty preview is explicitly marked and cannot be published. Its source archive contains only the committed tree, so rebuild cleanly for an actual release.

Inspect the APK on a disposable device and the installer on Windows before a public release. The local automated checks do not substitute for launcher, firewall, Wi-Fi, codec, or installer smoke tests.

After reviewing a **clean** bundle, publish it without rebuilding:

```sh
npm run release:publish
```

It verifies the current commit and every asset checksum before pushing or uploading. A failed build never pushes. A failed upload leaves a draft; retry `release:publish` from the same clean commit to complete it. A published release is never overwritten.

## Before changing repository visibility

Confirm the chosen [license and asset rights](licensing.md), review the full Git history for secrets and restricted assets, and verify the first release on disposable devices. Ignoring or removing a file in a new commit does not remove it from older commits. The historical Trailhead font requires attention before making the existing history public. Repository visibility is a separate, explicit action.

References: [GitHub release CLI](https://cli.github.com/manual/gh_release_create) and [Tauri Windows distribution](https://v2.tauri.app/distribute/windows-installer/).

See the [local verification record](release-verification.md) for the initial validation results and remaining public-release work.
