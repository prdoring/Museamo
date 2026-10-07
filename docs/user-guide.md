# Using Museamo

The [README](../README.md) provides the illustrated first steps. This guide covers details you may need later.

## Capture and widgets

Widgets default to a wide capture strip and resize down to a compact tile on supported launchers. Compact tiles show capture and Open Museamo buttons; wider cards add a label and tag picker. Long-press and drag resize handles. If a widget keeps old limits after an update, remove and re-add the widget.

Each widget has an independent draft. Back preserves it; Send saves it once and closes. Changing a widget's default tags affects its next fresh draft, rather than a draft already in progress. Existing settings can be copied when configuring another widget, without coupling the instances.

Type `#` for tag completion. Multiword names use `#"Cool words"`. **Add tag** selects tags without adding text. Missing complete inline hashtags are created at send. Removing an inline tag chip removes its tokens; URL fragments are not tags.

## Editing and formatting

Open a thought's menu for **Edit**, **Copy text**, and **Delete**. Select text in the editor, then use bold, italic, bullets, numbering, or quote controls. Editing uses lightweight Markdown; **Preview** shows the result. Standard paste preserves supported structure when the clipboard includes rich text. Copied text includes HTML formatting and a plain-text fallback.

If another linked device changes a thought while you are editing, a stale save keeps your unsaved edits and offers **Save as new** or **Load current version**.

## Checklist tags

Open **Settings → Manage tags**, then choose a tag to edit its name or **Checklist** setting. Use the arrow beside a tag to open its thoughts. Tag settings are also available from the tag's menu in the library. Unsaved edits offer Save, Discard changes, or Keep editing when you close; opening Sharing offers Save and continue first.

Every thought with a Checklist tag gets a checkbox in Stream, Gems, and map cards. Checklist collections show unchecked thoughts first, newest first within each group. A thought with several Checklist tags has one shared checked state. Removing the last Checklist tag hides the checkbox but remembers completion for later.

The Stream header's checklist icon filters across all Checklist tags, including checked items. It works with search and pagination. Widgets and native pickers mark Checklist tags with a small checklist icon. New thoughts start unchecked.

## Photos, videos, and links

Choose **Attach photos/videos** in app or widget capture. Add up to 10 files in selection order: 50 MiB per image and 500 MiB per video. Museamo copies originals into private storage without compression and makes separate thumbnails. Sending waits for imports. Closing keeps the draft; removing an attachment while editing only changes the saved thought after Save.

Photos have zoom and previous/next controls. Videos support playback, seeking, and fullscreen, and never autoplay. Playback depends on device codecs. Unsupported originals stay stored, backed up, and synced, even when a particular device cannot play them.

Saved HTTP(S) and `www.` links remain clickable. Direct HTTPS image/video links and supported YouTube/Vimeo links can show media in the feed. Those previews contact the host when visible and need internet. Restricted hosted videos may fail; **Open original link** stays available. Museamo does not download linked videos or upload your local attachments.

## Locations and maps

Android asks for foreground location permission when the app first opens with device location services on. With permission, fresh app/widget composers try to attach a location. They can use a position up to one minute old or wait up to 10 seconds for a new one. If permission, services, or a fix are unavailable, Send still saves without a location. There is no background tracking.

The pin control can retry location, correct a place name, or remove it. Removed draft locations are not automatically reattached. Settings can disable automatic location for new posts. Existing drafts retain their original position.

Coordinates are saved before address lookup. Place names depend on the device's geocoding metadata or your custom label; an exact restaurant is not guaranteed. **Saved location** still opens a coordinate without a label. Full stored addresses remain searchable and included in backups.

**Map** shows located posts with search, tag, and Gems filters. Choose a thought's location to focus its pin, or **Open in maps**. Address lookup may send coordinates to a geocoding provider; maps request OpenStreetMap tiles and need internet. Tiles are not downloaded for offline use.

## Linking and shared hashtags

For your own devices, use **Settings → Linked devices → Link a device**. Choose a nearby device, or use its local address if discovery is unavailable. Compare every group of the matching code, then review the other device's library and approve combining on both devices. A linked confirmation means membership was established; original attachments may still be transferring. See [sync](offline-sync.md) for discovery, conflicts, and device removal. Drafts, widgets, permissions, and startup preferences remain local.

Android and iPhone can also share an individual hashtag through **Tag settings → Sharing**. Review what is shared before creating a QR invitation. Each invitation is temporary and single use; cancelling it prevents future joins with that code. **Join shared hashtag** scans a code and shows a separate review before joining. Both phones must be reachable on the same local network to join. Everyone who joins can add, edit, delete, and check off that collection's items. Its text, attachments, and saved locations are shared; other tags and Gems stay private. Shared collections also appear on your linked devices. Members cannot rename the tag or change Checklist; desktop shared-tag settings explain which changes require your phone.

## Backup and Recovery

**Settings → Backup → Export** creates an unencrypted ZIP with saved thoughts, tags, original attachments, saved locations, Recovery, and widget settings. Drafts, identity keys, device membership, replication state, and downloaded copies of linked media are excluded. Keep the complete ZIP; its checksums protect original-file integrity during import.

**Import** supports earlier JSON and ZIP backups. Current ZIP manifests use version 5; versions 1–4 remain importable. Older apps cannot read the newest exports. Large imports need space to stage and verify originals before changing the library.

Deleted thoughts and earlier versions remain in **Settings → Recovery** until cleared. Choose a short entry to view the complete version and restore a separate copy. **Show more** loads further entries in a large Recovery list. Permanent clearing requires a separate confirmation and syncs to linked devices. Removing a device cannot remotely erase copies it already holds.

Settings groups organization first, then devices/backups, this device's options, and privacy information. Wide desktop windows keep the topic list beside the selected page; smaller windows and phones open one topic at a time. Back returns to the settings menu, then to your previous library view. iPhone does not expose backup, Android widget, automatic-location, or desktop startup controls. The browser's device examples are explicitly labeled as a demo and make no real connections.

Export before updating, uninstalling, or clearing app storage. Android cloud/device-transfer backup is disabled for app data. Android uninstall or clearing storage deletes its library. Windows data lives separately in your user profile and can survive reinstalling the executable.
