# Location verification

## Automated and browser checks

Verified locally: 53 web tests pass; TypeScript/Vite build and Capacitor sync pass; Android debug APK, instrumented-test APK, 11 JVM tests, and lint pass (0 lint errors).

- Web tests cover the naming cascade, zero coordinates, place search, located pagination, draft resumption/removal, edits, and Undo.
- Android instrumented tests cover 1→3 and 2→3 migrations, geocoder naming fallback, coordinate validation, guarded late enrichment, located queries, v3 backup round trips, legacy imports, opt-in disabled, and denied permission.
- Browser preview: map tiles and pins render with visible attribution; Gems filtering, editing/removing a place name, and coordinate-only focused maps work. Map layout was inspected at 390-pixel phone width.
- All 9 targeted LocationCaptureTest and LocationStorageTest tests passed on the connected phone after installing the update with `adb install -r` (no app-data clearing). The live request reported permission-denied. Opening MainActivity then visibly launched Android’s GrantPermissionsActivity; the permission choice was left to the user. A successful real-position fix after granting permission is still to be verified.

## Further device acceptance checks

Use a disposable emulator/test installation, then run `:app:connectedDebugAndroidTest`.

1. Allow the first-open permission request with approximate permission. Open app and widget composers; verify a fresh approximate location appears without precise permission.
2. Turn device location services off. Open a fresh composer and send immediately. Verify no location, permission prompt, enable-services dialog, or delay. Repeat with denied permission and with a previously cached device position.
3. With services enabled, test fresh GPS/network fixes, no fix for 10 seconds, and Send before the fix. Verify no location is attached after that early Send.
4. Disable connectivity after obtaining coordinates. Verify geocoder failure retains a tappable coordinate-only location and map tile failure retains the local list.
5. Close/resume and recreate a located draft; verify the position persists. Remove it, resume, and save; verify it stays removed. Refresh and verify a late result from the earlier request cannot overwrite the new location.
6. Save while address lookup is pending. Verify enrichment updates the correct post, and cannot overwrite a manual label/removal or recreate a deleted post.
7. Start an attachment import while location resolves; verify text, attachments, and coordinates all survive sending.
8. Verify map pins/filters with more than 200 located posts, overlapping positions, and a coordinate-only post. Open coordinates in an installed maps app.
9. Inspect Android map requests: app identifier, Referer, HTTPS tiles, and normal HTTP cache behavior. No offline/prefetch requests should occur after leaving the map.

No exact restaurant identification guarantee: Android geocoding varies by device, connectivity, and available geographic data.

## Permission and toolbar regression fix

The original explicit location action returned null whenever the hidden-by-default opt-in preference was false, and the editor discarded that result without feedback. The native composer also rendered location as a full-width body button. A regression test reproduced the null result before the fix and now passes. Location uses a toolbar pin, first-open permission handling, and explicit availability feedback. Native policy tests cover one-time prompting, disabled services/opt-out, and recent-versus-stale fixes. The toolbar layout was checked at 390-pixel phone width.
