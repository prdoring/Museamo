# iPhone sharing acceptance record

Status: signed candidate uploaded and accepted by Apple, October 6, 2026. All selected automated checks passed and the sole tester approved the mainline TestFlight release. Hardware acceptance has **not** passed; mark the feature complete only after the device scenarios below pass. Portable backups remain deferred.

## Candidate identity

- Pull request: [iPhone sharing #13](https://github.com/prdoring/Museamo/pull/13).
- Tested implementation commit: `7362a1b455862fb7f0780088856b7667c51b8a12`; [all automated platform checks passed](https://github.com/prdoring/Museamo/actions/runs/37538150162). Merged as `d5f8bf7e27d3b653098aa54ca27a82e6b0f2aef3`.
- Automated iPhone results: [21 Swift tests, simulator build, unsigned iPhone archive and native capture/relaunch UI test passed](https://github.com/prdoring/Museamo/actions/runs/37538150162/job/112524883437), October 6, 2026. UI device: iPhone 16 Pro / iOS 18.5 simulator. The run's `ios-persistence-ui-results` artifact contains the result bundle and screenshots, retained for seven days.
- Physical tested commit: pending owner device record for release commit `474489a4a2e203e1e3091f03e429f5abaf72335f`.
- Signed candidate: **0.4.3 (1.6.0)**, release commit `caa9535aaf99e2d6879179ba6210ff6093208a8a`, [release run 37545848705](https://github.com/prdoring/Museamo/actions/runs/37545848705). Signing/export and credential cleanup passed. **Apple rejected validation and upload with 409 Invalid Export Compliance Code; this is not an available TestFlight build.** The run incorrectly reported success because altool returned zero despite the rejection. Complete the owner encryption review in App Store Connect → Museamo → App Information → App Encryption Documentation before retrying with the appropriate declaration/code.
- Owner encryption review completed October 6: screenshots show standard bundled encryption selected, France distribution excluded, and Apple's final result of no documents required. The replacement build records the documentation exemption; hardware acceptance remains pending.
- Replacement upload accepted: **0.4.4 (1.8.0)**, immutable release commit `474489a4a2e203e1e3091f03e429f5abaf72335f`, [release run 37550753426](https://github.com/prdoring/Museamo/actions/runs/37550753426/job/112565476997), October 6, 2026 at 5:19 p.m. PDT. Source merge `0e8ba3ead6258e47d3f126108e8711505e19810c` passed [main validation](https://github.com/prdoring/Museamo/actions/runs/37549715919). Apple logged both VERIFY SUCCEEDED and UPLOAD SUCCEEDED; signing cleanup passed. The signed IPA's version/build, documentation exemption, iOS 16.4 minimum, usage declarations, Bonjour services and native privacy manifest were checked against its build record. Apple processing/internal distribution and phone installation are not yet observed.
- iPhone model/iOS: pending owner record.
- Android model/app version: pending owner record.
- Windows app version: pending owner record.
- Date, network, testers: pending owner record.

## Required physical checks

| Scenario | Result and evidence |
| --- | --- |
| Upgrade existing populated library; IDs, profiles, drafts, Gems, checklist states, Recovery, and associations survive | Pending |
| iPhone creates QR; Android previews then joins; cancellation, expired/cancelled/reused QR, unreachable host, repeated taps | Pending |
| Android creates QR; iPhone scans, previews then joins; denied camera permission and retry after changing Settings | Pending |
| Collaborate on text, completion, photos/videos and manually captured locations in both directions | Pending |
| Same-name private/shared tags; only selected tag contents cross the boundary, no Gems/profiles/drafts/private history | Pending |
| Link iPhone↔Windows; matching code and separate Combine libraries consent; existing content preserved; shared tag appears on Windows | Pending |
| Offline simultaneous edits, stale editor, deletions, Recovery, permanent clearing and duplicate delivery | Pending |
| Relaunch, app suspension during callbacks/transfers, reopening/catch-up, Wi-Fi/port changes | Pending |
| Local Network/location denied then allowed; offline capture still works; manual address linking | Pending |
| Large original resumes after interruption; checksum failure, low storage, original pending/unsupported codec | Pending |
| WKWebView images load; video plays, pauses and seeks; original checksum preserved | Pending |
| Leave/stop/remove member, remove personal device, remove shared tag from thought; preserve private downloaded copies | Pending |
| Repeated foreground start/stop; no camera use after sheet closes; no network callbacks after runtime stop | Pending |
| Quarantine keeps local library usable and explains missing iPhone backup recovery without proposing reset | Pending |
| iOS 16.4 device coverage, keyboard/safe areas, light/dark, VoiceOver and large text | Pending |

Fill each result with the tested commit/build, devices, reproduction steps and pass/fail. A simulator compile or successful Apple upload is not physical acceptance.

## Limits

LAN only; keep both apps open. No cloud relay, account, continuous background syncing, automatic iPhone location collection, portable backup, widgets, iPad redesign, or desktop QR scanner. The migration snapshot is installation-local and is removed after permanent clearing. It does not protect against uninstall/reset. Installation keys are device-only Keychain items; do not reset an enrolled installation if those keys become unavailable.
