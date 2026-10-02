import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir, copyFile, readdir, stat, access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { configureSigning, signingCommand } from "./release-signing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = "x86_64-pc-windows-msvc";

export function options(argv) {
  const [command = "check", ...args] = argv;
  if (!["check", "build", "push", "publish", "setup", "signing", "signing-backup"].includes(command)) throw new Error("Use check, build, push, publish, setup, signing, or signing-backup.");
  const result = { command, android: "release", allowDirty: false, prerelease: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--android") result.android = args[++i];
    else if (args[i] === "--allow-dirty") result.allowDirty = true;
    else if (args[i] === "--prerelease") result.prerelease = true;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!["debug", "release"].includes(result.android)) throw new Error("--android must be debug or release.");
  if (result.allowDirty && command !== "build") throw new Error("--allow-dirty is only available for local build previews.");
  // A debug-signed APK is always labeled as a prerelease on GitHub.
  result.prerelease ||= result.android === "debug";
  return result;
}

function run(command, args, settings = {}) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: "utf8", stdio: "inherit", ...settings });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (exit ${result.status}).`);
  return result.stdout?.trim() || "";
}
function git(...args) { return run("git", args, { stdio: "pipe" }); }
async function json(file) { return JSON.parse(await readFile(path.join(root, file), "utf8")); }

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
  if (dirty && !allowDirty) throw new Error("Commit your source and documentation before releasing. Local previews can use release:build -- --allow-dirty.");
  const branch = git("symbolic-ref", "--short", "HEAD");
  return { commit: git("rev-parse", "HEAD"), branch, dirty };
}

export function assetNames(version, android) {
  return [
    `Museamo-${version}-android${android === "debug" ? "-debug" : ""}.apk`,
    `Museamo-${version}-windows-x64-setup.exe`,
    `Museamo-${version}-windows-x64.exe`,
    `Museamo-${version}-source.zip`,
  ];
}

export async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyBundle(directory, manifest, source) {
  if (manifest.schema !== 1 || !["debug", "release"].includes(manifest.android)) throw new Error("Invalid release manifest.");
  if (manifest.dirty || source.dirty || manifest.commit !== source.commit) throw new Error("Release files must come from the current clean commit. Rebuild before publishing.");
  if (manifest.version !== source.version) throw new Error("Release version no longer matches the source.");
  const expected = [...assetNames(source.version, manifest.android), "release-notes.md"];
  if (manifest.files?.length !== expected.length || expected.some(name => !manifest.files.some(file => file.name === name))) throw new Error("Release bundle is incomplete.");
  for (const file of manifest.files) {
    if (path.basename(file.name) !== file.name || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid release file metadata.");
    const location = path.join(directory, file.name);
    if ((await stat(location)).size !== file.size || await sha256(location) !== file.sha256) throw new Error(`Release file changed: ${file.name}. Rebuild before publishing.`);
  }
  const sums = manifest.files.map(file => `${file.sha256}  ${file.name}`).join("\n") + "\n";
  if (await readFile(path.join(directory, "SHA256SUMS.txt"), "utf8") !== sums) throw new Error("Checksum list changed. Rebuild before publishing.");
}

async function build(opts, info, source) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build releases locally on x64 Windows.");
  if (!process.env.ANDROID_HOME || !process.env.JAVA_HOME) throw new Error("Set ANDROID_HOME and JAVA_HOME (JDK 21). See docs/development.md.");
  if (opts.android === "release") await configureSigning();
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run this command through npm run release or npm run release:build.");
  const npm = (...args) => run(process.execPath, [npmCli, ...args]);
  // Keep every output in this checkout, including when the shell has Cargo overrides.
  process.env.CARGO_TARGET_DIR = path.join(root, "target");
  process.env.SYNC_ANDROID_ABIS = "arm64-v8a,armeabi-v7a,x86,x86_64";
  delete process.env.CARGO_BUILD_TARGET;
  npm("ci");
  npm("run", "test:release");
  npm("test");
  run("cargo", ["test", "--workspace", "--locked", "--", "--test-threads=1"]);
  npm("run", "android:sync");
  const variant = opts.android === "debug" ? "Debug" : "Release";
  // Use a fresh Gradle process so it shares this account's key access and does
  // not retain signing credentials in a reusable development daemon.
  run("cmd.exe", ["/d", "/c", "gradlew.bat", "--no-daemon", `:app:assemble${variant}`, ":app:testDebugUnitTest", ":app:lintDebug", "-PsyncCoreRelease"], { cwd: path.join(root, "android") });
  npm("run", "desktop:build", "--", "--target", target);
  const after = await sourceState(opts.allowDirty);
  if (after.commit !== source.commit || (!source.dirty && after.dirty)) throw new Error("Source changed during the build. Commit the changes and rebuild.");
  const directory = path.join(root, "releases", info.version);
  await mkdir(directory, { recursive: true });
  // Remove the old success marker before replacing any files. A failed rebuild cannot publish an old bundle.
  await writeFile(path.join(directory, "manifest.json"), "{}\n");
  const names = assetNames(info.version, opts.android);
  const apk = path.join(root, "android/app/build/outputs/apk", opts.android, `app-${opts.android}.apk`);
  const toolsDirectory = path.join(process.env.ANDROID_HOME, "build-tools");
  const toolVersion = (await readdir(toolsDirectory)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  run("cmd.exe", ["/d", "/c", "apksigner.bat", "verify", apk], { cwd: path.join(toolsDirectory, toolVersion) });
  const contents = run(path.join(process.env.JAVA_HOME, "bin/jar.exe"), ["tf", apk], { stdio: "pipe" });
  for (const abi of process.env.SYNC_ANDROID_ABIS.split(",")) {
    if (!contents.includes(`lib/${abi}/libmuseamo_sync_core.so`)) throw new Error(`APK is missing sync-core for ${abi}.`);
  }
  const bundles = path.join(root, "target", target, "release/bundle/nsis");
  const installer = `Museamo_${info.version}_x64-setup.exe`;
  if (!(await readdir(bundles)).includes(installer)) throw new Error(`Expected NSIS installer missing: ${installer}`);
  await copyFile(apk, path.join(directory, names[0]));
  await copyFile(path.join(bundles, installer), path.join(directory, names[1]));
  await copyFile(path.join(root, "target", target, "release/museamo-desktop.exe"), path.join(directory, names[2]));
  git("archive", "--format=zip", `--prefix=Museamo-${info.version}/`, `--output=${path.join(directory, names[3])}`, source.commit);
  const handwritten = await readFile(path.join(root, "docs/release-notes", `${info.version}.md`), "utf8");
  const notes = `${handwritten.trim()}\n\n## Downloads\n\n- **${names[0]}**: Android 7+ with WebView 105+. ${opts.android === "debug" ? "Debug signed; test prerelease. Updates require the same debug signing key." : "Signed release; updates require the same release signing key."}\n- **${names[1]}**: recommended Windows x64 installer, with WebView2 offline setup included.\n- **${names[2]}**: standalone Windows x64 executable; WebView2 must already be installed. Data is still saved in your Windows profile.\n- **${names[3]}**: corresponding source for this build.\n- **SHA256SUMS.txt**: checksums for these downloads and notes.\n\nBack up through **Settings → Backup → Export** before updating. Keep your existing Android installation if an update is refused.\n\nBuilt locally on Windows from commit \`${source.commit}\`.${source.dirty ? " Local preview with uncommitted changes; cannot be published. Source archive contains the committed version only." : ""}\n`;
  await writeFile(path.join(directory, "release-notes.md"), notes);
  const files = [];
  for (const name of [...names, "release-notes.md"]) {
    const file = path.join(directory, name);
    files.push({ name, size: (await stat(file)).size, sha256: await sha256(file) });
  }
  await writeFile(path.join(directory, "SHA256SUMS.txt"), files.map(file => `${file.sha256}  ${file.name}`).join("\n") + "\n");
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schema: 1, ...info, ...source, android: opts.android, prerelease: opts.prerelease, builtAt: new Date().toISOString(), files }, null, 2) + "\n");
  console.log(`\nLocal release files ready: ${directory}`);
}

