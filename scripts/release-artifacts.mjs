import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const platforms = ["android", "windows", "macos", "linux"];
export const targets = {
  android: "android-universal",
  windows: "x86_64-pc-windows-msvc",
  macos: "aarch64-apple-darwin",
  linux: "x86_64-unknown-linux-gnu",
};
export const kinds = {
  android: ["apk"], windows: ["nsis", "exe"], macos: ["app-tar", "dmg"], linux: ["deb", "appimage"],
};

export function artifactName(version, platform, kind, android = "release") {
  const suffix = {
    apk: `android${android === "debug" ? "-debug" : ""}.apk`,
    nsis: "windows-x64-setup.exe", exe: "windows-x64.exe",
    "app-tar": "macos-arm64.app.tar.gz", dmg: "macos-arm64.dmg",
    deb: "linux-x64.deb", appimage: "linux-x64.AppImage",
  }[kind];
  if (!kinds[platform]?.includes(kind)) throw new Error("Invalid artifact platform/kind.");
  return `Museamo-${version}-${suffix}`;
}
export function assetNames(version, android = "release", selected = ["android", "windows"]) {
  return [...selected.flatMap(platform => kinds[platform].map(kind => artifactName(version, platform, kind, android))), `Museamo-${version}-source.zip`];
}
export async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
// Hash parsed metadata, so receipts survive whitespace-only JSON transport changes.
export function metadataHash(manifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}
export function assertFilename(name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || /[\\/\x00-\x1f:]/.test(name) || path.basename(name) !== name) throw new Error("Invalid release filename.");
}
function assertSource(manifest, source, allowDirty) {
  if (manifest.schema !== 2 || !/^\d+\.\d+\.\d+$/.test(manifest.version) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.commit) || typeof manifest.cleanSource !== "boolean" || !Number.isSafeInteger(manifest.versionCode) || manifest.versionCode < 1) throw new Error("Invalid release manifest.");
  if (manifest.commit !== source.commit || manifest.version !== source.version || manifest.versionCode !== source.versionCode) throw new Error("Release commit/version no longer matches the source.");
  if (!allowDirty && (!manifest.cleanSource || source.dirty)) throw new Error("Release files must come from the current clean commit.");
}
export function assertPlatformManifest(manifest, source, { allowDirty = false } = {}) {
  assertSource(manifest, source, allowDirty);
  const platform = manifest.platform;
  if (!platforms.includes(platform) || manifest.target !== targets[platform]) throw new Error("Invalid release platform/target.");
  if (typeof manifest.prerelease !== "boolean") throw new Error("Invalid prerelease mode.");
  if (platform === "android") {
    if (!["debug", "release"].includes(manifest.android) || !/^[a-f0-9]{64}$/.test(manifest.signingCertificate || "")) throw new Error("Invalid Android signing metadata.");
    if (manifest.android === "debug" && !manifest.prerelease) throw new Error("Debug APKs must be prereleases.");
  } else if (manifest.android !== undefined || manifest.signingCertificate !== undefined) throw new Error("Android signing metadata is only valid for APK builds.");
  if (platform === "macos") {
    if (!["preview", "developer-id-notarized"].includes(manifest.macosDistribution)) throw new Error("Invalid macOS distribution metadata.");
    if (manifest.macosDistribution === "preview" && !manifest.prerelease) throw new Error("Unsigned or unnotarized macOS artifacts must be prereleases.");
  } else if (manifest.macosDistribution !== undefined) throw new Error("macOS distribution metadata is only valid for macOS builds.");
  const expected = kinds[platform];
  if (!Array.isArray(manifest.files) || manifest.files.length !== expected.length) throw new Error("Platform bundle is incomplete.");
  const seen = new Set();
  for (const file of manifest.files) {
    assertFilename(file.name);
    if (!expected.includes(file.kind) || seen.has(file.kind) || file.name !== artifactName(source.version, platform, file.kind, manifest.android)) throw new Error("Duplicate or unexpected artifact.");
    seen.add(file.kind);
    if (file.target !== manifest.target || file.version !== manifest.version || file.commit !== manifest.commit || file.cleanSource !== manifest.cleanSource) throw new Error("Artifact metadata disagrees with its source manifest.");
    assertFileMetadata(file);
  }
}
function assertFileMetadata(file) {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || !/^[a-f0-9]{64}$/.test(file.sha256 || "")) throw new Error("Invalid release file metadata.");
}
export async function verifyFiles(directory, files) {
  const names = new Set();
  for (const file of files) {
    assertFilename(file.name);
    assertFileMetadata(file);
    if (names.has(file.name)) throw new Error("Duplicate release filename.");
    names.add(file.name);
    const location = path.join(directory, file.name);
    const state = await lstat(location);
    if (!state.isFile() || state.isSymbolicLink() || state.size !== file.size || await sha256(location) !== file.sha256) throw new Error(`Release file changed: ${file.name}. Rebuild before publishing.`);
  }
}
export function verificationChecks(platform) {
  return ["release-tooling", "frontend", ...(platform === "android" ? ["rust-core", "android-builder", "android-unit", "android-lint"] : ["rust-workspace"])];
}
export function assertVerification(receipt, manifest) {
  const expected = verificationChecks(manifest.platform);
  if (receipt?.schema !== 1 || receipt.commit !== manifest.commit || receipt.version !== manifest.version || receipt.platform !== manifest.platform || receipt.manifestSha256 !== metadataHash(manifest) || !Array.isArray(receipt.checks) || receipt.checks.length !== expected.length || expected.some(check => !receipt.checks.includes(check))) throw new Error(`Missing or stale verification for ${manifest.platform}. Run release:verify on its build host, then assemble again.`);
}
export async function verifyBundle(directory, manifest, source, { requireVerification = false } = {}) {
  assertSource(manifest, source, false);
  if (typeof manifest.prerelease !== "boolean" || !Array.isArray(manifest.platforms) || !manifest.platforms.length || new Set(manifest.platforms).size !== manifest.platforms.length || manifest.platforms.some(platform => !platforms.includes(platform))) throw new Error("Invalid assembly platform selection.");
  if (!Array.isArray(manifest.builds) || manifest.builds.length !== manifest.platforms.length) throw new Error("Release bundle is incomplete.");
  const artifactFiles = [];
  const seen = new Set();
  for (const build of manifest.builds) {
    assertPlatformManifest(build, source);
    if (!manifest.platforms.includes(build.platform) || seen.has(build.platform)) throw new Error("Duplicate or unexpected platform manifest.");
    seen.add(build.platform);
    if (build.prerelease && !manifest.prerelease) throw new Error("Prerelease builds cannot become a stable release.");
    if (requireVerification) assertVerification(manifest.verification?.[build.platform], build);
    artifactFiles.push(...build.files);
  }
  const extras = [`Museamo-${source.version}-source.zip`, "release-notes.md"];
  if (!Array.isArray(manifest.files) || manifest.files.length !== artifactFiles.length + extras.length) throw new Error("Release bundle is incomplete.");
  for (const artifact of artifactFiles) {
    const file = manifest.files.find(file => file.name === artifact.name);
    if (!file || JSON.stringify(file) !== JSON.stringify(artifact)) throw new Error("Assembly artifact differs from build manifest.");
  }
  for (const name of extras) {
    const file = manifest.files.find(file => file.name === name);
    if (!file || file.kind !== (name.endsWith(".zip") ? "source" : "notes") || file.target !== "source" || file.version !== manifest.version || file.commit !== manifest.commit || file.cleanSource !== true) throw new Error("Invalid source/notes metadata.");
  }
  await verifyFiles(directory, manifest.files);
  const allowed = new Set([...manifest.files.map(file => file.name), "SHA256SUMS.txt", "manifest.json"]);
  if ((await readdir(directory)).some(name => !allowed.has(name))) throw new Error("Assembly contains unlisted files. Use a fresh assembly directory.");
  const sums = manifest.files.map(file => `${file.sha256}  ${file.name}`).join("\n") + "\n";
  const sumsState = await lstat(path.join(directory, "SHA256SUMS.txt"));
  if (!sumsState.isFile() || sumsState.isSymbolicLink() || await readFile(path.join(directory, "SHA256SUMS.txt"), "utf8") !== sums) throw new Error("Checksum list changed. Rebuild before publishing.");
}

// The publication metadata hashes come from the reviewed snapshot, never from later mutable bytes.
export function publicationFiles(manifest, manifestBytes) {
  if (metadataHash(JSON.parse(manifestBytes)) !== metadataHash(manifest)) throw new Error("Publication manifest differs from reviewed metadata.");
  const sums = manifest.files.map(file => `${file.sha256}  ${file.name}`).join("\n") + "\n";
  const metadata = (name, bytes) => ({ name, size: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") });
  return [...manifest.files, metadata("SHA256SUMS.txt", sums), metadata("manifest.json", manifestBytes)];
}
