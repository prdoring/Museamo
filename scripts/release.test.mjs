import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { options, assertVersions, assetNames, sha256, verifyBundle } from "./release.mjs";

test("debug builds are prereleases and dirty builds cannot enter the push command", () => {
  assert.equal(options(["push", "--android", "debug"]).prerelease, true);
  assert.throws(() => options(["push", "--allow-dirty"]), /only available for local/);
  assert.throws(() => options(["publish", "--allow-dirty"]), /only available for local/);
  assert.equal(options(["build", "--allow-dirty"]).allowDirty, true);
  assert.throws(() => options(["build", "--android", "unsigned"]), /debug or release/);
  assert.throws(() => options(["build", "--skip-tests"]), /Unknown option/);
});

test("version mismatch and invalid release versions stop packaging", () => {
  assert.equal(assertVersions({ "package.json": "0.4.0", Android: "0.4.0" }), "0.4.0");
  assert.throws(() => assertVersions({ "package.json": "0.4.0", Android: "0.3.0" }), /Version mismatch/);
  assert.throws(() => assertVersions({ "package.json": "../../secret" }), /major.minor.patch/);
});

test("publishing rejects missing, altered, dirty, or stale downloads", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "museamo-release-test-"));
  try {
    const source = { version: "0.4.0", commit: "a".repeat(40), dirty: false };
    const files = [];
    for (const name of [...assetNames(source.version, "debug"), "release-notes.md"]) {
      const file = path.join(directory, name);
      await writeFile(file, `fixture for ${name}`);
      files.push({ name, sha256: await sha256(file), size: (await stat(file)).size });
    }
    const sums = files.map(file => `${file.sha256}  ${file.name}`).join("\n") + "\n";
    await writeFile(path.join(directory, "SHA256SUMS.txt"), sums);
    const manifest = { schema: 1, ...source, android: "debug", files };
    await verifyBundle(directory, manifest, source);
    await assert.rejects(verifyBundle(directory, { ...manifest, files: files.slice(1) }, source), /incomplete/);
    await assert.rejects(verifyBundle(directory, { ...manifest, dirty: true }, source), /clean commit/);
    await assert.rejects(verifyBundle(directory, manifest, { ...source, dirty: true }), /clean commit/);
    await assert.rejects(verifyBundle(directory, manifest, { ...source, commit: "b".repeat(40) }), /clean commit/);
    await assert.rejects(verifyBundle(directory, manifest, { ...source, version: "0.5.0" }), /version/);
    await assert.rejects(verifyBundle(directory, { ...manifest, files: [{ ...files[0], name: "../secret" }, ...files.slice(1)] }, source), /incomplete|Invalid/);
    await writeFile(path.join(directory, files[0].name), "tampered APK");
    await assert.rejects(verifyBundle(directory, manifest, source), /Release file changed/);
    await writeFile(path.join(directory, files[0].name), `fixture for ${files[0].name}`);
    await writeFile(path.join(directory, "SHA256SUMS.txt"), "incorrect checksum list");
    await assert.rejects(verifyBundle(directory, manifest, source), /Checksum list changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
