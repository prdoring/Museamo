# Museamo

A private stream of thoughts. Tap a homescreen widget, type, send. Come back later to find the gems.

## Development

Requires Node 22+, JDK 21, Android SDK 36 and build-tools 36.0.0. Android Studio's bundled JBR works. Minimum device: Android 7 (API 24), with WebView 105 or newer.

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run android:sync
cd android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

On Windows use `gradlew.bat`, set `JAVA_HOME` to Android Studio's `jbr`, and set `ANDROID_HOME` to your SDK folder. Alternatively create ignored `android/local.properties` with `sdk.dir` pointing to that SDK. `npm run android:open` opens Android Studio. The browser shows an explicitly labeled, ephemeral design preview: real user data lives only in native Room storage.

APK: `android/app/build/outputs/apk/debug/app-debug.apk`. Install using `adb install -r` or Android Studio. Instrumented database/lifecycle checks run with `./gradlew :app:connectedDebugAndroidTest` when an emulator/device is attached. CI attaches a debug APK to successful workflow runs. Debug signing is for development; store publishing requires a separate release key and review.

## Capture

Widgets default to 3 × 1 and resize in both directions, down to a compact capture tile (1 × 1 on supported launchers) or up to a roomy card. Compact tiles show two icon buttons: message capture and Open Museamo; wider layouts add the label, tag picker, and Open Museamo shortcut. Taller cards use the available height. There is no app-imposed maximum size; exact grid sizes depend on your launcher. Long-press the widget and drag its resize handles. If an existing widget retains the old limits after upgrading, remove and re-add it.

While composing, type `#` to see matching tags. Completion keeps the hashtag inline. Multiword names use `#"Cool words"`. Choose **Use new tag** or leave a complete hashtag in the message; missing inline tags are created when you send. **Add tag** also supports explicit selection and creation without inserting text. Removing an inline tag chip removes its tokens. URL fragments are not tags.

Long-press your launcher, open Widgets, and add Museamo. Choose a label and either fixed default tags (including none), or a tag picker. Add as many widgets as you like. Each has its own draft. Back preserves a draft; Send saves it exactly once and closes. A picker change affects the next fresh draft, never a draft already in progress. Existing/imported profile settings can be copied when configuring another widget, keeping instances independent.

Stream shows everything, Gems shows starred thoughts, and Tags provides collections. Settings manages widgets and portable ZIP backups (including original attachments). Uninstalling or clearing app storage removes local data: keep exports somewhere safe. Android cloud backup and device-transfer backup are disabled for app data. Exports are unencrypted ZIP archives; choose their destination yourself. Existing version 1 JSON backups remain importable.

On the Tags page, open a tag’s edit menu and turn on **Checklist**. Every thought with that tag gets a checkbox throughout the app, including Stream, Gems, and map cards. Checking it crosses out its text. Checklist categories show compact rows with unchecked thoughts first, newest first within each group. Open an item’s menu for its timestamp, location, and Gems action. A thought with multiple Checklist tags shares one checked state. Turning Checklist off or removing its last Checklist tag hides the checkbox and remembers its state for later.

Tap the **checklist icon** in the Stream header to show only thoughts belonging to Checklist tags. It includes checked and unchecked items from every Checklist category, keeps newest-first order, and works with search and pagination. Tap it again to return to all thoughts.

Widgets and native tag pickers show a small checklist icon beside Checklist tags. Capture and draft behavior stays the same; newly captured thoughts start unchecked. Backup ZIPs now use manifest version 4 and preserve category types and completion. Versions 1–3 remain importable. See [checklist verification](docs/checklist-verification.md).

Locations show a short label such as “Trader Joe's, Portland OR,” “Portland OR,” or “Antwerp, Belgium.” Full addresses remain stored, searchable, and included in backups. Place names depend on available geocoding metadata or a custom name you enter.

Before updating a device with important thoughts, use **Settings → Backup → Export** and keep the archive outside the app. Install the APK as an update over the existing app. Keep the existing installation if Android refuses the update; uninstalling or clearing app storage deletes local data. ZIP exports include posted thoughts and attachments; unfinished drafts are retained by an in-place update but are not included in the archive.

