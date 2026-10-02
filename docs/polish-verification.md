# Desktop and transition polish verification

Verified locally on October 1, 2026. This pass keeps the existing library/storage/sync contracts and the phone's visual layout.

## Automated checks

- Frontend: 115 tests across 13 files pass, including keyed reorder/state retention, rapid Delete/Undo, independent removal timers, final-post exit, interrupted disclosure/page animation, live reduced motion, overlay locks/focus, open-photo continuity, startup listener loading, stale results/errors, and reading-anchor preservation while scrolling during a slow refresh.
- TypeScript and Vite production build pass. The APK's bundled web assets match the final `dist` byte for byte. No production animation dependency was added; jsdom is a test dependency.
- Windows Tauri release compilation and NSIS packaging pass. The installer is in `target/polish/release/bundle/nsis/Museamo_0.4.0_x64-setup.exe`. A separate target directory avoids replacing the executable currently running on this machine.
- Android app APK, instrumentation APK, 12 JVM tests, and lint pass. Lint reports warnings and no errors. Kotlin's BOM aligns the legacy transitive jdk7/jdk8 artifacts with the existing compiler, resolving duplicate classes during packaging. Android uses the existing native library artifacts (`-x buildSyncCore`); this pass does not change the portable core.
- API 26: five capture/lifecycle tests pass on the final APK, and the final five-test portrait run passes. The rotation assertions wait for Android's asynchronous window configuration to settle before checking portrait. Capture/tag hosts are non-floating and opaque; all four owned activities declare upright portrait. Activity launches begin from a landscape rotation, then attempt 90/270/180 degrees. Drafts survive.
- API 34: 14 portrait, native capture, attachment, photo/video, and visual editor tests pass.
- API 36: five portrait, five capture, and one attachment test completed successfully before the emulator disconnected during the combined media run. The remaining three media/editor tests pass in a fresh isolated run, recorded in `artifacts/polish/android-api36-media-final.log`.

Android lifecycle tests activate native toolbar listeners and wait for durable records. Synthetic coordinates previously missed buttons while the platform IME moved the toolbar. Media gesture tests continue to exercise actual touch events.

## Visual and interaction checks

Desktop preview reviewed at 640, 900, 1100, and 1440px in light and dark themes, with no horizontal overflow. The 224px sidebar becomes a 72px rail below 900px; the header is 52px and the reading area is bounded to 720px. Centered composition measures 720px on a 1100px viewport. Window controls remain outside the inert modal shell. Ctrl+N and Ctrl+F, anchored menu End/Escape and focus return, send, Delete/Undo, long tag titles, Settings, search misses, empty tags, failed save, and retry were checked in the in-memory preview.

Evidence is saved under `artifacts/polish/` (ignored generated files):

- `desktop-light-1440.jpg`, `desktop-dark-1440.jpg`, and the corresponding 640/900/1100 screenshots.
- `desktop-composer-light.jpg`, `desktop-composer-dark.jpg`, `desktop-menu-dark.jpg`, `desktop-settings-light.jpg`, `desktop-long-tag-empty.jpg`, `desktop-search-empty-dark.jpg`, and `desktop-failed-save-dark.jpg`.
- `desktop-attachment-composer.jpg`, `desktop-media-post.jpg`, and `desktop-photo-viewer.jpg` verify importing a fixture, sending it, and viewing it below the integrated header; window controls remain available above the modal.
- `android-api26-rotation.mp4` and `android-api36-rotation.mp4` show the emulator activity/rotation runs; early activity screenshots can capture the entrance animation. `api26/capture.png` shows the steady opaque capture host with its keyboard. Visual review removed a redundant inner frame from that compatibility surface.
- `api26/` and `api36/` contain activity, capture/media, and viewer screenshots. `android-api34-viewer.png` captures the existing photo viewer. The current-Android viewer test attempts rotation while a photo is open and checks that it stays in portrait.

## Remaining manual acceptance

Native Windows input is unavailable through this session's UI tools. Verify actual minimize/maximize/restore/close controls, synchronized maximize state, header dragging and double-click maximize, edge resizing, Win+Arrow snapping, close-to-tray/reopen, and window controls while a dialog/photo viewer is open. These behaviors are wired to Tauri's window APIs with only minimize, toggle-maximize, close, and start-dragging permissions; build success is not an OS interaction check.

Also check a physical phone/launcher and TalkBack, including widget launch from a landscape launcher and system animation scale zero. Emulator results do not establish OEM launcher or hardware behavior. External pickers/maps intentionally keep their own orientation.

Configuration references: [Tauri window customization](https://v2.tauri.app/learn/window-customization/), [Android activity orientation](https://developer.android.com/guide/topics/manifest/activity-element#screen), and [Android 8 framework restriction](https://android.googlesource.com/platform/frameworks/base/+/android-8.0.0_r36/core/java/android/app/Activity.java).
