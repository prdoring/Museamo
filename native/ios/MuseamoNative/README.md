# MuseamoNative

Swift package for the iOS offline text library. It depends only on Apple's SQLite system library and Foundation, and builds on iOS 15+ and macOS 13+.

The Capacitor host owns a `LibraryStore(databaseURL:)` and calls `execute(method:input:)` from one serial queue. Responses contain JSON-compatible dictionaries; failures are `LocalizedError` values suitable for bridge rejection. The host emits `dataChanged` after successful library mutations.

Implemented methods: `library`, `queryEntries`, `getEntry`, `getDraft`, `updateDraft`, `discardDraft`, `commitDraft`, `updateEntry`, `setStar`, `setCompleted`, `deleteEntry`, `restoreEntry`, `saveTag`, `deleteTag`, `saveProfile`, `listRecovery`, `restoreRecovery`, `clearRecovery`, and `clearAllRecovery`.

Storage uses schema version 1 with transactional migrations, foreign keys, WAL journaling and full synchronous writes. Draft commits atomically create the thought, assign inline hashtags, record the commit ID and remove the matching draft. Retries return the same thought ID and cannot delete a newer draft or resurrect a deleted thought. Reopening a draft retains its UUID. Entry edits accept `baseRevision` guards. Star and completion changes preserve the text edit timestamp.

Queries run in SQLite with bounded page sizes (1–1,000), literal case-insensitive Unicode text search, tag/star/checklist filters, and stable descending timestamp/ID cursors. Checklist cursors additionally require `beforeCompleted`. Empty text thoughts and nonempty attachment/location writes are rejected. Media, location, backup, sharing and device sync belong to later milestones.

Local Recovery keeps prior versions on edits, star/completion changes and deletions until explicitly cleared. Restore creates a new UUID, matching Android's restore behavior, and filters tags and capture profiles that no longer exist. Recovery and local revisions do not implement the shared Rust synchronization protocol.

Run the package tests:

```sh
swift test --package-path native/ios/MuseamoNative
```

Tests cover database reopening, draft/commit identity, transaction rollback, pagination, filters, revisions, Recovery, tag/profile cleanup, and the repository's shared hashtag fixtures.
