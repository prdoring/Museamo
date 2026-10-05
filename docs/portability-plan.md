# macOS and Linux implementation plan

The implementation workstreams below have been regrouped into the [five-PR local review stack](pr-stack.md). Use that stack for current branch bases, review scopes, and verification status; the original worktrees remain available as historical references.

Implement Android build hosts and native desktop apps for macOS and Linux while preserving Windows behavior. Keep all branches and commits local; do not open PRs, push, tag, or publish releases. Initial desktop targets are Apple Silicon macOS and x64 Linux. Android distribution retains all four existing ABIs.

## Workstreams

| Local PR | Branch | Ownership and deliverable | Dependency |
| --- | --- | --- | --- |
| 0 | `portability/contracts` | Desktop information contract, OS module boundary, identity-provider seam, artifact contract | None |
| 1 | `portability/android-build` | Android Rust builder, Gradle wiring, wrapper executable mode; deterministic portable APK builds | None |
| 2 | `portability/identity` | Protected identity providers, persistence, error handling, isolated test provider | 0 |
| 3 | `portability/desktop-runtime` | External links, autostart, close/reopen/quit, tray fallback, native desktop information | 0 |
| 4 | `portability/desktop-ui` | Platform-aware controls, shortcuts, settings, capability-driven copy | 0; native acceptance needs 3 |
| 5 | `portability/packaging` | OS-specific Tauri configs, icons, toolchain setup, prerequisites, packaging | Starts independently; usable apps need 2–4 |
| 6 | `portability/release-tooling` | Platform build adapters, manifest collection and validation, explicit publishing | Artifact contract; integration needs 1 and 5 |
| 7 | `portability/ci-docs` | Build matrix, developer/release documentation, final integration | All implementation workstreams |

## Contracts and implementation details

The desktop information response reports `os`, `startupSupported`, `windowControls` (`native` or `custom`), and `closeBehavior` (`background` or `quit`). Keep `desktop` as the existing frontend bridge platform. Preview implementations must describe themselves truthfully and stay separate from native persistence.

Introduce an identity storage boundary. Preserve the Windows DPAPI format; use macOS Keychain and Linux Secret Service for new platforms. Scope credentials to a library/device. Distinguish missing credentials from locked or inaccessible stores. Never replace an identity after an unlock failure, and never fall back to unprotected private-key storage. Tests use a test-only provider. Handle interrupted creation and stable reopening.

Android work pins NDK 30.0.14904198, invokes Cargo with `--locked`, respects its output directory, validates supported host architectures, prevents stale ABI libraries, and commits the Gradle wrapper executable bit. Use JDK 21, SDK 36, build-tools 36.0.0, and the committed Gradle wrapper. Preserve environment-based release signing and the existing signing identity.

Desktop runtime work keeps URL scheme validation, replaces Windows-only browser opening, implements or honestly disables startup, and makes Quit/reopen available without a Linux tray. macOS needs Dock reopening and appropriate window controls. Preserve single-instance behavior. UI work consumes runtime capabilities, supports Command shortcuts on macOS, and removes Windows-only copy.

Packaging separates `tauri.windows.conf.json`, `tauri.macos.conf.json`, and `tauri.linux.conf.json`. Add app/DMG and Debian/AppImage bundles, required icons, macOS local-network declarations, and Linux media support. Choose explicit browser/OS baselines. Mac signing/notarization configuration must not require secrets for local compilation. Build Linux packages on the oldest supported Linux baseline.

Release tooling separates build, assembly, verification, and publication. Artifact metadata includes schema, version, commit, clean-source status, target, kind, filename, byte size, and SHA-256. Reject inconsistent commits/versions, missing or duplicate artifacts, path traversal, stale bytes, and incompatible signing/release modes. Keep dirty previews unpublishable and debug APKs prereleases. Keep Windows saved signing support; Unix hosts use complete explicit signing variables. Preserve published-release immutability. Build commands must not push or publish.

## Coordination

