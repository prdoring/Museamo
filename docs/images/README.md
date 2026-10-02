# README visuals

These images are committed documentation assets. Keep APKs, installers, raw artwork explorations, and build logs in ignored output folders.

- `banner.svg`: original Museamo lantern and vector wordmark, composed by `scripts/docs-banner.mjs`. Regenerate with `node scripts/docs-banner.mjs`.
- `desktop-*.jpg`: current browser UI captured through the Codex browser using sample thoughts. The visible preview strip and simulated location distinguish it from a native library. Capture screenshots through the normal app controls; never include private libraries or pairing codes.
- `phone-stream.png`, `phone-dark.png`: sample-data phone layouts from the branding verification captures. Their custom logo and feed use the same fonts as the current app.
- `android-widget.png`: native RemoteViews widget from the isolated paper-theme test app. Launcher sizing depends on the device.

Use clear alt text and explain a screenshot beside the relevant step. Refresh screenshots when the corresponding user flow changes. Review every capture for private text, device names, addresses, and locations before committing it.
