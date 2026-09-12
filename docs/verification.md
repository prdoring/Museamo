# Verification record — 2026-09-12

Verified locally on Windows with Node 22, Android Studio JBR 21, Android SDK 36, and a disposable Android 14 (API 34) x86_64 emulator.

- TypeScript checks and production Vite build: passed.
- Frontend filter tests: 2 passed.
- Android debug app and instrumented test APK builds: passed.
- Android lint: passed with non-blocking compatibility, dependency-update, localization, and generated-template warnings.
- Instrumented tests: 13 passed. Covers independent drafts/defaults, duplicate send prevention, failed-save retention, tag cleanup, database reopening, filtering/pagination, transactional backup validation/conflicts/round trips, native composer save/recreation, independent picker search/selection, widget RemoteViews rendering, offline WebView loading and native bridge access.
- Dependency audit: no known vulnerabilities in the installed npm tree at verification time.
- Visual checks: phone-sized browser preview and actual Android screenshots for Stream, native composer with software keyboard, and the picker widget. Confirmed fixed/tag-picker layouts render, and the picker arrow remains visible for long names.

Local screenshots are in ignored `artifacts/verification/`. The packaged APK and SHA-256 are in ignored `artifacts/`.

Not yet verified on physical Pixel or Samsung hardware: launcher placement/resizing, force-kill/reboot behavior end-to-end, TalkBack, large system font/display settings, full system document-picker interaction, and cold-launch timing. Database persistence, backup logic, native activity recreation, and widget rendering are covered by emulator tests, but those are not substitutes for the [device checklist](device-checklist.md).

No external connections or store publication are included in this version.
