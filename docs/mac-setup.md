# Mac setup

Build Museamo on macOS, install it on an Android phone, and keep a reusable Android release key in 1Password. Commands use the Mac's default zsh shell. Replace `/Users/mark/personal/Museamo` with your checkout path when using another machine.

If the debug APK already builds, start at [Choose the Android signing key](#choose-the-android-signing-key). You can install that debug APK immediately without creating a release key. Complete the permanent Rust setup below if your shell still uses `/private/tmp/museamo-tools`.

## Install Rust permanently

1. Remove the earlier `/private/tmp/museamo-tools` exports from `~/.zshrc` or `~/.zprofile` if you added them there. These were temporary session settings. Open a new terminal, then clear any inherited overrides and install Rust into your user account:

   ```zsh
   unset CARGO_HOME RUSTUP_HOME
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

   Choose the standard installation. It uses `~/.cargo` and `~/.rustup`; do not use `sudo`. This is the [official rustup installation](https://rust-lang.org/tools/install/).

2. Load its environment in this terminal:

   ```zsh
   source "$HOME/.cargo/env"
   command -v cargo
   rustup show home
   ```

   Expect `~/.cargo/bin/cargo` and `~/.rustup`, expanded to your home directory. Neither should point into `/private/tmp`. If needed, add this line once to `~/.zshrc` so new interactive terminals load it:

   ```zsh
   source "$HOME/.cargo/env"
   ```

3. Install the repository's pinned toolchain and Android targets:

   ```zsh
   cd /Users/mark/personal/Museamo
   rustup toolchain install 1.99.0 --profile minimal --component rustfmt --component clippy
   rustup target add --toolchain 1.99.0 \
     aarch64-linux-android armv7-linux-androideabi \
     i686-linux-android x86_64-linux-android
   cargo --version
   ```

   `rust-toolchain.toml` selects the pinned compiler inside this checkout. A new permanent installation downloads its own toolchain and crates; the temporary cache is not required. Repeat the version/target setup when the project's toolchain pin changes.

## Install Node, Java, and the Android SDK

Use Node 22, matching `.nvmrc`, or a newer supported Node version. Install [Android Studio](https://developer.android.com/studio) and [Temurin JDK 21](https://adoptium.net/temurin/releases/?version=21&os=mac&arch=aarch64). Choose the matching CPU architecture for your Mac. Do not assume Android Studio's bundled Java has the required version.

In Android Studio's SDK Manager, install Android SDK Command-line Tools. Check the SDK location; the commands below use its usual Mac location. Add these non-secret settings once to `~/.zshrc`, then open a new terminal:

```zsh
export JAVA_HOME=$(/usr/libexec/java_home -v 21)
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

Install the versions pinned by this project and review the SDK license prompts:

```zsh
java -version
sdkmanager "platform-tools" "platforms;android-36" \
  "build-tools;36.0.0" "ndk;30.0.14904198"
sdkmanager --licenses
```

The Gradle wrapper is committed; a separate Gradle installation is unnecessary. Leave `ANDROID_NDK_HOME` unset unless you deliberately want to override the pinned NDK. See [Android's SDK manager documentation](https://developer.android.com/tools/sdkmanager).

## Choose the Android signing key

Every APK is signed. `assembleDebug` uses an automatically generated debug key, normally `~/.android/debug.keystore`. That is enough for a local phone install. A release key is a separate, long-lived identity for APKs you intend to keep updating and share. [Android signing documentation](https://developer.android.com/studio/publish/app-signing)

- **First release key:** if neither you nor another maintainer has distributed a release-signed Museamo APK, create one below. Once used, all release builders should restore and reuse it.
- **Existing release installation:** obtain its original keystore and passwords from the maintainer or backup. Creating a new key will not produce an ordinary compatible update.
- **Existing debug installation:** continue using its original debug key for debug updates, or export the saved library before moving to a release-signed installation. Debug and release builds currently use the same app ID, so they cannot coexist. A signature mismatch will block an in-place update. Uninstalling deletes app data; backups exclude unfinished drafts.

These instructions cover direct APK installation, which needs no Play Store account. This Android signing key is separate from Apple signing and from Museamo's per-device sync identity.

## Create the first release key

Do this once for the project, not once per developer or computer. The repository's `npm run release:signing` and `release:signing:backup` helpers are Windows-only. On Mac, use JDK 21's `keytool`.

Create a 1Password item named `Museamo Android release signing` and generate a strong random password there, for example 32 characters. Keep it available for the interactive prompt. Then run:

```zsh
(
  set -e
  umask 077
  signing_dir="$HOME/.config/museamo/signing"
  mkdir -p "$signing_dir"
  chmod 700 "$signing_dir"
  if [[ -e "$signing_dir/museamo-release.p12" ]]; then
    printf 'Keystore already exists. Reuse it; do not replace it.\n' >&2
    exit 1
  fi
  "$JAVA_HOME/bin/keytool" -genkeypair -v \
    -storetype PKCS12 \
    -keystore "$signing_dir/museamo-release.p12" \
    -alias museamo-release \
    -keyalg RSA -keysize 4096 -validity 10000
  chmod 600 "$signing_dir/museamo-release.p12"
)
```

Paste the password at the hidden prompt, confirm it, and answer the certificate identity questions. Those identity fields become public certificate metadata in your APK, so use the appropriate publisher identity. For this PKCS12 setup, use the same password for the keystore and private key. Do not put passwords in command arguments, shell startup files, or the repository. The command creates an encrypted keystore outside the checkout and refuses an existing destination. [JDK keytool reference](https://docs.oracle.com/en/java/javase/21/docs/specs/man/keytool.html)

Inspect the result, entering its password when asked:

```zsh
"$JAVA_HOME/bin/keytool" -list -v -storetype PKCS12 \
  -keystore "$HOME/.config/museamo/signing/museamo-release.p12" \
  -alias museamo-release
```

Confirm the entry is `PrivateKeyEntry`. Record its SHA-256 certificate fingerprint in 1Password. A public certificate or fingerprint alone cannot sign an APK; the `.p12` containing the private key is essential.

## Store and share the key in 1Password

Keep the following together in the signing item:

| Field | Value |
| --- | --- |
| File attachment | `museamo-release.p12` |
| Keystore type | `PKCS12` |
| Key alias | `museamo-release` |
| Keystore password | The generated password, in a password field |
| Key password | The same password for this new key, in a password field |
| Certificate SHA-256 | The fingerprint from `keytool` |
| Android application ID | `com.prdoring.museamo` |
| Notes | Creation date, key owner, and link to this guide |

In the Mac 1Password app, edit the item and choose **Add More > Attach a File**, select the `.p12`, and save. Alternatively, use a Document item. Put it in a shared vault available to the maintainers who need to sign builds. Anyone with the file and password can sign Museamo APKs. [1Password file instructions](https://support.1password.com/files/) and [vault sharing](https://support.1password.com/create-share-vaults/).

Before relying on the backup, download its attachment to a separate private folder and run `keytool -list -v -storetype PKCS12 -keystore /path/to/downloaded-file.p12 -alias museamo-release`. Confirm `PrivateKeyEntry` and the same fingerprint using the password stored in 1Password.

On another Mac, download that same attachment to `~/.config/museamo/signing/museamo-release.p12`, creating the directory with mode `700` and setting the file to mode `600`. Reuse the stored alias and passwords. Do not generate a new key. Each computer's local path can differ; the key must remain the same. The APK is the file you share with app users; the keystore is only for signers.

## Build an APK

Run commands from the repo root. Both build paths package all four Android ABIs when `SYNC_ANDROID_ABIS` is unset. They do not publish anything or execute tests.

### Debug build

No release password is needed:

```zsh
cd /Users/mark/personal/Museamo
unset SYNC_ANDROID_ABIS
npm ci
npm run android:sync
(cd android && ./gradlew :app:assembleDebug -PsyncCoreRelease)
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`.

### Release build using the shared key

Paste the password from 1Password at the prompt. This zsh subshell exposes the signing values only to its build processes and discards them when it exits. It uses the same store/key password established above; when importing an older key with different passwords, prompt for its key password separately instead of copying the store password.

```zsh
cd /Users/mark/personal/Museamo
(
  set +x
  set -e
  unset SYNC_ANDROID_ABIS
  export MUSEAMO_KEYSTORE="$HOME/.config/museamo/signing/museamo-release.p12"
  export MUSEAMO_KEY_ALIAS="museamo-release"
  read -rs 'MUSEAMO_STORE_PASSWORD?Keystore password from 1Password: '
  printf '\n'
  [[ -n "$MUSEAMO_STORE_PASSWORD" ]] || exit 1
  export MUSEAMO_STORE_PASSWORD
  export MUSEAMO_KEY_PASSWORD="$MUSEAMO_STORE_PASSWORD"

  npm ci
  npm run android:sync
  (cd android && ./gradlew --no-daemon :app:assembleRelease)
  "$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose --print-certs \
    android/app/build/outputs/apk/release/app-release.apk
)
```

Output: `android/app/build/outputs/apk/release/app-release.apk`. Compare the reported signer certificate SHA-256 with the value in 1Password, ignoring colon separators and letter case. Install only after the build and verification both succeed. Build failures can leave older output files behind.

For a formal release with a manifest, use `npm run release:build -- --platform android` inside the same password-loading subshell in place of the direct npm/Gradle build commands. That path requires a clean, version-consistent checkout and performs APK signature and ABI checks. An optional `MUSEAMO_ANDROID_CERT_SHA256` environment variable pins the expected certificate using 64 hex characters without colons. See [releases.md](releases.md) for versioning and later assembly; building alone never publishes. Increase Android's `versionCode` for future distributed updates.

## Install on your phone

1. Enable Developer options and USB debugging on the phone. Connect it with a data-capable USB cable, unlock it, and accept the computer authorization prompt.
2. Run `adb devices`. The phone should appear with status `device`. For `unauthorized`, check the prompt; for an empty list, check the cable and USB connection. [Android device setup](https://developer.android.com/studio/run/device)
3. Choose the APK you built, then run one of these from the repo root:

   ```zsh
   # Debug APK:
   adb -d install -r android/app/build/outputs/apk/debug/app-debug.apk

   # Or release APK:
   adb -d install -r android/app/build/outputs/apk/release/app-release.apk
   ```

   `-d` selects the USB device. With multiple USB devices, use `adb -s PHONE_SERIAL install -r ...`. `-r` preserves app data during a compatible update. [ADB reference](https://developer.android.com/tools/adb)

4. Open Museamo from its launcher icon. The app requires Android 7/API 24 or newer and Android System WebView 111 or newer.

If installation reports `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, the installed app likely has a different signing key. Keep it installed while you export and verify a backup, then decide whether to obtain the matching key or migrate to a fresh installation. Do not use an uninstall as an automatic retry. For `INSTALL_FAILED_VERSION_DOWNGRADE`, use an appropriately newer build rather than bypassing the version check.

## Next steps

1. On Android, save a thought and attachment, restart the app, and confirm persistence. Check backup export/import using a disposable library.
2. Install and check the Mac app. Build it with `npm run desktop:build -- --target aarch64-apple-darwin --no-sign -- --locked`; see [desktop packaging](desktop-packaging.md) for Xcode prerequisites and output paths. Check Keychain access, persistence, media, links, window reopening, and startup.
3. Put the Mac and phone on the same network, allow local-network access, link them, and check sync in both directions.
4. Build and verify Linux and Windows on their native hosts. Their configurations are prepared; native acceptance remains pending.
5. Review the local branches after fixes. The workstream record is in [portability-plan.md](portability-plan.md). No PR publication is part of this setup.

Run tests as the final verification step and report failures. From the repo root:

```zsh
npm test
npm run test:release
node --test scripts/build-sync-android.test.mjs
cargo test --workspace --locked -- --test-threads=1
(cd android && ./gradlew :app:testDebugUnitTest :app:lintDebug -PsyncCoreRelease)
```

Rust workspace tests require the Mac desktop prerequisites. If only Android is configured, use `cargo test -p museamo-sync-core --locked` for now and run the full workspace suite after setting up desktop builds. Run connected Android instrumentation tests only on a disposable emulator or device because they can alter app data.
