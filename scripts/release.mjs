import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, copyFile, readdir, stat, access, mkdtemp, rename } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { configureSigning, signingCommand } from "./release-signing.mjs";
import { platforms, targets, kinds, artifactName, sha256, metadataHash, assertPlatformManifest, verifyFiles, verifyBundle, verificationChecks, assertVerification, publicationFiles } from "./release-artifacts.mjs";
export { assetNames, sha256, verifyBundle } from "./release-artifacts.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function options(argv) {
  const [command = "check", ...args] = argv;
  if (!["check", "build", "assemble", "verify", "publish", "setup", "signing", "signing-backup"].includes(command)) throw new Error("Use check, build, assemble, verify, publish, setup, signing, or signing-backup. The combined push command was removed; publication is explicit.");
  const result = { command, android: "release", allowDirty: false, prerelease: false, manifests: [], platforms: [...platforms] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (["--android", "--platform", "--platforms", "--manifest", "--directory"].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
      if (flag === "--android") result.android = value;
      else if (flag === "--platform") result.platform = value;
      else if (flag === "--platforms") result.platforms = value.split(",");
      else if (flag === "--manifest") result.manifests.push(path.resolve(value));
      else result.directory = path.resolve(value);
    } else if (flag === "--ci") result.ci = true;
    else if (flag === "--allow-dirty") result.allowDirty = true;
    else if (flag === "--prerelease") result.prerelease = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!["debug", "release"].includes(result.android)) throw new Error("--android must be debug or release.");
  if (result.platform && !platforms.includes(result.platform)) throw new Error("--platform must be android, windows, macos, or linux.");
  if (!result.platforms.length || new Set(result.platforms).size !== result.platforms.length || result.platforms.some(platform => !platforms.includes(platform))) throw new Error("Invalid or duplicate --platforms selection.");
  if (result.allowDirty && command !== "build") throw new Error("--allow-dirty is only available for local build previews.");
  if (result.ci && command !== "publish") throw new Error("--ci is only available for publication.");
  if (command === "build") result.platform ||= "windows";
  if (result.platform && !["build", "verify"].includes(command)) throw new Error("--platform is only available for build or verify.");
  if (result.manifests.length && command !== "assemble") throw new Error("--manifest is only available for assemble.");
  if (args.includes("--platforms") && command !== "assemble") throw new Error("--platforms is only available for assemble.");
  if (args.includes("--android") && (command !== "build" || result.platform !== "android")) throw new Error("--android is only available for Android builds. Assembly reads signing mode from manifests.");
  result.prerelease ||= command === "build" && result.platform === "android" && result.android === "debug";
  return result;
}
function run(command, args, settings = {}) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: "inherit", ...settings });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (exit ${result.status}).`);
  return result.stdout?.trim() || "";
}
function git(...args) { return run("git", args, { stdio: "pipe" }); }
async function json(file) { return JSON.parse(await readFile(path.join(root, file), "utf8")); }
function npm(...args) {
  if (!process.env.npm_execpath) throw new Error("Run release commands through npm run release:<command>.");
  return run(process.execPath, [process.env.npm_execpath, ...args]);
}
function gradle(args) {
  const directory = path.join(root, "android");
  return process.platform === "win32"
    ? run("cmd.exe", ["/d", "/c", "gradlew.bat", "--no-daemon", ...args], { cwd: directory })
    : run(path.join(directory, "gradlew"), ["--no-daemon", ...args], { cwd: directory });
}
export function assertVersions(versions) {
  const version = versions["package.json"];
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Use a numeric major.minor.patch version.");
  for (const [file, value] of Object.entries(versions)) {
    if (value !== version) throw new Error(`Version mismatch: ${file} is ${value}; expected ${version}.`);
  }
  return version;
}

async function versionInfo() {
  const pkg = await json("package.json"), lock = await json("package-lock.json"), tauri = await json("desktop/tauri.conf.json");
  const gradle = await readFile(path.join(root, "android/app/build.gradle"), "utf8");
  const cargo = await readFile(path.join(root, "Cargo.toml"), "utf8");
  const cargoLock = await readFile(path.join(root, "Cargo.lock"), "utf8");
  const version = assertVersions({ "package.json": pkg.version, "package-lock.json": lock.version,
    "package-lock.json root": lock.packages[""].version, "desktop/tauri.conf.json": tauri.version,
    "android/app/build.gradle": gradle.match(/versionName\s+"([^"]+)"/)?.[1],
    "Cargo.toml": cargo.match(/\[workspace.package\][\s\S]*?version\s*=\s*"([^"]+)"/)?.[1],
    "Cargo.lock desktop": cargoLock.match(/name = "museamo-desktop"\s+version = "([^"]+)"/)?.[1],
    "Cargo.lock core": cargoLock.match(/name = "museamo-sync-core"\s+version = "([^"]+)"/)?.[1] });
  const versionCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) throw new Error("Android versionCode must be a positive integer.");
  return { version, versionCode };
}

async function sourceState(allowDirty = false) {
  const dirty = !!git("status", "--porcelain", "--untracked-files=all");
  if (dirty && !allowDirty) throw new Error("Commit your source and documentation before releasing. Local build previews can use --allow-dirty.");
  const branch = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
  return { commit: git("rev-parse", "HEAD"), branch: branch.status === 0 ? branch.stdout.trim() : null, dirty };
}
export function assertBuildHost(platform, host = process.platform, arch = process.arch) {
  const expected = { windows: ["win32", "x64"], macos: ["darwin", "arm64"], linux: ["linux", "x64"] }[platform];
  if (expected && (host !== expected[0] || arch !== expected[1])) throw new Error(`Build ${platform} on ${expected.join(" ")}.`);
  if (platform === "android" && !((host === "win32" && arch === "x64") || (host === "darwin" && ["arm64", "x64"].includes(arch)) || (host === "linux" && arch === "x64"))) throw new Error("Unsupported Android build host.");
}
async function oneFile(directory, extension) {
  const files = (await readdir(directory)).filter(name => name.endsWith(extension));
  if (files.length !== 1) throw new Error(`Expected exactly one ${extension} artifact in ${directory}; remove stale build outputs before rebuilding.`);
  return path.join(directory, files[0]);
}
async function fileMetadata(file, name, kind, target, info, source) {
  return { version: info.version, commit: source.commit, cleanSource: !source.dirty, target, kind, name, size: (await stat(file)).size, sha256: await sha256(file) };
}
async function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, file);
}
async function androidArtifacts(opts) {
  if (!process.env.ANDROID_HOME || !process.env.JAVA_HOME) throw new Error("Set ANDROID_HOME and JAVA_HOME (JDK 21).");
  if (opts.android === "release") await configureSigning();
  process.env.SYNC_ANDROID_ABIS = "arm64-v8a,armeabi-v7a,x86,x86_64";
  npm("run", "android:sync");
  gradle([":app:clean", `:app:assemble${opts.android === "debug" ? "Debug" : "Release"}`, "-PsyncCoreRelease"]);
  const apk = path.join(root, "android/app/build/outputs/apk", opts.android, `app-${opts.android}.apk`);
  const tools = path.join(process.env.ANDROID_HOME, "build-tools", "36.0.0");
  const args = ["verify", "--print-certs", apk];
  const certificateOutput = process.platform === "win32"
    ? run("cmd.exe", ["/d", "/c", "apksigner.bat", ...args], { cwd: tools, stdio: "pipe" })
    : run(path.join(tools, "apksigner"), args, { stdio: "pipe" });
  const certificates = [...certificateOutput.matchAll(/Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})/g)];
  if (certificates.length !== 1) throw new Error("Expected exactly one Android signing certificate.");
  const signingCertificate = certificates[0][1].toLowerCase();
  if (process.env.MUSEAMO_ANDROID_CERT_SHA256 && process.env.MUSEAMO_ANDROID_CERT_SHA256.toLowerCase() !== signingCertificate) throw new Error("Android signing certificate changed. Restore the original signing identity.");
  const contents = run(path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "jar.exe" : "jar"), ["tf", apk], { stdio: "pipe" }).split(/\r?\n/);
  for (const abi of process.env.SYNC_ANDROID_ABIS.split(",")) if (!contents.includes(`lib/${abi}/libmuseamo_sync_core.so`)) throw new Error(`APK is missing sync-core for ${abi}.`);
  return { artifacts: [apk], signingCertificate };
}
function macosDistribution(app, dmg) {
  const check = (command, args) => spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  const identity = check("codesign", ["--display", "--verbose=4", app]);
  const signedApp = check("codesign", ["--verify", "--deep", "--strict", app]);
  const signedDmg = check("codesign", ["--verify", "--strict", dmg]);
  const notarizedApp = check("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
  const notarizedDmg = check("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmg]);
  const distributionReady = identity.status === 0 && /Authority=Developer ID Application:/.test(identity.stderr)
    && signedApp.status === 0 && signedDmg.status === 0
    && notarizedApp.status === 0 && /source=Notarized Developer ID/.test(notarizedApp.stderr)
    && notarizedDmg.status === 0 && /source=Notarized Developer ID/.test(notarizedDmg.stderr);
  return distributionReady ? "developer-id-notarized" : "preview";
}
async function build(opts, info, source) {
  assertBuildHost(opts.platform);
  process.env.CARGO_TARGET_DIR = path.join(root, "target");
  delete process.env.CARGO_BUILD_TARGET;
  const directory = opts.directory || path.join(root, "releases", info.version, opts.platform);
  await mkdir(directory, { recursive: true });
  // Invalidate success before any build step. A failed rebuild cannot reuse stale metadata.
  await writeFile(path.join(directory, "manifest.json"), "{}\n");
  npm("ci");
  let artifacts, signingCertificate, distribution;
  const target = targets[opts.platform];
  // Enforce the declared glibc/browser baseline before collecting distributable Linux packages.
  if (opts.platform === "linux") npm("run", "desktop:doctor", "--", "--target", target, "--release");
  if (opts.platform === "android") ({ artifacts, signingCertificate } = await androidArtifacts(opts));
  else {
    npm("run", "desktop:build", "--", "--target", target, "--", "--locked");
    const output = path.join(root, "target", target, "release");
    const bundle = path.join(output, "bundle");
    if (opts.platform === "windows") artifacts = [path.join(bundle, "nsis", `Museamo_${info.version}_x64-setup.exe`), path.join(output, "museamo-desktop.exe")];
    else if (opts.platform === "macos") {
      const archive = path.join(directory, artifactName(info.version, "macos", "app-tar"));
      // tar retains app symlinks, modes and bundle structure needed after extraction.
      run("tar", ["-czf", archive, "-C", path.join(bundle, "macos"), "Museamo.app"]);
      artifacts = [archive, await oneFile(path.join(bundle, "dmg"), ".dmg")];
      distribution = macosDistribution(path.join(bundle, "macos", "Museamo.app"), artifacts[1]);
      opts.prerelease ||= distribution === "preview";
    } else artifacts = [await oneFile(path.join(bundle, "deb"), ".deb"), await oneFile(path.join(bundle, "appimage"), ".AppImage")];
  }
  const after = await sourceState(opts.allowDirty);
  if (after.commit !== source.commit || (!source.dirty && after.dirty)) throw new Error("Source changed during the build. Commit the changes and rebuild.");
  const files = [];
  for (let i = 0; i < artifacts.length; i++) {
    const kind = kinds[opts.platform][i], name = artifactName(info.version, opts.platform, kind, opts.android);
    const destination = path.join(directory, name);
    if (path.resolve(artifacts[i]) !== destination) await copyFile(artifacts[i], destination);
    files.push(await fileMetadata(destination, name, kind, target, info, source));
  }
  const manifest = { schema: 2, ...info, commit: source.commit, cleanSource: !source.dirty, platform: opts.platform, target, prerelease: opts.prerelease, ...(opts.platform === "android" ? { android: opts.android, signingCertificate } : {}), ...(opts.platform === "macos" ? { macosDistribution: distribution } : {}), builtAt: new Date().toISOString(), files };
  assertPlatformManifest(manifest, { ...info, ...source }, { allowDirty: opts.allowDirty });
  await verifyFiles(directory, files);
  await writeJson(path.join(directory, "manifest.json"), manifest);
  console.log(`Local ${opts.platform} build ready: ${directory}. Build commands never push or publish.`);
}
async function assemble(opts, info, source) {
  const locations = opts.manifests.length ? opts.manifests : opts.platforms.map(platform => path.join(root, "releases", info.version, platform, "manifest.json"));
  const builds = [], verification = {};
  const seen = new Set();
  for (const location of locations) {
    const manifest = JSON.parse(await readFile(location, "utf8"));
    assertPlatformManifest(manifest, { ...info, ...source });
    if (!opts.platforms.includes(manifest.platform) || seen.has(manifest.platform)) throw new Error("Duplicate or unexpected build manifest.");
    seen.add(manifest.platform);
    await verifyFiles(path.dirname(location), manifest.files);
    builds.push(manifest);
    const receiptFile = path.join(path.dirname(location), "verification.json");
    try { verification[manifest.platform] = JSON.parse(await readFile(receiptFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (verification[manifest.platform]) assertVerification(verification[manifest.platform], manifest);
  }
  if (seen.size !== opts.platforms.length) throw new Error("Release bundle is incomplete for the selected platforms.");
  const parent = path.join(root, "releases", info.version);
  await mkdir(parent, { recursive: true });
  const directory = opts.directory || await mkdtemp(path.join(parent, "assembly-"));
  await mkdir(directory, { recursive: true });
  if ((await readdir(directory)).length) throw new Error("Assembly directory must be empty. Use a fresh directory.");
  const files = [];
  for (let i = 0; i < builds.length; i++) for (const file of builds[i].files) {
    await copyFile(path.join(path.dirname(locations[i]), file.name), path.join(directory, file.name));
    files.push(file);
  }
  const sourceName = `Museamo-${info.version}-source.zip`;
  git("archive", "--format=zip", `--prefix=Museamo-${info.version}/`, `--output=${path.join(directory, sourceName)}`, source.commit);
  files.push(await fileMetadata(path.join(directory, sourceName), sourceName, "source", "source", info, source));
  const handwritten = await readFile(path.join(root, "docs/release-notes", `${info.version}.md`), "utf8");
  const prerelease = opts.prerelease || builds.some(build => build.prerelease);
  const notes = `${handwritten.trim()}\n\n## Downloads\n\n${builds.flatMap(build => build.files.map(file => `- ${file.name} (${build.target}, ${file.kind})`)).join("\n")}\n- ${sourceName}: corresponding committed source.\n- SHA256SUMS.txt: checksums for downloads and notes.\n\n${builds.some(build => build.android === "debug") ? "Android APK is debug signed and requires the same debug key for updates. This release is a prerelease.\n\n" : ""}${builds.some(build => build.macosDistribution === "preview") ? "macOS artifacts are unsigned or unnotarized local previews. This release is a prerelease.\n\n" : ""}Back up through Settings > Backup > Export before updating. Keep your Android installation if an update is refused. macOS requires macOS 14+ on Apple Silicon; Linux requires Ubuntu 22.04+ x64 or an equivalent tested environment. See docs/releases.md for signing and native acceptance checks.\n\nBuilt from clean commit ${source.commit}.\n`;
  await writeFile(path.join(directory, "release-notes.md"), notes);
  files.push(await fileMetadata(path.join(directory, "release-notes.md"), "release-notes.md", "notes", "source", info, source));
  await writeFile(path.join(directory, "SHA256SUMS.txt"), files.map(file => `${file.sha256}  ${file.name}`).join("\n") + "\n");
  const manifest = { schema: 2, ...info, commit: source.commit, cleanSource: true, platforms: opts.platforms, prerelease, builds, verification, files };
  await verifyBundle(directory, manifest, { ...info, ...source });
  await writeJson(path.join(directory, "manifest.json"), manifest);
  console.log(`Assembly ready: ${directory}. Publication requires successful verification for every selected platform.`);
}
async function verify(opts, info, source) {
  if (!opts.platform) {
    if (!opts.directory) throw new Error("Specify --directory for an assembled bundle, or --platform to run build-host checks.");
    await verifyBundle(opts.directory, JSON.parse(await readFile(path.join(opts.directory, "manifest.json"), "utf8")), { ...info, ...source }, { requireVerification: true });
    console.log("Assembly integrity and build-host verification receipts passed.");
    return;
  }
  assertBuildHost(opts.platform);
  const directory = opts.directory || path.join(root, "releases", info.version, opts.platform);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  assertPlatformManifest(manifest, { ...info, ...source });
  if (manifest.platform !== opts.platform) throw new Error("Verification platform differs from build manifest.");
  await verifyFiles(directory, manifest.files);
  // Publication retains the original automated checks. Only this explicit command runs tests.
  npm("run", "test:release");
  npm("test");
  const rustScope = opts.platform === "android" ? ["-p", "museamo-sync-core"] : ["--workspace"];
  run("cargo", ["test", ...rustScope, "--locked", "--", "--test-threads=1"]);
  if (opts.platform === "android") {
    run(process.execPath, ["--test", "scripts/build-sync-android.test.mjs"]);
    gradle([":app:testDebugUnitTest", ":app:lintDebug", "-PsyncCoreRelease"]);
  }
  const after = await sourceState();
  if (after.commit !== source.commit) throw new Error("Source changed during verification.");
  await verifyFiles(directory, manifest.files);
  if (metadataHash(JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"))) !== metadataHash(manifest)) throw new Error("Build manifest changed during verification.");
  await writeJson(path.join(directory, "verification.json"), { schema: 1, commit: source.commit, version: info.version, platform: opts.platform, manifestSha256: metadataHash(manifest), checks: verificationChecks(opts.platform), verifiedAt: new Date().toISOString() });
  console.log(`Verification passed for ${opts.platform}. Reassemble to include this receipt.`);
}
export async function publish(opts, info, source, dependencies = {}) {
  const execute = dependencies.run || run;
  const gitCommand = dependencies.git || git;
  const currentSource = dependencies.sourceState || sourceState;
  if (opts.ci && process.env.GITHUB_ACTIONS !== "true") throw new Error("CI publication requires GitHub Actions.");
  if (!opts.ci && !source.branch) throw new Error("Local publication requires a branch. Use --ci only in GitHub Actions.");
  if (!opts.directory) throw new Error("Publication requires an explicit --directory for the reviewed assembly.");
  const directory = opts.directory;
  const manifestBytes = await readFile(path.join(directory, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestBytes);
  await verifyBundle(directory, manifest, { ...info, ...source }, { requireVerification: true });
  const expectedUploads = publicationFiles(manifest, manifestBytes);
  const snapshotParent = dependencies.snapshotParent || path.join(root, "releases", info.version);
  await mkdir(snapshotParent, { recursive: true });
  const snapshot = await mkdtemp(path.join(snapshotParent, "publication-"));
  for (const file of expectedUploads) await copyFile(path.join(directory, file.name), path.join(snapshot, file.name));
  await verifyFiles(snapshot, expectedUploads);
  const tag = `v${info.version}`;
  execute("gh", ["auth", "status"]);
  const repo = execute("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { stdio: "pipe" });
  // Query all releases successfully before mutating tags or remote branches. Network failures fail closed.
  const releases = JSON.parse(execute("gh", ["api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`], { stdio: "pipe" })).flat();
  const existingRelease = releases.find(release => release.tag_name === tag);
  if (existingRelease && !existingRelease.draft) throw new Error(`${tag} is already published. Use a new version instead of replacing downloads.`);
  let tagExists = false;
  try { gitCommand("rev-parse", "--verify", `refs/tags/${tag}`); tagExists = true; }
  catch (error) { if (opts.ci) throw new Error("CI publication requires an existing reserved tag.", { cause: error }); }
  if (opts.ci) {
    const remote = gitCommand("ls-remote", "origin", `refs/tags/${tag}^{}`);
    if (remote.split(/\s/)[0] !== source.commit) throw new Error("Reserved remote tag differs from this release commit.");
    const reservation = JSON.parse(gitCommand("for-each-ref", "--format=%(contents)", `refs/tags/${tag}`));
    if (reservation.schema !== 1 || reservation.version !== info.version || reservation.versionCode !== info.versionCode || reservation.sourceCommit !== gitCommand("rev-parse", "HEAD^")) throw new Error("Invalid CI release reservation.");
  }
  if (tagExists) {
    if (gitCommand("rev-list", "-n", "1", tag) !== source.commit) throw new Error(`${tag} points to another commit. Never replace release tags.`);
  } else gitCommand("tag", "-a", tag, "-m", `Museamo ${info.version}`, source.commit);
  // Recheck source and bytes immediately before the explicit network mutation.
  await verifyBundle(directory, manifest, { ...info, ...await currentSource() }, { requireVerification: true });
  if (!opts.ci) {
    process.env.MUSEAMO_RELEASE_PUSH = "1";
    gitCommand("push", "--atomic", "origin", `HEAD:refs/heads/${source.branch}`, `refs/tags/${tag}`);
  }
  if (!existingRelease) execute("gh", ["release", "create", tag, "--repo", repo, "--verify-tag", "--draft", "--title", `Museamo ${info.version}`, "--notes-file", path.join(snapshot, "release-notes.md"), ...(manifest.prerelease ? ["--prerelease"] : [])]);
  // Refresh draft status before uploads; published releases must never be clobbered on retry.
  const status = JSON.parse(execute("gh", ["release", "view", tag, "--repo", repo, "--json", "isDraft,assets"], { stdio: "pipe" }));
  if (!status.isDraft) throw new Error(`${tag} is already published. Use a new version.`);
  const expectedNames = new Set(expectedUploads.map(file => file.name));
  if (status.assets.some(asset => !expectedNames.has(asset.name))) throw new Error("Existing draft has unexpected assets. Review it before retrying publication.");
  for (const file of expectedUploads) {
    if (!status.assets.some(asset => asset.name === file.name)) {
      // No --clobber, even for drafts. A concurrent upload cannot replace an asset.
      execute("gh", ["release", "upload", tag, "--repo", repo, path.join(snapshot, file.name)]);
    }
    const downloaded = await mkdtemp(path.join(snapshot, "remote-check-"));
    execute("gh", ["release", "download", tag, "--repo", repo, "--pattern", file.name, "--dir", downloaded]);
    // Verify new uploads and draft retries against the captured expected hashes.
    // A failure leaves the draft unpublished and does not overwrite any download.
    await verifyFiles(downloaded, [file]);
  }
  const beforePublish = JSON.parse(execute("gh", ["release", "view", tag, "--repo", repo, "--json", "isDraft,assets"], { stdio: "pipe" }));
  if (!beforePublish.isDraft) throw new Error(`${tag} was already published by another process.`);
  if (beforePublish.assets.length !== expectedUploads.length || new Set(beforePublish.assets.map(asset => asset.name)).size !== expectedUploads.length || beforePublish.assets.some(asset => !expectedNames.has(asset.name))) throw new Error("Draft assets changed during publication. Review the draft before retrying.");
  await verifyBundle(directory, manifest, { ...info, ...await currentSource() }, { requireVerification: true });
  await verifyFiles(directory, expectedUploads);
  await verifyFiles(snapshot, expectedUploads);
  execute("gh", ["release", "edit", tag, "--repo", repo, "--draft=false", `--prerelease=${manifest.prerelease}`, `--latest=${!manifest.prerelease}`, "--notes-file", path.join(snapshot, "release-notes.md")]);
}
async function main() {
  const opts = options(process.argv.slice(2));
  if (["signing", "signing-backup"].includes(opts.command)) { signingCommand(opts.command === "signing" ? "setup" : "backup"); return; }
  if (opts.command === "setup") {
    const current = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" });
    if (current.status === 0 && current.stdout.trim() !== ".githooks") throw new Error("An existing hooksPath is configured. Merge the pre-push hook manually.");
    git("config", "core.hooksPath", ".githooks");
    console.log("Repository hooks installed. Normal pushes are allowed; main releases run in GitHub Actions.");
    return;
  }
  const info = await versionInfo(), source = await sourceState(opts.allowDirty);
  await access(path.join(root, "docs/release-notes", `${info.version}.md`));
  if (opts.command === "check") console.log(`Release source ready: v${info.version}, Android code ${info.versionCode}, ${source.commit}`);
  else if (opts.command === "build") await build(opts, info, source);
  else if (opts.command === "assemble") await assemble(opts, info, source);
  else if (opts.command === "verify") await verify(opts, info, source);
  else await publish(opts, info, source);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(`\nRelease stopped: ${error.message}`); process.exitCode = 1; });