async function publish(info, source) {
  const directory = path.join(root, "releases", info.version);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  await verifyBundle(directory, manifest, { ...source, version: info.version });
  if (manifest.android === "debug" && !manifest.prerelease) throw new Error("Debug APKs must be prereleases.");
  const tag = `v${info.version}`;
  const existing = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { cwd: root, encoding: "utf8" });
  if (existing.status === 0) {
    if (git("rev-list", "-n", "1", tag) !== source.commit) throw new Error(`${tag} points to another commit. Bump the version; never replace release tags.`);
  } else git("tag", "-a", tag, "-m", `Museamo ${info.version}`, source.commit);
  run("gh", ["auth", "status"]);
  // Use the configured origin, including forks, rather than a hardcoded repository.
  const repo = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { stdio: "pipe" });
  git("push", "--atomic", "origin", `HEAD:refs/heads/${source.branch}`, `refs/tags/${tag}`);
  const release = spawnSync("gh", ["release", "view", tag, "--repo", repo, "--json", "isDraft,targetCommitish"], { cwd: root, encoding: "utf8" });
  if (release.status === 0 && !JSON.parse(release.stdout).isDraft) throw new Error(`${tag} is already published. Use a new version instead of replacing downloads.`);
  if (release.status !== 0) run("gh", ["release", "create", tag, "--repo", repo, "--verify-tag", "--draft", "--title", `Museamo ${info.version}`, "--notes-file", path.join(directory, "release-notes.md"), ...(manifest.prerelease ? ["--prerelease"] : [])]);
  run("gh", ["release", "upload", tag, "--repo", repo, "--clobber", ...manifest.files.map(file => path.join(directory, file.name)), path.join(directory, "SHA256SUMS.txt"), path.join(directory, "manifest.json")]);
  // Publish only after every asset upload succeeds. Failed uploads leave a recoverable draft.
  run("gh", ["release", "edit", tag, "--repo", repo, "--draft=false", `--prerelease=${manifest.prerelease}`, `--latest=${!manifest.prerelease}`, "--notes-file", path.join(directory, "release-notes.md")]);
  run("gh", ["release", "view", tag, "--repo", repo]);
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (opts.command === "signing" || opts.command === "signing-backup") {
    signingCommand(opts.command === "signing" ? "setup" : "backup");
    return;
  }
  if (opts.command === "setup") {
    const current = spawnSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8" });
    if (current.status === 0 && current.stdout.trim() !== ".githooks") throw new Error("An existing hooksPath is configured. Merge the Museamo pre-push hook into it manually; it will not be overwritten.");
    git("config", "core.hooksPath", ".githooks");
    console.log("Local push guard installed. Use npm run release for pushes with downloads.");
    return;
  }
  const info = await versionInfo();
  const source = await sourceState(opts.allowDirty);
  await access(path.join(root, "docs/release-notes", `${info.version}.md`));
  if (opts.command === "check") { console.log(`Release source ready: v${info.version}, Android code ${info.versionCode}, ${source.commit}`); return; }
  if (["build", "push"].includes(opts.command)) await build(opts, info, source);
  if (["publish", "push"].includes(opts.command)) {
    process.env.MUSEAMO_RELEASE_PUSH = "1";
    await publish(info, await sourceState());
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`\nRelease stopped: ${error.message}`); process.exitCode = 1; });
}
