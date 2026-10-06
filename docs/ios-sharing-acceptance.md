# iPhone sharing acceptance record

Status: implementation candidate, October 6, 2026. Hardware acceptance has **not** passed. Keep the PR as a draft while its automated checks are pending; mark the feature complete only after the device scenarios below pass. Portable backups remain deferred.

## Candidate identity

- Pull request: [iPhone sharing #13](https://github.com/prdoring/Museamo/pull/13).
- Tested implementation commit: `a62a102688b1045f09307c16f444ee170a579abb`; [all automated platform checks passed](https://github.com/prdoring/Museamo/actions/runs/37534986721). Required PR-head results are in [PR checks](https://github.com/prdoring/Museamo/pull/13/checks).
- Automated iPhone results: [21 Swift tests, simulator build, unsigned iPhone archive and native capture/relaunch UI test passed](https://github.com/prdoring/Museamo/actions/runs/37534986721/job/112513908047), October 6, 2026. UI device: iPhone 16 Pro / iOS 18.5 simulator. The run's `ios-persistence-ui-results` artifact contains the result bundle and screenshots, retained for seven days.
- Physical tested commit: pending signed candidate and owner record.
- TestFlight version/build: pending signed candidate.
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
