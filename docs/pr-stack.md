# Local portability PR stack

The review stack contains five local branches, each based on the preceding branch. Base: `main` at `886124e`. The complete implementation was preserved on `mac-build` at `2d15582`, including the Mac setup guide. The final stack reproduces that snapshot, with only this handoff document and a link from the original plan added.

Stack reconstruction was completed locally without publishing branches, tags, PRs, or releases. This document records that reconstruction; subsequent publication and review are tracked by the GitHub PRs. The push hook and release publication behavior were preserved from the snapshot; changing those policies remains separate work.

## Branches and review bases

| PR | Head branch | Base branch | Worktree |
| --- | --- | --- | --- |
| 1 | `pr/portable-android-build` | `main` | `/private/tmp/Museamo-pr-1-android` |
| 2 | `pr/protected-desktop-identity` | `pr/portable-android-build` | `/private/tmp/Museamo-pr-2-identity` |
| 3 | `pr/desktop-platform-behavior` | `pr/protected-desktop-identity` | `/private/tmp/Museamo-pr-3-desktop` |
| 4 | `pr/desktop-packaging-ci` | `pr/desktop-platform-behavior` | `/private/tmp/Museamo-pr-4-packaging` |
| 5 | `pr/platform-release-workflow` | `pr/desktop-packaging-ci` | `/private/tmp/Museamo-pr-5-release` |

Each branch adds one commit. The original `portability/*` branches and worktrees remain historical workstream snapshots. Use `pr/*` for review and follow-up work. The main checkout stays on `mac-build`; it was not switched or reset. Git retains the branch commits even if temporary worktree directories are later removed.

Inspect an individual PR using its base, for example:

```sh
git diff --stat pr/protected-desktop-identity...pr/desktop-platform-behavior
git diff pr/protected-desktop-identity...pr/desktop-platform-behavior
```

Review all five concurrently if useful, but merge in numerical order. Do not merge a child PR into its unmerged feature-branch base just to make progress. Once a parent reaches `main`, retarget the next PR to `main`. If the parent was squash-merged, rebase the remaining stack onto the new main commit, excluding the old parent commits, before retargeting. If review changes a parent, update its descendants in order and rerun affected checks. Resolve shared manifests and lockfiles against each branch's actual dependency set.

## Suggested titles and descriptions

### PR 1: Make Android builds portable across development hosts

The Android native builder previously depended on host-specific tool discovery and could leave stale ABI libraries behind. Pin Node/Rust/NDK inputs, select the supported host toolchain, use locked Cargo builds, stage selected ABI outputs, and retain an executable Gradle wrapper. Repair the npm lockfile so clean installs work, wire builder checks into Android CI, and document the Android prerequisites.

Commit: `7785180`. Validation: clean npm dependency installation, TypeScript typecheck, Node and shell syntax, CI YAML parsing, and diff checks passed. Builder tests were prepared but not executed. An APK built from the earlier integration checkout was reported working by the user; this reconstructed branch was not used for a fresh APK build.

### PR 2: Protect desktop identities with native credential stores

Add macOS Keychain and Linux Secret Service storage while preserving the Windows DPAPI format. Persist scoped references, recover interrupted creation, reject missing/locked/changed credentials without replacing a ready identity, and use an isolated provider only in tests. Include the locked journal-migration recheck so concurrent openers do not repeat initialization.

Commit: `4cf5a78`. Validation: macOS `cargo check --workspace --locked --offline` and `cargo check --workspace --tests --locked --offline` passed. Compiling test targets did not execute them. Credential prompts/recovery and Windows/Linux compilation remain native verification work.

### PR 3: Adapt desktop behavior and controls to each platform

Introduce the desktop capability response and its frontend consumers together. Implement portable external links, startup, macOS Dock/menu reopening, truthful close behavior, native/custom controls, Command shortcuts, and visible capability errors. Include startup-path validation and the macOS native-window override in this PR so the UI cannot hide custom controls before native decorations exist.

Commit: `be95fc0`. Validation: clean npm installation, frontend typecheck/production build, macOS Rust production and test-target compilation passed. The native-window override is included here; complete app/installer packaging comes in PR 4. UI, startup, and lifecycle tests still need execution.

### PR 4: Package native desktop apps and validate bundles in CI

Split Tauri bundle configuration by OS and add macOS app/DMG plus Linux Debian/AppImage packaging. Include icons, local-network plist declarations, browser/system baselines, prerequisite checks, and the Windows/macOS/Linux CI matrix. Keep the existing release workflow intact until PR 5.