Use one coordinator and three workers, all spawned workers using Sol 6.1 with high reasoning. Start Android, packaging, and release preparation while the coordinator implements contracts. Then allocate available workers to identity, runtime, and UI. Start dependent work after its contract commit exists, not after a fixed delay.

Each worker has an isolated worktree and owns its branch. Workers may commit locally. Do not change other worktrees. The coordinator integrates commits into `mac-build` and resolves shared manifests/lockfiles. Packaging owns Tauri config; runtime owns `main.rs`; UI owns frontend presentation. Dependency changes must be reported explicitly. Keep mutable build outputs and npm installations separate per worktree.

Every handoff states branch/commits, behavior changed, owned and extra files changed, checks performed, blocked checks, tests prepared but not executed, exact user test commands, and remaining dependencies.

## Verification

Per user instructions, agents must not run tests, including indirectly through existing release commands. Typecheck, lint, compilation, syntax checks, and packaging are allowed. Do not claim runtime acceptance from compilation alone. Add meaningful tests for identity lifecycle, release validation, and platform behavior where warranted.

The final user handoff should request frontend and release-tool tests, `cargo test --workspace --locked -- --test-threads=1`, Android unit tests, and disposable-device native checks. Verify saved data and identity after restart; backup import/export; links and media; window close/reopen/quit; startup settings; permission denial/recovery; and Android-to-desktop discovery/sync. Signing, notarization, Linux runtime checks, and hardware/device checks remain explicitly pending until performed.

## Local execution record

Base: `886124e` on `mac-build`. The initial checkout is clean. Node 24 and Xcode are available; Rust, Android SDK tools, and npm dependencies were not available in the initial environment. No tests have been run.

The integration branch is `mac-build`. Workstream branches are local snapshots for review; follow-up fixes and combined lockfile reconciliation live on the integration branch. No PRs, pushes, tags, or releases were created.

| Workstream | Local worktree | Implementation |
| --- | --- | --- |
| Contracts | Main checkout; `portability/contracts` at `5df8b5c` | Native desktop capabilities and honest preview response. The identity seam was delivered with the identity provider; artifact contracts with release tooling. |
| Android | `/private/tmp/Museamo-android-build` | `0139485`: pinned toolchain inputs, host selection, locked Cargo builds, isolated outputs, stale ABI cleanup, executable wrapper, prepared builder tests. |
| Identity | `/private/tmp/Museamo-identity` | `38010b0`: protected providers, interrupted-write recovery, scoped references, isolated test provider, preserved DPAPI format. Branch lockfile is `9bd4bc8`; integration commit `65353ed` reconciles it with runtime dependencies and rechecks journal migration under the database lock. |
| Desktop runtime | `/private/tmp/Museamo-desktop-runtime` | `ae80f22`: portable URL opening, startup, macOS Dock/menu reopening, truthful tray/close behavior. Integration fix `edc200c` rejects startup paths the upstream launcher cannot safely encode. |
| Desktop UI | `/private/tmp/Museamo-desktop-ui` | `1d07c62`: validated/cached capabilities, native window controls, Command shortcuts, startup availability and error recovery. |
| Packaging | `/private/tmp/Museamo-packaging` | `6ac7442`: OS-specific bundles, icon, toolchain pin, doctor, browser baselines and packaging docs. |
| Release tooling | `/private/tmp/Museamo-release-tooling` | `f8aa786`, `0eb9b02`, `cb9b5dd`: independent platform builds, verified assembly, explicit publication, Linux baseline enforcement, publication snapshots and uploaded-byte verification. |
| CI and docs | `/private/tmp/Museamo-ci-docs` | `93584ce`: Windows/macOS/Linux compilation and bundle matrix, retained Android checks, updated development and release documentation. Final execution notes are on `mac-build`. |

Three Sol 6.1 high workers handled Android/identity, packaging/UI, and release tooling. The coordinator handled contracts, runtime, integration and CI. Workers also reviewed identity storage independently. Mutable build outputs remained in their respective worktrees.

