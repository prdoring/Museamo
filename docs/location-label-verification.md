# Location label and data preservation verification

Verified September 28, 2026.

Display labels use place name plus city/state in the US, and place name plus city/country elsewhere. The place name is optional. Full addresses remain in the data layer and search index. Optional city, region, country, and country-code metadata survives bridge validation and backup import/export. Existing stored location JSON is not rewritten by display formatting. Older records without country metadata retain their known locality.

## Validation

- 90 web tests pass, including 24 shared label fixtures, immutable-input checks, full-address search, edits, and deletion Undo.
- 12 Android JVM tests pass. The native formatter consumes the same shared fixtures as the web formatter.
- TypeScript check, Vite production build, Android debug assembly, and Android lint pass. Lint reports 0 errors and 79 warnings; existing Vite texture/chunk-size warnings remain.
- 15 instrumented tests pass on the isolated API 34 emulator: LocationStorageTest, ChecklistStorageTest, and NativeMediaTest.
- Migration tests from schemas 1–3 preserve thought text, timestamps, stars, tags, profiles, widget bindings, drafts, attachment references, media metadata, and existing full location JSON/search text. Schema 4 adds checklist fields with safe defaults; the location-label change adds no database migration.
- Backup tests preserve full addresses and structured location fields through repeated version 4 ZIP imports. Legacy import behavior, existing tag conflicts, original attachments, text edits, Undo, and reopening the database are covered by the selected native suites.
- A browser interaction check verifies all three requested location formats, the location sheet, searching by a postal code that is hidden from the short label, unchanged stored entries after browsing, and light/dark rendering.

No application install, uninstall, reset, or storage mutation was performed on the connected physical phone. Android install/test commands targeted `emulator-5554` explicitly. Production storage keeps its existing package/database identity and uses explicit Room migrations without a destructive fallback.

Local browser evidence is in `artifacts/location-labels/`. Test logs are `artifacts-location-tests-build.log`, `artifacts-location-android-build.log`, and `artifacts-location-instrumented.log`. The revised APK is `android/app/build/outputs/apk/debug/app-debug.apk`.

Before updating a device with irreplaceable thoughts, export a backup through Settings and retain the existing app installation. Install the APK as an update; a signature or version rejection should be resolved without uninstalling or clearing storage. Drafts are preserved by an in-place update but are not part of the posted-thought backup archive.