Commit: `b279288`. Validation: clean npm installation, frontend typecheck/production build, macOS Rust compilation, Mac prerequisite doctor, CI YAML parsing, plist validation, and diff checks passed. The earlier integration checkout produced unsigned Mac app/DMG bundles; packaging was not repeated during this history-only reconstruction. Windows/Linux bundles and native acceptance remain unverified.

### PR 5: Separate platform builds, verification, assembly, and publication

Replace the combined release flow with explicit platform builds, source/artifact manifests, verification receipts, assembly, and publication. Validate selected artifacts, preserve signing identity, enforce the Linux release baseline, and verify publication snapshots and uploaded bytes. Add the Mac setup/signing/1Password guide and complete release documentation. The policy that gates origin pushes through the local release hook is preserved; its redesign is outside this stack.

Validation: release scripts and the shell hook passed syntax checks, and `npm run release:check` passed on the committed branch. No tests, publication, signing, or private credential access were performed during reconstruction.

## Preservation and verification

Before adding this handoff, the staged final tree compared exactly equal to `2d15582`, including file modes and binary assets. The identity, startup, Bonjour, Linux dependency, and release-publication follow-up fixes are included in their owning PRs. No implementation was dropped or left only on a historical workstream branch.

The independent scope review checked PR boundaries and references to later files/commands. It caught and resolved the early macOS decoration dependency, mismatched Android browser documentation, and a release-documentation link that belonged in PR 5. This was not a replacement for runtime tests or a full security review.

Reconstruction checks used Node 26.7.0 and Rust 1.99.0 on Apple Silicon macOS. The committed `.nvmrc` and CI select Node 22. Existing Vite asset-placeholder and large-chunk warnings remain. Rust commands used the isolated toolchain described in the [execution record](portability-plan.md#validation-and-handoff); use [Mac setup](mac-setup.md) for a permanent installation.

To verify preservation after committing the stack, this command should print only the two handoff-document paths:

```sh
git diff --name-only 2d15582 pr/platform-release-workflow
```

Run tests as the final verification step and report failures. On the final branch, after installing its dependencies:

```sh
cd /private/tmp/Museamo-pr-5-release
npm ci
npm test
npm run test:release
node --test scripts/build-sync-android.test.mjs
cargo test --workspace --locked -- --test-threads=1
```

On the configured Android host, also sync assets and run Gradle unit/lint checks. Keep connected instrumentation tests on a disposable emulator/device. Before merging each PR, run its relevant suites against that PR's head; a passing final stack does not by itself establish that every intermediate commit passes. Native behavior, credential recovery, signing, and cross-device sync remain the acceptance checks in [desktop packaging](desktop-packaging.md) and [Mac setup](mac-setup.md).

## iOS follow-up

The next work package is `pr/ios-offline-foundation`: a native offline text library and iPhone host, followed by local UI tests, CI, and a hardware-testing handoff. The [draft PR description](ios-pr-description.md) and [verification record](ios-verification.md) describe this scope. Rust iOS sync diagnostics remain on the separate `work/ios-initial-snapshot` preservation branch.

At the October 4, 2026 fetch, `origin/main` is `654712a` and contains PR #1. PRs #2–#5 were merged into their stacked base branches, so their changes have not all reached `main`. `origin/pr/desktop-packaging-ci` at `5ab8830` contains the complete earlier stack, including PR #5. The consolidation branch `pr/consolidate-platform-foundation` points to that same commit and targets `main`. The draft iOS PR targets the consolidation branch to keep the review limited to iOS work. Merge the consolidation first; these instructions do not authorize merging either PR.

The iOS branch is stacked on `pr/consolidate-platform-foundation`. Its dependency boundary is `5ab8830` (the merge of PR #5 into the packaging branch). The five commits after that boundary contain:

1. Transactional Swift SQLite storage and repository tests.
2. The iOS host, Capacitor bridge, platform capabilities, and simulator build/launch commands.
3. Local persistence UI tests and their Xcode target.
4. Swift tests and an unsigned simulator build in CI; UI tests remain local.
5. Development instructions, verification screenshots, and physical-iPhone handoff.

Once the earlier stack has reached `main`, use a clean worktree and replay only these five commits, excluding the duplicated dependency commits even if the earlier PRs were squash-merged:

```sh
git fetch origin
git switch pr/ios-offline-foundation
git branch work/ios-before-stack-integration
git rebase --onto origin/main 5ab8830
git diff --stat origin/main...HEAD
```

Inspect conflicts against the actual merged parent, then rerun affected checks. After rebasing, update the published iOS branch with `git push --force-with-lease origin pr/ios-offline-foundation` and retarget its PR to `main`. Keep it in draft while required verification is pending. Until that integration is complete, inspect the iOS scope with `git diff pr/consolidate-platform-foundation...pr/ios-offline-foundation`; comparing against today's `main` includes the pending desktop/release stack.
