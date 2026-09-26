# Rich media verification — 2026-09-14

## Implementation

- Both composers select existing photos/videos, preserve original local copies, support media-only thoughts, and retain ordered attachments through draft/save/edit flows.
- Room v1 → v2 migration retains historical text, tags, profiles, and drafts. Media metadata and ordered references are separate from Markdown.
- The feed displays photo grids, a full-screen photo viewer, video controls, and visible-only direct HTTPS/YouTube/Vimeo previews with external-open fallbacks.
- ZIP v2 backups stream originals with checksums. Legacy JSON remains importable. Failed archive imports leave existing data intact.

## Final results

- Production web build and TypeScript checks passed; all 47 web tests passed.
- Android debug APK build, all 9 JVM tests, and Android lint passed.
- The API 34 emulator instrumentation suite passed with zero failures/errors; the existing opt-in paper screenshot test was skipped.
- Final APK: android/app/build/outputs/apk/debug/app-debug.apk.

## Automated coverage

- Web: 47 passing tests, TypeScript checks, and production build.
- Android JVM: 9 tests cover formatting, hashtags, and bounded/suffix/invalid byte ranges.
- Android instrumentation covers schema migration, media-only draft recovery, duplicate Send, edit cancellation, Undo retention and cleanup, ZIP round trips, conflicting media IDs, unsafe paths, corrupt/missing files, failed selection batches, and streaming limits.
- A generated H.264 video is imported through a content URI alongside a PNG. Source files are removed before the WebView loads the originals. The test checks no autoplay, explicit playback, seeking, partial-content responses, and rejection of unregistered/arbitrary filesystem routes.
- The native picker lifecycle test supplies an instrumented system-picker result, recreates the composer, then sends without text. This tests result handling and persistence; it does not automate the system gallery UI itself.

## Browser observations

- Selected a local WebP, saved a media-only thought, and opened its full-screen viewer.
- Edited an existing thought, attached a PNG, opened the discard confirmation, chose Keep editing, and saved. The image remained available and decoded successfully in the feed.
- YouTube/Vimeo links create their respective preview cards and retain original links. The test browser did not finish loading the hosted YouTube frame; the timeout displayed an unavailable message, Retry, and Open original link. Successful hosted playback is not claimed.

## Device acceptance still needed

- Real Android system picker and document-provider UI on older Android versions, cloud-backed gallery files, and physical-device process termination during large imports.
- Near-limit 50 MiB photos / 500 MiB videos and low-storage conditions on hardware. Automated byte-limit tests use small streams rather than consuming the full limits.
- Device-specific codecs, HDR/HEIF, fullscreen transitions, and YouTube/Vimeo playback with provider privacy/embedding restrictions.
- Pixel/Samsung widget launchers and keyboards.

Existing Vite warnings about paper-theme asset placeholders and bundle size remain. They do not fail the build.

## Mobile UX revision

- Both composers use one action row for attachments, formatting, tags, and Send/Save. Draft options stay out of the native writing area.
- The native composer starts with five writing lines; selected media uses a horizontal thumbnail strip with accessible remove targets. Empty attachment and tag sections take no space.
- The photo viewer has a dedicated viewport-sized surface with safe-area padding, a photo count, and Close. Swipe changes photos; pinch zooms around the fingers; dragging pans enlarged photos; double-tap toggles zoom. Keyboard arrows, +/−/0, Escape, and Android Back remain available.
- Checked the browser composer at 390px and 320px widths. Inspected Android screenshots with the keyboard visible and the fullscreen viewer below the status bar.
- Added Android touch-event coverage for swipe, pinch, double-tap, and Back, plus checks that the viewer fits its viewport and composer tools share one row.
- Stabilized the picker test by waiting for initial loading and dismissing the keyboard before its coordinate-based tap. The picker import and recreation behavior remains covered.
- Final validation: 47 web tests pass; TypeScript and production build pass; Android unit tests and lint pass; the complete API 34 emulator instrumentation run passes with the existing opt-in screenshot test skipped. The new native touch-gesture test passes in that full run.