## Architecture and validation

See [architecture](docs/architecture.md) for native bridge, persistence, and future routing contracts. See [device checklist](docs/device-checklist.md) for launcher checks that require hardware. No publishing integrations, account system, or analytics are implemented.

See the [verification record](docs/verification.md) for completed checks and remaining device validation. CI runs the suite on an Android emulator as well as building a downloadable debug APK.

## UX redesign

The app now uses a compact private feed, a bottom capture bar, explicit post actions, searchable tags with counts, and independent Undo notifications. Browser preview supports capture, editing, tags, stars, drafts, and simulated failures in memory; it never writes Android data.

Formatting: select text and use **B**, *I*, bullets, numbering, or quote controls in the app editor or native widget composer. Editing shows lightweight Markdown; **Preview** shows the formatted result. Standard Paste preserves supported structure and emphasis when the clipboard supplies formatted text, using Museamo's typography. Copy text includes HTML formatting with a plain-text fallback. Drafts and backups retain the Markdown. The media upgrade migrates the database to schema version 2 while preserving existing thoughts and drafts.

See [DESIGN.md](DESIGN.md) for interaction rules and [UX verification](docs/ux-verification.md) for the remaining physical-device checks. No automatic preview server is required: run npm run dev in your own terminal and stop it with Ctrl+C.

Saved web addresses (`https://`, `http://`, and `www.`) remain clickable. Direct HTTPS image/video links and supported YouTube/Vimeo links also display media in the feed when visible. Other links open outside Museamo. Widgets also have a separate Open Museamo icon. Widget setup explains the two tag modes and uses a normal screen with Cancel and Add widget/Save changes controls.

## Photos and videos

Choose **Attach photos/videos** in the app or widget composer. Add up to 10 files in selection order (50 MiB per image, 500 MiB per video), with or without text. Museamo copies originals into private storage without compression and generates separate thumbnails. Sending waits for imports to finish. Closing keeps the draft; removing an attachment while editing only affects the saved thought after Save.

Photos open in a full-screen viewer with zoom and previous/next controls. Videos have playback, seeking, and fullscreen controls; they never autoplay. Device codec support varies. A clear error appears when a selected file cannot be decoded. Internet connectivity is needed for linked media, but locally attached media works offline.

Linked media loads from its host when it enters the feed, so the host receives a network request. YouTube/Vimeo can reject restricted videos; **Open original link** remains available. Museamo does not scrape websites, download linked videos, or upload your attachments.

ZIP backups contain a version 2 manifest, original attached files, and SHA-256 checksums. They exclude drafts and downloaded copies of links. Keep the complete archive to restore media. Large libraries need enough storage for staging the import. Older versions of Museamo cannot read these ZIP exports.

See [rich media verification](docs/rich-media-verification.md) for automated results and the remaining physical-device and hosted-player checks.

## Post locations

Museamo asks for foreground location permission the first time you open the app while device location services are on. Allow it to attach locations automatically; there is no separate Settings opt-in. New app/widget composers use an OS position up to one minute old or wait up to 10 seconds for a new position. If location services are disabled, permission is unavailable, or no fix arrives before Send, the post saves without a location. There is no prompt to enable device services and no background tracking.

Coordinates are stored first. Android then attempts a named feature, address, or town/region; if lookup fails, **Saved location** still opens the coordinates on a map. Exact restaurants are not guaranteed. Existing drafts keep their original position. Use the pin icon beside photos, formatting, and tags to add or retry location directly, or to refresh, correct a place name, or remove it; removed draft locations are not automatically reattached.

The **Map** tab shows located posts with search, tag, and Gems filters. Tap a post’s location to focus its pin, or choose **Open in maps**. Posts and labels remain local; reverse geocoding may send coordinates to the device’s geocoding service, and map viewing requests OpenStreetMap tiles. Tiles need internet and are not downloaded for offline use. The browser preview uses clearly simulated coordinates, never your actual position.

ZIP backups now use manifest version 3 and include saved locations. Versions 1 and 2 remain importable. See [location verification](docs/location-verification.md) for checks and device coverage.
