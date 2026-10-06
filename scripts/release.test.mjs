import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, stat, symlink } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { options, assertVersions, assertBuildHost, sha256, verifyBundle, publish } from "./release.mjs";
import { artifactName, platforms, targets, kinds, assertPlatformManifest, verifyFiles, metadataHash, verificationChecks, publicationFiles } from "./release-artifacts.mjs";
import { configureSigning, signingSource } from "./release-signing.mjs";

test("signing loads saved credentials and preserves complete explicit overrides", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "museamo-signing-test-"));
  try {
    const keystore = path.join(directory, "fixture.p12");
    await writeFile(keystore, "not a real key");
    const saved = { schema: 1, MUSEAMO_KEYSTORE: keystore, MUSEAMO_KEY_ALIAS: "fixture", MUSEAMO_STORE_PASSWORD: "test-only", MUSEAMO_KEY_PASSWORD: "test-only" };
    const env = {};
    await configureSigning(env, () => saved, "win32");
    assert.equal(env.MUSEAMO_KEYSTORE, keystore);
    assert.equal(env.MUSEAMO_KEY_ALIAS, "fixture");
    await configureSigning(env, () => { throw new Error("complete overrides must not read saved credentials"); });
    assert.equal(signingSource({}), "saved");
    assert.equal(signingSource(env), "environment");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("signing refuses partial overrides, malformed saved credentials, and lost keys", async () => {
  assert.throws(() => signingSource({ MUSEAMO_KEYSTORE: "existing.p12" }), /Incomplete Android signing override/);
  await assert.rejects(configureSigning({}, () => ({ schema: 1 }), "win32"), /Invalid saved signing configuration/);
  await assert.rejects(configureSigning({}, () => ({ schema: 2 }), "win32"), /Invalid saved signing configuration/);
  const directory = await mkdtemp(path.join(tmpdir(), "museamo-missing-key-test-"));
  try {
    const env = { MUSEAMO_KEYSTORE: path.join(directory, "missing.p12"), MUSEAMO_KEY_ALIAS: "fixture", MUSEAMO_STORE_PASSWORD: "test-only", MUSEAMO_KEY_PASSWORD: "test-only" };
    await assert.rejects(configureSigning(env), /Restore your key backup/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Unix signing requires a complete explicit identity and never loads Windows storage", async () => {
  let loaded = false;
  await assert.rejects(configureSigning({}, () => { loaded = true; }, "darwin"), /all four MUSEAMO signing variables/);
  assert.equal(loaded, false);
  await assert.rejects(configureSigning({ MUSEAMO_KEY_ALIAS: "fixture" }, () => { loaded = true; }, "linux"), /Incomplete Android signing override/);
  assert.equal(loaded, false);
});

test("build commands select one host, debug previews stay local, and publication is explicit", () => {
  assert.equal(options(["build"]).platform, "windows");
  assert.equal(options(["build", "--platform", "android", "--android", "debug"]).prerelease, true);
  assert.equal(options(["build", "--platform", "macos", "--allow-dirty"]).allowDirty, true);
  assert.throws(() => options(["push"]), /combined push command was removed/);
  assert.throws(() => options(["publish", "--allow-dirty"]), /only available for local/);
  assert.throws(() => options(["assemble", "--allow-dirty"]), /only available for local/);
  assert.throws(() => options(["build", "--android", "debug"]), /only available for Android/);
  assert.throws(() => options(["build", "--platform", "android", "--android", "unsigned"]), /debug or release/);
  assert.throws(() => options(["build", "--skip-tests"]), /Unknown option/);
  assert.equal(options(["publish", "--ci"]).ci, true);
  assert.throws(() => options(["build", "--ci"]), /only available for publication/);
  assert.throws(() => options(["assemble", "--platforms", "linux,linux"]), /duplicate/);
  assert.throws(() => options(["build", "--platform"]), /Missing value/);
  assert.deepEqual(options(["assemble", "--platforms", "android,windows"]).platforms, ["android", "windows"]);
  assert.throws(() => assertBuildHost("windows", "darwin", "arm64"), /Build windows on win32 x64/);
  assert.throws(() => assertBuildHost("linux", "linux", "arm64"), /Build linux/);
  assert.doesNotThrow(() => assertBuildHost("android", "darwin", "arm64"));
  assert.doesNotThrow(() => assertBuildHost("macos", "darwin", "arm64"));
});

test("version mismatch and invalid release versions stop packaging", () => {
  assert.equal(assertVersions({ "package.json": "0.4.0", Android: "0.4.0" }), "0.4.0");
  assert.throws(() => assertVersions({ "package.json": "0.4.0", Android: "0.3.0" }), /Version mismatch/);
  assert.throws(() => assertVersions({ "package.json": "../../secret" }), /major.minor.patch/);
});

const source = { version: "0.4.0", versionCode: 5, commit: "a".repeat(40), dirty: false };
async function publicationHarness() {
  const { directory, manifest } = await fixture(["android", "windows"]);
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const snapshotParent = await mkdtemp(path.join(tmpdir(), "museamo-publication-test-"));
  const remote = new Map(), calls = [], parent = "c".repeat(40);
  const state = { failUpload: 0, uploads: 0, edits: 0, published: false, corruptDownload: false, remoteCommit: source.commit };
  const dependencies = {
    snapshotParent,
    sourceState: async () => source,
    git: (...args) => {
      calls.push(["git", ...args]);
      if (args[0] === "rev-parse") return args[1] === "HEAD^" ? parent : source.commit;
      if (args[0] === "rev-list") return source.commit;
      if (args[0] === "ls-remote") return `${state.remoteCommit}\trefs/tags/v0.4.0^{}`;
      if (args[0] === "for-each-ref") return JSON.stringify({ schema: 1, version: source.version, versionCode: source.versionCode, sourceCommit: parent });
      throw new Error(`Unexpected git mutation: ${args[0]}`);
    },
    run: (command, args) => {
      calls.push([command, ...args]);
      assert.equal(command, "gh");
      if (args[0] === "auth") return "";
      if (args[0] === "repo") return "owner/repo";
      if (args[0] === "api") return JSON.stringify([[{ tag_name: "v0.4.0", draft: !state.published }]]);
      if (args[1] === "view") return JSON.stringify({ isDraft: !state.published, assets: [...remote.keys()].map(name => ({ name })) });
      if (args[1] === "upload") {
        state.uploads++;
        if (state.failUpload === state.uploads) throw new Error("Interrupted upload");
        const filename = args.at(-1), name = path.basename(filename);
        assert.equal(remote.has(name), false, "An existing asset must never be replaced");
        remote.set(name, readFileSync(filename));
        return "";
      }
      if (args[1] === "download") {
        const name = args[args.indexOf("--pattern") + 1], destination = args[args.indexOf("--dir") + 1];
        writeFileSync(path.join(destination, name), state.corruptDownload ? "changed bytes" : remote.get(name));
        return "";
      }
      if (args[1] === "edit") { state.edits++; state.published = true; return ""; }
      throw new Error(`Unexpected release command: ${args[1]}`);
    },
  };
  return { directory, manifest, dependencies, state, calls, remote, cleanup: async () => { await rm(directory, { recursive: true, force: true }); await rm(snapshotParent, { recursive: true, force: true }); } };
}

test("CI publication resumes identical draft bytes and never pushes a branch or tag", async () => {
  const harness = await publicationHarness(), previous = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  try {
    harness.state.failUpload = 2;
    await assert.rejects(publish({ ci: true, directory: harness.directory }, source, source, harness.dependencies), /Interrupted upload/);
    assert.equal(harness.state.edits, 0);
    assert.equal(harness.remote.size, 1);
    harness.state.failUpload = 0;
    await publish({ ci: true, directory: harness.directory }, source, source, harness.dependencies);
    assert.equal(harness.state.edits, 1);
    assert.equal(harness.remote.size, harness.manifest.files.length + 2);
    assert.equal(harness.calls.some(call => call[0] === "git" && ["push", "tag"].includes(call[1])), false);
    assert.equal(harness.calls.some(call => call.includes("--clobber")), false);
    const uploads = harness.state.uploads;
    await assert.rejects(publish({ ci: true, directory: harness.directory }, source, source, harness.dependencies), /already published/);
    assert.equal(harness.state.uploads, uploads);
  } finally { if (previous === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = previous; await harness.cleanup(); }
});

test("CI publication refuses changed remote tags, altered downloads, and incomplete receipts", async () => {
  const harness = await publicationHarness(), previous = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  try {
    harness.state.remoteCommit = "d".repeat(40);
    await assert.rejects(publish({ ci: true, directory: harness.directory }, source, source, harness.dependencies), /remote tag differs/);
    assert.equal(harness.state.uploads, 0);
    harness.state.remoteCommit = source.commit;
    harness.state.corruptDownload = true;
    await assert.rejects(publish({ ci: true, directory: harness.directory }, source, source, harness.dependencies), /Release file changed/);
    assert.equal(harness.state.edits, 0);
    const modified = { ...harness.manifest, verification: {} };
    await writeFile(path.join(harness.directory, "manifest.json"), JSON.stringify(modified));
    await assert.rejects(publish({ ci: true, directory: harness.directory }, source, source, harness.dependencies), /Missing or stale verification/);
    assert.equal(harness.state.edits, 0);
  } finally { if (previous === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = previous; await harness.cleanup(); }
});

function platformManifest(platform, android = "release") {
  return { schema: 2, version: source.version, versionCode: source.versionCode, commit: source.commit, cleanSource: true, platform, target: targets[platform], prerelease: android === "debug", ...(platform === "android" ? { android, signingCertificate: "b".repeat(64) } : {}), ...(platform === "macos" ? { macosDistribution: "developer-id-notarized" } : {}), files: [] };
}
async function fixture(selected = platforms, android = "release") {
  const directory = await mkdtemp(path.join(tmpdir(), "museamo-release-test-"));
  const builds = [];
  async function file(name, kind, target) {
    const location = path.join(directory, name);
    await writeFile(location, `fixture for ${name}`);
    return { name, kind, target, version: source.version, commit: source.commit, cleanSource: true, sha256: await sha256(location), size: (await stat(location)).size };
  }
  for (const platform of selected) {
    const manifest = platformManifest(platform, android);
    for (const kind of kinds[platform]) manifest.files.push(await file(artifactName(source.version, platform, kind, android), kind, manifest.target));
    builds.push(manifest);
  }
  const files = [...builds.flatMap(build => build.files), await file(`Museamo-${source.version}-source.zip`, "source", "source"), await file("release-notes.md", "notes", "source")];
  await writeFile(path.join(directory, "SHA256SUMS.txt"), files.map(file => `${file.sha256}  ${file.name}`).join("\n") + "\n");
  const verification = Object.fromEntries(builds.map(build => [build.platform, { schema: 1, commit: build.commit, version: build.version, platform: build.platform, manifestSha256: metadataHash(build), checks: verificationChecks(build.platform) }]));
  return { directory, manifest: { schema: 2, version: source.version, versionCode: source.versionCode, commit: source.commit, cleanSource: true, platforms: selected, prerelease: android === "debug", builds, files, verification } };
}

// Exercise the complete transport format without invoking native build tools or external services.
test("assembly accepts all targets and deliberate desktop-only or Windows/Android selections", async () => {
  for (const selected of [platforms, ["macos"], ["linux"], ["android", "windows"]]) {
    const { directory, manifest } = await fixture(selected, "debug");
    try { await verifyBundle(directory, manifest, source, { requireVerification: true }); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("assembly refuses incomplete, duplicate, inconsistent, or unverified builds", async () => {
  const { directory, manifest } = await fixture();
  try {
    const check = altered => verifyBundle(directory, altered, source, { requireVerification: true });
    await assert.rejects(check({ ...manifest, builds: manifest.builds.slice(1) }), /incomplete/);
    await assert.rejects(check({ ...manifest, builds: [manifest.builds[0], manifest.builds[0], ...manifest.builds.slice(2)] }), /Duplicate/);
    await assert.rejects(check({ ...manifest, platforms: ["android", "android", "macos", "linux"] }), /platform selection/);
    await assert.rejects(check({ ...manifest, verification: {} }), /Missing or stale verification/);
    const stale = structuredClone(manifest);
    stale.builds[0].signingCertificate = "c".repeat(64);
    await assert.rejects(check(stale), /stale verification/);
    for (const field of ["commit", "version", "versionCode"]) {
      const inconsistent = structuredClone(manifest);
      inconsistent.builds[1][field] = field === "versionCode" ? 6 : "different";
      await assert.rejects(check(inconsistent), /manifest|commit\/version/);
    }
    const mismatchedArtifact = structuredClone(manifest);
    mismatchedArtifact.files[1] = { ...mismatchedArtifact.files[1], size: mismatchedArtifact.files[1].size + 1 };
    await assert.rejects(check(mismatchedArtifact), /metadata|differs/);
    await assert.rejects(check({ ...manifest, cleanSource: false }), /clean commit/);
    await assert.rejects(verifyBundle(directory, manifest, { ...source, dirty: true }), /clean commit/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Android signing and prerelease modes cannot change during assembly", async () => {
  const { directory, manifest } = await fixture(["android"], "debug");
  try {
    await assert.rejects(verifyBundle(directory, { ...manifest, prerelease: false }, source), /Prerelease builds/);
    const unsigned = structuredClone(manifest.builds[0]);
    delete unsigned.signingCertificate;
    assert.throws(() => assertPlatformManifest(unsigned, source), /signing metadata/);
    const stableDebug = { ...manifest.builds[0], prerelease: false };
    assert.throws(() => assertPlatformManifest(stableDebug, source), /Debug APKs/);
    const wrongTarget = { ...manifest.builds[0], target: targets.windows };
    assert.throws(() => assertPlatformManifest(wrongTarget, source), /platform\/target/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("artifact validation rejects path traversal, duplicates, altered bytes, symlinks, and extra files", async () => {
  const { directory, manifest } = await fixture(["linux"]);
  try {
    const files = manifest.builds[0].files;
    for (const name of ["../secret", "..\\secret", "/secret", "C:\\secret", ".", "..", ""]) {
      await assert.rejects(verifyFiles(directory, [{ ...files[0], name }]), /Invalid release filename/);
    }
    await assert.rejects(verifyFiles(directory, [files[0], files[0]]), /Duplicate/);
    const duplicateKind = { ...manifest.builds[0], files: [files[0], files[0]] };
    assert.throws(() => assertPlatformManifest(duplicateKind, source), /Duplicate/);
    await writeFile(path.join(directory, files[0].name), "changed");
    await assert.rejects(verifyBundle(directory, manifest, source), /Release file changed/);
    await writeFile(path.join(directory, files[0].name), `fixture for ${files[0].name}`);
    if (process.platform !== "win32") {
      await rm(path.join(directory, files[0].name));
      await writeFile(path.join(directory, "actual.deb"), `fixture for ${files[0].name}`);
      await symlink("actual.deb", path.join(directory, files[0].name));
      await assert.rejects(verifyFiles(directory, files), /Release file changed/);
      await rm(path.join(directory, files[0].name));
      await rm(path.join(directory, "actual.deb"));
      await writeFile(path.join(directory, files[0].name), `fixture for ${files[0].name}`);
    }
    await writeFile(path.join(directory, "stale.exe"), "old output");
    await assert.rejects(verifyBundle(directory, manifest, source), /unlisted files/);
    await rm(path.join(directory, "stale.exe"));
    await writeFile(path.join(directory, "SHA256SUMS.txt"), "wrong sums");
    await assert.rejects(verifyBundle(directory, manifest, source), /Checksum list changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("unsigned or unnotarized macOS previews cannot become stable downloads", async () => {
  const { directory, manifest } = await fixture(["macos"]);
  try {
    const preview = { ...manifest.builds[0], macosDistribution: "preview", prerelease: false };
    assert.throws(() => assertPlatformManifest(preview, source), /must be prereleases/);
    assert.doesNotThrow(() => assertPlatformManifest({ ...preview, prerelease: true }, source));
    assert.throws(() => assertPlatformManifest({ ...preview, macosDistribution: undefined }, source), /distribution metadata/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("publication hashes bind all uploaded bytes to the reviewed snapshot", async () => {
  const { directory, manifest } = await fixture(["linux"]);
  try {
    const manifestBytes = JSON.stringify(manifest, null, 2) + "\n";
    await writeFile(path.join(directory, "manifest.json"), manifestBytes);
    const uploads = publicationFiles(manifest, manifestBytes);
    await verifyFiles(directory, uploads);
    assert.equal(uploads.length, manifest.files.length + 2);
    assert.equal(uploads.find(file => file.name === manifest.files[0].name).sha256, manifest.files[0].sha256);
    assert.throws(() => publicationFiles(manifest, JSON.stringify({ ...manifest, prerelease: true })), /differs from reviewed/);
    // Parsed JSON still matches, but a transport byte change must not pass publication.
    await writeFile(path.join(directory, "manifest.json"), manifestBytes + "\n");
    await assert.rejects(verifyFiles(directory, uploads), /Release file changed: manifest.json/);
    await writeFile(path.join(directory, "manifest.json"), manifestBytes);
    await writeFile(path.join(directory, "release-notes.md"), "changed after review");
    await assert.rejects(verifyFiles(directory, uploads), /Release file changed: release-notes.md/);
    // Captured expectations never adopt the altered notes or artifact bytes.
    assert.deepEqual(publicationFiles(manifest, manifestBytes), uploads);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
