# CI scope and automatic releases

`Checks` runs for pull requests, pushes to `main`, and manual dispatches. Feature-branch pushes do not run a second copy of PR checks. A newer update to the same PR cancels its older check run. Mainline and manual runs are independent; release runs keep their existing queue and retry behavior.

## What runs for a change

| Changed files | Checks | Automatic release after merging to main |
| --- | --- | --- |
| Known documentation, screenshots, issue templates, or the README banner generator | Change-classification tests and the required result check | No |
| Frontend tests, Node tooling tests, release/signing helpers, or known developer helpers | Frontend typecheck/tests and Node tooling tests on Linux | No |
| Swift package tests | Linux tests and Swift tests on macOS; no simulator/archive packaging | No |
| Android unit/instrumented tests | Linux tests, Android build/unit/lint, and emulator tests | No |
| Desktop Rust tests or fixtures | Linux tests and Rust tests on Windows, macOS, and Linux; no distributable bundles | No |
| Shared Rust core tests | Android, iPhone and desktop checks, plus Linux tests; no application packages | No |
| iPhone UI tests | Linux and iPhone tests/build validation | No |
| iPhone implementation or generated iPhone assets | Linux and iPhone checks/builds | Yes |
| Android implementation or native Android build script | Linux and Android checks/builds | Yes |
| Desktop implementation or desktop packaging | Linux and all three desktop checks/builds | Yes |
| macOS/Windows/Linux-specific Tauri configuration, or a platform-specific icon/Info.plist | Linux tests and that desktop platform's checks/build | Yes |
| Shared Rust code/toolchain/dependencies | Linux, Android, iPhone and desktop checks/builds | Yes |
| Apple Rust framework builder or C interface | Linux and iPhone checks/builds; interface changes also check Android/desktop | Yes |
| Shared interface, npm dependencies, bundled assets, or an unfamiliar path | Full validation | Yes |
| Workflow configuration or the change classifier itself | Full validation | No, unless mixed with app/bundle changes |
| Manual `Checks` dispatch | Full validation | No |

The classifier lives in [`scripts/ci-changes.mjs`](../scripts/ci-changes.mjs). Documentation uses a specific allowlist: all of `docs/`, named README/guidance/license files, issue/PR templates, and `scripts/docs-banner.mjs`. It does **not** ignore every Markdown file; Markdown in bundled assets or unfamiliar directories still gets full coverage. Known release/signing tools have Node tests, and changing them alone does not manufacture an app version.

Tests embedded in an implementation file still follow that file's implementation scope. Unknown files receive full validation and remain eligible for a release. Extend the classifier only after reviewing how a file is consumed. Mixed changes combine their required work, so a documentation edit cannot suppress an accompanying app change.

## Required checks and safe skips

The existing required names remain `build`, `ios`, `native-tests`, and the three `desktop (runner, target)` contexts. The desktop jobs have explicit names so skipped jobs retain the exact protected contexts. No branch rules need to change.

`build` is now the final result check, and `android` performs the original Android build. The final check always runs and requires successful change detection and every selected job to pass. A failed detector, missing output, failed/canceled selected job, or unexpectedly skipped selected job fails `build`. Intentional native skips therefore allow documentation PRs to merge without weakening protection for code changes.

Change detection compares a PR against its merge base and a mainline push against the event's complete before/after range. Multiple commits, deleted files, and both sides of a rename are included. A new branch uses its full tree. Missing comparison commits fail validation instead of guessing that a change is documentation-only.

## Release eligibility

Successful mainline `Checks` uploads a small `ci-change-scope` artifact, retained for 30 days. It records the checked source commit, Actions run ID, event, and selected work. `Mainline release` downloads that record from the exact successful own-repository main push and verifies its commit/run identity before reserving a version.

A documentation-, tooling-, or test-only merge finishes this inexpensive release eligibility job and skips reservation, Windows/Android release builds, GitHub publication, and TestFlight. Missing, expired, malformed, or mismatched records refuse a release. PR and manually dispatched checks never authorize automatic publication.

App changes retain the existing delivery model: Windows and Android publish together, and TestFlight uploads independently, even when validation only needed one platform. This keeps the version/download set consistent. Platform-specific publication would require a separate release-policy change.

An explicit manual TestFlight candidate is separate from automatic publication: an own-repository `codex/` branch can sign only the iPhone app after successful Checks for the exact dispatched commit, with frontend, iPhone and aggregate jobs all passing. Upload defaults off. This does not authorize a merge or Windows/Android publication; see [candidate instructions](testflight-setup.md#6-build-then-upload).

For configuration and recovery, see [releases](releases.md) and [TestFlight setup](testflight-setup.md).

## Local classifier checks

```sh
node --test scripts/ci-changes.test.mjs
```

The tests cover documentation/tooling/platform scope, manual full validation, mixed changes, real Git comparisons including multi-commit pushes and renames, failed/missing required checks, and release record identity. No application or helper server is started.
