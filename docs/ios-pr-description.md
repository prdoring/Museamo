# Add the iOS offline text-library foundation

An iPhone installation now uses a native Swift SQLite library through Capacitor. Thoughts and unfinished drafts survive termination; the existing React interface supports text capture, editing, search, tags, Gems, checklists, and local Recovery. Unsupported media, location, backup, sync, sharing, and widget controls are hidden.

Adds an iPhone host targeting iOS 16.4, shared-contract persistence tests, simulator build/launch commands, and a local persistence UI test. CI runs Swift tests and an unsigned simulator build; UI tests remain local. No signing team or credentials are committed. Rust iOS diagnostics and native identity/sync are separate work.

## Review base

This draft follows the consolidation of PRs #2–#5. Its base is `pr/consolidate-platform-foundation`, so the review contains only the five iOS commits. Keep it in draft until the consolidation reaches `main`, then rebase onto `main` and retarget the PR as described in [the stack handoff](pr-stack.md#ios-follow-up). Hardware verification and the first hosted CI result remain pending.

## Validation

See [the verification record](ios-verification.md) for local results, screenshots, and known limitations. The simulator and unsigned device builds pass; signing, physical installation, and the [iPhone checklist](ios-device-checklist.md) remain the hardware handoff. Hosted CI has not run for this branch.

A desktop SQLite sync integration test times out locally on both this stack and unchanged PR #5. The shared Rust core tests pass; the complete workspace suite is not green. This iOS change does not modify the desktop Rust implementation.
