# iPhone device checklist

The connected candidate uses the React editor, Capacitor bridge, Swift SQLite repository and shared Rust protocol. It adds QR tag sharing, personal-device linking, photos/videos and manual locations. Portable backups, automatic location and widgets remain deferred. Use disposable content for first hardware checks. The simulator and CI do not establish physical-device acceptance.

## Prepare and install

From Windows, follow [TestFlight setup](testflight-setup.md#6-build-then-upload), complete Apple's candidate encryption questions, and install the exact recorded version/build. Keep the existing installation when testing an upgrade. Confirm the app opens its native library without a browser-preview strip. No personal Mac or Developer Mode is required for TestFlight.

For optional local development on a Mac:

1. Use macOS with Xcode 26 or newer, Node 22 or newer, Rust 1.99.0, and an iPhone running iOS 16.4 or newer. Run `npm ci`, `npm run ios:sync-core`, then `npm run ios:sync` to build and copy the current native/web assets into the app. Run `npm run ios:open` to open the committed Xcode project.
2. Connect the iPhone, unlock it, and accept the computer/device trust prompts. Enable Developer Mode under Settings → Privacy & Security when prompted, including the required restart. Allow Xcode to finish pairing and preparing the device.
3. In Xcode, select the **App** target and **Signing & Capabilities**, enable automatic signing, and select your development team. The committed app identifier is `com.prdoring.museamo`; use an identifier available to your team if needed. Keep both Debug and Release consistent. If you customize it, use the same base with `.AppUITests` for the **AppUITests** target (`com.prdoring.museamo.AppUITests` by default), and select the team for that target if running tests on hardware. The App scheme's UI test target already points to App.
4. Keep signing settings local. Do not commit `DEVELOPMENT_TEAM`, personal bundle-identifier changes, provisioning profiles, certificates, or Xcode user data. Review `git diff -- ios/App/App.xcodeproj/project.pbxproj` before preparing a PR. Keep your chosen identifier stable between hardware runs so the app uses the same sandbox.
5. Select the **App** scheme and the connected iPhone as the run destination, then choose **Product → Run**. If iOS requires developer-app trust, approve your development identity in Settings → General → VPN & Device Management, then run again. Resolve signing or provisioning errors with the selected account before proceeding.
6. Confirm the installed app opens its native library and does not show the temporary browser-preview strip. Disconnect Xcode and open it from the Home Screen to prove standalone launch. Record signing and launch results; an unsigned `iphoneos` build alone does not complete this step.

`ios:build` produces an unsigned simulator app. `ios:launch` installs that app into a simulator, and `ios:run` combines the two. After frontend changes, run `ios:sync` again before Xcode Run; after Rust/interface changes, rebuild `ios:sync-core`.

## Manual checks

Record pass/fail and reproduction steps for each item. Run on a current iPhone and the oldest supported OS/device combination available; explicitly identify any untested coverage.

- [ ] **Offline startup:** enable airplane mode, launch from the Home Screen, and confirm Stream, writing and local photo/video capture remain usable. Unreachable peers must not discard offline edits. Portable backup, automatic location and widget controls remain unavailable.
- [ ] **Saved thought:** send a unique formatted thought with a tag; dismiss the app from the app switcher and relaunch. Verify it appears once with its text and tags intact. Repeat with rapid Send taps and confirm there is no duplicate.
- [ ] **Draft close/reopen:** type an unsent draft, close capture, and reopen it. Verify text and formatting remain. Send it and confirm the saved entry exists once and capture no longer holds that draft.
- [ ] **Draft lifecycle:** type another draft; switch apps, lock/unlock the phone, and return. Repeat with capture open while terminating/relaunching the app. Verify the draft returns and editing can continue. Check an interrupted edit as well.
- [ ] **Library operations:** search for saved text, toggle a Gem, create/rename a tag, make a Checklist, and complete/uncomplete an item. Relaunch and verify the state. Check multiword/Unicode tags and hashtag completion.
- [ ] **Edit/delete/undo/Recovery:** edit a saved thought and relaunch; delete another and Undo. Delete it again and restore from Recovery. Verify earlier edits and deleted text are available as expected and restored thoughts do not overwrite another entry.
- [ ] **Keyboard and editor:** open/close the software keyboard, paste multiline text, select text, change formatting, use hashtag completion, and scroll a long draft. Send and close controls remain reachable; the editor and sheet resize correctly as the keyboard changes.
- [ ] **Safe areas and layout:** check the notch/Dynamic Island, home indicator, small display, and each orientation the app permits. Navigation, sheets, and composer controls remain visible and tappable without unintended scrolling or clipping.
- [ ] **Themes:** check light, dark, and system appearance, including switching system appearance while the app is backgrounded. Text, selection, placeholder, tags, focus, and keyboard contrast remain usable.
- [ ] **Accessibility:** use VoiceOver to navigate Stream, open capture, edit/send a thought, toggle a Gem, and operate a checklist. Confirm meaningful labels and reading/focus order. Check larger text, Reduce Motion, touch targets, and visible loading/error feedback.
- [ ] **Relaunch and update:** stop and reopen without Xcode attached. Run another build over the same installation and identifier; verify the library and unsent draft remain. Uninstalling deletes the sandbox, and portable backup is not yet available on iOS.
- [ ] **Connected acceptance:** run and record every QR, privacy, device-linking, media/location, permission, lifecycle and recovery scenario in [the sharing acceptance record](ios-sharing-acceptance.md). Keep both peers open on the same local network.

## Record the handoff

Include the commit, Xcode version, iPhone model, iOS version, customized bundle identifier if any, signed installation result, checklist results, and remaining coverage. Use sample data in screenshots; include light/dark captures for layout findings. Do not include signing credentials or personal thought text.

See [iOS verification](ios-verification.md) for automated evidence and [the roadmap](ios-roadmap.md) for deferred work. Record successful Apple processing and physical scenarios separately; signing or upload alone does not complete acceptance.
