# Widget resizing

- Default footprint remains 3 × 1. Minimum resize bounds are now 40 × 40 dp, allowing 1 × 1 on compatible launchers. Both axes are resizable, with no maximum imposed by the app.
- Small tiles show two equally sized icon buttons: message capture and Open Museamo. Horizontal layouts at least 260 dp wide restore the label, picker (for picker profiles), and app shortcut. Cards use a vertical layout when at least 100 × 120 dp is available.
- Android 12+ receives six responsive size variants; earlier versions receive portrait and landscape layouts from the launcher's size options.
- Resizing does not change widget bindings, tags, or drafts.

## Validation

- App debug APK and instrumentation APK build; Android lint and 11 JVM tests pass.
- `WidgetResizeTest` inflates actual RemoteViews at fourteen sizes in fixed/picker modes and at 100%/200% font scale. It checks capture and secondary actions remain visible, clickable, and within bounds. It uses supplied profile data without writing to the user's library.
- Installed the updated APK on the paired phone. `WidgetResizeTest` passed across all 56 size/mode/font-scale combinations. Inspected the rendered 40 × 40 and 80 × 80 dp compact layouts and the refined 180 × 60 dp two-cell layout. Launcher handle interaction and rotation remain manual checks.

## Launcher check

Long-press and resize an existing widget through small, wide, and tall sizes. Confirm capture, picker, and app opening still work, then rotate the launcher if supported. If the launcher caches old minimum bounds, re-add a widget to obtain the updated metadata. Actual grid increments are controlled by the launcher.
