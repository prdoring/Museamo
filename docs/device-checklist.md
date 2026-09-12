# Device acceptance checklist

Automated build/database tests do not establish physical launcher UX. Record device, Android version, launcher, keyboard, result and date when running these checks. Pixel and Samsung checks are pending until performed on those devices.

- Fresh install, airplane mode: add a widget without opening the app first; configure tags, capture, and verify the stream.
- Add two fixed widgets and two pickers. Check defaults, independent selections, search, No tag, dismissal and home navigation.
- Type an unfinished draft in each widget. Back out, switch picker defaults, reopen: draft text/tags are unchanged. Send and reopen: new default applies.
- Kill the app process (not Android force-stop, which intentionally disables components), capture again, reboot and verify persisted entries/drafts.
- Rapidly tap Send: exactly one entry. Fill/deny storage in a test environment: text remains and retry is offered.
- Rotate with a draft and with tag/configuration dialogs open. Check draft preservation and no accidental capture.
- Rename/delete tags: relationships update, picker falls back to No tag, entries remain. Remove widget: saved entries remain.
- Edit profile in Settings, verify launcher refresh. Restore backup, create widget from copied profile, ensure selections remain independent.
- Star/unstar, edit, filter, paginate, delete/Undo, and resume app after native capture.
- Export/import on a fresh installation; import same file twice; conflicting IDs preserve both contents; invalid file changes nothing. Cancel each picker.
- Check large font/display scaling, light/dark themes, TalkBack labels/focus, 44+ dp controls, keyboard overlap, widget resize and Pixel/Samsung launcher behavior.
- Confirm no unexpected network requests, no data cloud backup, and APK can run without network permission.
