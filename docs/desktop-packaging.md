# Desktop packaging

The initial desktop targets are Apple Silicon macOS (`aarch64-apple-darwin`), Linux x64 (`x86_64-unknown-linux-gnu`), and the existing Windows x64 build (`x86_64-pc-windows-msvc`). Build packages on their native OS and architecture. Other desktop architectures are not part of the initial distribution.

## Supported systems and browser engines

| Target | Minimum system | Frontend engine |
| --- | --- | --- |
| macOS arm64 | macOS 14 | System WKWebView, Safari 16.4 or later |
| Linux x64 | Ubuntu 22.04 with security updates | WebKitGTK 4.1 API, library version 2.44 or later |
| Windows x64 | Windows 10 | WebView2 111.0.1661.41 or later |

The shared frontend targets Chrome 111 and Safari 16.4. [Tailwind 4 requires these browser versions](https://tailwindcss.com/docs/compatibility). Android devices also need Android System WebView 111 or later. An older JavaScript compilation target does not provide the CSS features Tailwind needs.

Build Linux packages on an updated Ubuntu 22.04 x64 system. A newer build host can introduce a newer glibc requirement, even for an AppImage. Tauri documents this [Linux build baseline requirement](https://v2.tauri.app/distribute/appimage/#limitations). Other Linux distributions remain subject to native verification. Ubuntu's updated x64 [WebKitGTK package](https://packages.ubuntu.com/jammy/libwebkit2gtk-4.1-0) supplies a recent engine; the original unpatched Ubuntu 22.04 package does not meet this app's browser floor.

## Shared tools

Install Node.js 22 or later and [rustup](https://rust-lang.org/tools/install/). The committed `rust-toolchain.toml` pins Rust 1.99.0 with rustfmt and clippy. This is the [stable compiler released on October 1, 2026](https://blog.rust-lang.org/2026/10/01/Rust-1.99.0/). Keep `Cargo.lock` and `package-lock.json` committed and use their locked dependencies.

```sh
rustup toolchain install 1.99.0 --profile minimal --component rustfmt --component clippy
npm ci
npm run desktop:doctor
```

The doctor reports prerequisites and exits nonzero when a required build tool is missing. It does not install tools, build, run tests, sign, or publish. `--target` selects one of the triples above. `--release` also requires the Ubuntu 22.04 Linux package baseline.

## macOS

Install Xcode or its Command Line Tools, finish setup, and select the developer directory. Desktop builds do not require the full iOS SDK. See [Tauri's macOS prerequisites](https://v2.tauri.app/start/prerequisites/#macos).

```sh
xcode-select --install
rustup target add --toolchain 1.99.0 aarch64-apple-darwin
npm run desktop:doctor -- --target aarch64-apple-darwin
npm run desktop:build -- --target aarch64-apple-darwin -- --locked
```

macOS uses native window decorations. `desktop/Info.plist` permits [local networking through App Transport Security](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking) for the loopback media server. It also supplies a local-network usage description and declares `_museamo._tcp` and `_museamo-share._tcp` for device and shared-tag discovery. Apple documents [the usage description](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocalnetworkusagedescription) and [Bonjour service declaration](https://developer.apple.com/documentation/bundleresources/information-property-list/nsbonjourservices). Permission denial and recovery must be checked in the packaged app.

Local compilation needs no Apple certificate, developer account, or notarization password. No signing identity or secrets are committed. For distribution, provide signing/notarization credentials through the publishing environment and follow [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/). A local app or DMG is not evidence of notarization or Gatekeeper acceptance.

## Linux

Use Ubuntu 22.04 x64 with security repositories enabled and apply updates before building. These packages cover Tauri compilation, package tools, media plugins, portals, and a Secret Service provider.

```sh
sudo apt update
sudo apt install build-essential pkg-config curl wget file patchelf libfuse2 libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libdbus-1-dev libayatana-appindicator3-dev librsvg2-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav xdg-desktop-portal xdg-desktop-portal-gtk gnome-keyring
rustup target add --toolchain 1.99.0 x86_64-unknown-linux-gnu
npm run desktop:doctor -- --target x86_64-unknown-linux-gnu --release
npm run desktop:build -- --target x86_64-unknown-linux-gnu -- --locked
```

The Debian package declares the WebKitGTK browser floor and GStreamer plugins. AppImage enables Tauri's [media-framework bundling](https://v2.tauri.app/distribute/appimage/#multimedia-support-via-gstreamer), which requires the plugins to exist on the build host. Codec and hardware playback still need native checks. AppImage operation also needs a working graphical session; systems without FUSE can use the AppImage's `--appimage-extract-and-run` option.

Use a running, unlocked Secret Service provider such as GNOME Keyring in the user's desktop session. Installing the package alone does not unlock it. Verify saving and reopening the device identity after restart, including denial and unlock recovery. File dialogs require a working desktop portal backend. The Linux app uses custom window controls, and close/reopen behavior must work when the desktop has no tray.

Startup registration currently requires a Linux application path without spaces or special characters. Put an AppImage in a simple path such as `~/Applications/Museamo.AppImage` before enabling startup. On macOS, use `/Applications/Museamo.app`; paths containing XML special characters are rejected. This guards a formatting limitation in the pinned startup library instead of creating a broken login entry. Disabling an existing registration remains available.

## Windows

Keep the Visual Studio C++ build tools, Windows SDK, and current WebView2 Evergreen Runtime installed. See [Tauri's Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows).

```powershell
rustup target add --toolchain 1.99.0 x86_64-pc-windows-msvc
npm run desktop:doctor -- --target x86_64-pc-windows-msvc
npm run desktop:build -- --target x86_64-pc-windows-msvc -- --locked
```

Windows retains custom decorations and the NSIS installer with its offline WebView2 installer. The installer requests an update when an existing WebView2 runtime is older than the frontend browser floor. Existing saved signing support belongs to the release tooling.

## Configuration and artifacts

Tauri automatically merges `desktop/tauri.<platform>.conf.json` with `desktop/tauri.conf.json`. See [platform-specific configuration](https://v2.tauri.app/reference/config/#platform-specific-configuration). JSON arrays replace the corresponding common array, so the macOS override repeats the complete main-window definition to enable native decorations.

| Target | Output under `target/<Rust target>/release/` |
| --- | --- |
| macOS | `bundle/macos/Museamo.app`, `bundle/dmg/*.dmg` |
| Linux | `bundle/deb/*.deb`, `bundle/appimage/*.AppImage` |
| Windows | `museamo-desktop.exe`, `bundle/nsis/*-setup.exe` |

The app directory can be archived by release tooling for distribution alongside the DMG. The package and the release manifest must refer to the same version and source commit. Building these artifacts does not push, tag, publish, or run tests.

The PNG, ICO, and ICNS bundle icons are committed. To regenerate all platform exports from `src/assets/branding/lantern.json`, run `node scripts/generate-branding.mjs --platform-icons` after installing npm dependencies. Generated intermediate files stay ignored.

## Native acceptance still required

On each supported desktop, open the built package and verify text and colors, media playback, local-network permission denial/recovery, device discovery and sync, saved data and identity after restart, backup import/export, external links, window close/reopen/quit, and startup settings. On Linux, also verify an unlocked keyring, file portals, and a desktop without a tray. Signing, notarization, and Gatekeeper checks belong to distribution verification.

Run the repository's frontend, release-tooling, Rust, and Android tests as the final verification step and report the results to the implementing agent. Compilation and packaging do not establish runtime acceptance.
