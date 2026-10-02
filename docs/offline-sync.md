# Windows companion and local-network sync

Windows keeps its own offline library. Linked Android and Windows devices exchange saved thoughts, tags, locations, and original attachments directly on the local network. Any trusted device can introduce another; no phone, PC, account, relay, or cloud service has to remain online. Drafts, widgets, capture defaults, permissions, and startup settings remain local. Web links and maps still contact their providers when opened.

## Linking and daily use

Open Settings → Linked devices on both devices. Select a nearby device, or enter its displayed local address when discovery is blocked. Guest networks and access-point isolation can prevent a connection even when both devices show the same network name.

Compare every group of the completed-handshake code on both screens. Names and discovery announcements are untrusted hints. Cancel if the codes differ. After both confirmations, each device can show the other library’s summary; both sides then approve combining the libraries. Displaced versions remain in Recovery. Two already separate sync groups cannot link directly; use portable import to combine their content.

Windows keeps syncing in the tray after its window closes. Quit from the tray stops it. Startup at Windows sign-in is opt-in. With both main apps open, saved changes wake replication immediately and refresh the mounted feed; the 30-second timer is a retry fallback. Reopening the main app also attempts catch-up immediately. Original attachment bytes can take longer than thought metadata. Android background work can be delayed by battery restrictions, and a widget-only capture catches up on a later main-app resume or background run. Sync now remains available for a manual retry.

## Conflicts and Recovery

A thought is one versioned object: text, stars, completion, originals, and location travel together. Causally later revisions win. Among concurrent revisions, deletion wins, followed by the hybrid logical clock and stable device/sequence ordering. Selection evaluates the complete maximal causal frontier; comparing only an arriving revision with the current winner cannot converge across three devices.

Deleted bodies and earlier versions stay in shared Recovery until cleared. Restore creates a fresh thought ID. Clearing propagates a signed purge; clearing a deleted thought also retires its original ID to prevent offline resurrection. Signed headers remain after bodies are erased so origin chains can still be verified. An editor carries its saved base revision; a stale save keeps unsaved edits and offers Save as new or Load current version.

Compatible same-name/type tags can combine during initial linking through signed aliases. Existing ambiguous groups stay separate, including collisions created by later renames. The UI disambiguates colliding names by type and short ID. Local creation still validates uniqueness. Removing a tag filters derived associations without manufacturing text edits. Unsupported codecs retain originals; missing files show that they are waiting to sync.

## Native architecture and trust

`crates/sync-core` owns canonical JSON, signatures, causal selection, membership, Noise, pairing, encrypted transport, discovery, and coordination. Windows uses it directly; Android uses the same Rust implementation through JNI. Kotlin retains Room, Keystore, widgets, lifecycle, and scheduling.

Native `Platform` callbacks supply identity, signing, persistence, envelopes, receipts, and original transfer. They are never renderer commands. The WebView cannot read private keys or drive low-level cryptographic sessions. Windows wraps secrets with DPAPI; Android uses Keystore. Real storage failures remain visible and never fall back to preview data.

Saved-data mutations, revision allocation, Recovery retention, and projection belong to a transaction. Applied receipts acknowledge durable contiguous origin sequences. Separate staged receipts permit paging incomplete removed-origin history without changing winners or witness checkpoints. Signed headers bind protocol, group, kind, entity, origin sequence, previous-header hash, causal context, clock, deletion, and payload digest. Duplicate delivery is idempotent; differing headers for the same origin sequence fail closed.

Sessions use `Noise_XX_25519_ChaChaPoly_SHA256` and a session-bound P-256 identity proof. Known keys must match their pins. Matching-code confirmation and combining-library consent are separate gates. Summaries and content wait for the appropriate gate.

Signed membership changes establish admission and removal. Each remaining witness freezes a removed origin’s applied prefix when it first learns removal. Their authenticated checkpoints authorize a historical union, preserving legitimate history regardless of delivery order. The removed device cannot witness itself. Removed-origin proofs must match the exact chain ending at the authorized checkpoint; a sequence below the cap is insufficient. Out-of-order purge proofs can stage but cannot erase or retire content before authorization succeeds.

Removal spreads when peers reconnect. It cannot instantly reach disconnected partitions or remotely erase copies already held by a removed device.

An open session checks current membership for each saved-data callback and encrypted outgoing record. Removal fences those operations; previously transmitted bytes cannot be recalled. Sync media access uses shared saved thoughts and Recovery, excluding originals retained solely by a private draft or temporary local pin.

Removal never restores access when concurrent membership changes arrive. Conflicting removals quarantine sync while preserving the local library; recovery requires exporting content, using a fresh installation identity, and linking again. Windows reinstalls may retain app data and the old identity, so reinstalling alone is insufficient: preserve the backup and use fresh app data before importing it. A removed key relayed through a stale trusted peer can manufacture an apparently concurrent removal and trigger this quarantine. It cannot grant access or erase library content. Eliminating this denial-of-service case requires a separately sequenced and checkpointed membership-control protocol; data-history checkpoints do not authenticate control history.

## Backups and development

ZIP manifest version 5 includes Recovery and referenced originals. Older supported backups remain importable. Imports become local saved-data mutations that can sync. Staging, checksum verification, and rollback protect existing content. Portable backups carry no identity keys, membership, or replication cursors; new installations get fresh identities.

Windows needs Node 22+, Rust’s MSVC toolchain, and Windows C++ build tools. Run `npm ci`, then `npm run desktop:dev`. `npm run desktop:build` produces the app executable at `target/release/museamo-desktop.exe` and the NSIS installer under `target/release/bundle/nsis`. The installer bundles WebView2's offline installer so installation does not depend on downloading it. See [development](development.md) and [local releases](releases.md).

Android needs the SDK, NDK, and Rust Android targets:

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm run android:sync-core
npm run android:sync
```

Set `ANDROID_HOME` to the SDK. The portable builder selects the installed NDK and packages four ABIs. `SYNC_ANDROID_ABIS=x86_64` limits development builds to the emulator. Add `-PsyncCoreRelease` to Gradle debug builds for optimized native libraries and a smaller APK; release builds use optimized libraries automatically. JNI libraries are ignored build outputs; Android retains API 24 support.

Run `npm test`, `npm run typecheck`, and `cargo test --workspace`, plus Android Gradle unit, lint, and connected-device suites. Local transport, native storage, and browser tests complement each other. Physical firewall, Wi-Fi isolation, battery scheduling, codec, and installer behavior require their own checks.