### Decisions established during implementation

- macOS uses native titlebar controls and Dock reopening. Windows hides to the background only when its tray was created successfully. Linux closes and quits because tray creation alone does not establish that a usable tray is visible.
- macOS minimum is 14, with Apple Silicon as the first target. Linux release builds require Ubuntu 22.04 x64. The frontend targets Safari 16.4/Chrome 111; Linux requires WebKitGTK 2.44 or newer because the existing Tailwind 4 styles need modern browser support.
- Linux identity persistence requires a usable Secret Service and macOS uses Keychain. There is no plaintext fallback. Windows keeps the existing DPAPI representation. Copying a Windows database to another OS does not migrate its protected key; portable backup import is the supported path.
- Autostart is unavailable for isolated debug data directories. Enabling it rejects paths containing characters the upstream launcher cannot encode safely; use `/Applications` on macOS and a simple Linux install path. Disabling it remains possible.
- Builds and assembly do not run tests or publish. Verification is an explicit command that runs tests and records a receipt; publication checks source/artifact consistency and requires receipts for each selected platform. Receipts are local verification records, not cryptographic attestations. Concurrent publishers are unsupported.

### Validation and handoff

Completed checks include frontend TypeScript and production builds, Node script syntax, Gradle wrapper shell syntax, macOS plist validation, CI YAML parsing, desktop doctor, release preflight, and integrated macOS Rust compilation of both production and test targets (`cargo check --workspace` and `cargo check --workspace --tests --locked`). Compiling test targets did not execute tests. New tests were prepared but not executed. Existing Vite asset-placeholder and chunk-size warnings remain; generated CSS inspection found no unresolved asset placeholders.

The integrated source at `65353ed` also produced an optimized Apple Silicon executable, `target/aarch64-apple-darwin/release/bundle/macos/Museamo.app` (15.89 MiB), and `target/aarch64-apple-darwin/release/bundle/dmg/Museamo_0.4.0_aarch64.dmg` (6.77 MiB). The build command was `npm run desktop:build -- --target aarch64-apple-darwin --no-sign --ci -- --locked`. The DMG step required running outside the filesystem sandbox to create/mount its temporary image. Static inspection confirmed the arm64 binary and packaged minimum-system/local-network plist entries. The release compiler reported one existing debug-only mutable-variable warning in `main.rs`. These are unsigned local preview bundles; the app was not launched and native credential prompts were not exercised. Only this execution-record document was uncommitted during packaging.

The local checks used Node 24.7.0; CI and `.nvmrc` select Node 22. Rust 1.99.0 was installed outside the checkout for these checks. In this session its commands use:

```sh
export PATH=/private/tmp/museamo-tools/cargo/bin:$PATH
export CARGO_HOME=/private/tmp/museamo-tools/cargo
export RUSTUP_HOME=/private/tmp/museamo-tools/rustup
```

These temporary paths are session setup, not project prerequisites. A normal Rust installation honoring `rust-toolchain.toml` is sufficient. See [desktop-packaging.md](desktop-packaging.md) for native dependencies and [development.md](development.md) for local commands.

Linux and Windows compilation/bundling, Android builds with JDK 21 and SDK/NDK, native credential prompts and recovery, GUI/media behavior, startup, signing/notarization, and device discovery/sync remain target-environment acceptance work. CI jobs are configured but have not run remotely.

As the final verification step, the user should run these suites and report failures:

```sh
npm test
npm run test:release
node --test scripts/build-sync-android.test.mjs
cargo test --workspace --locked -- --test-threads=1
```

On a configured Android host, also run `npm run android:sync-core -- --release`, `npm run android:sync`, then `./gradlew :app:testDebugUnitTest :app:lintDebug -PsyncCoreRelease` from `android/`. Run connected instrumentation tests on a disposable emulator/device. Native manual acceptance is listed in [desktop-packaging.md](desktop-packaging.md). Do not treat the historical Windows results in `release-verification.md` as validation of these changes.
