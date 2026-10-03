import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = {
  "aarch64-apple-darwin": { platform: "darwin", arch: "arm64", config: "macos", baseline: "macOS 14 or later" },
  "x86_64-unknown-linux-gnu": { platform: "linux", arch: "x64", config: "linux", baseline: "Ubuntu 22.04 x64 with security updates" },
  "x86_64-pc-windows-msvc": { platform: "win32", arch: "x64", config: "windows", baseline: "Windows 10 or later with WebView2 111 or later" },
};
const args = process.argv.slice(2);
const usage = "Usage: npm run desktop:doctor -- [--target <Rust target>] [--release]\nTargets: " + Object.keys(targets).join(", ") + "\n--release requires Ubuntu 22.04 for Linux package builds.";
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage);
  process.exit(0);
}
let target = Object.keys(targets).find(key => targets[key].platform === process.platform && targets[key].arch === process.arch);
let release = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--release") release = true;
  else if (args[index] === "--target") target = args[++index];
  else {
    console.error(`Unknown argument: ${args[index]}\n${usage}`);
    process.exit(1);
  }
}
if (!Object.hasOwn(targets, target)) {
  console.error(`Unsupported desktop target: ${target ?? `${process.platform}/${process.arch}`}\n${usage}`);
  process.exit(1);
}
const selected = targets[target];
let failures = 0;
function report(ok, description, fix = "") {
  console.log(`${ok ? "OK" : "FAIL"} ${description}${!ok && fix ? `\n  ${fix}` : ""}`);
  if (!ok) failures++;
  return ok;
}
function warning(message) { console.log(`WARN ${message}`); }
function run(command, commandArgs = []) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", timeout: 15_000, windowsHide: true });
  return { ok: !result.error && result.status === 0, output: (result.stdout ?? "").trim() };
}
function command(name, commandArgs = ["--version"], fix = `Install ${name} and add it to PATH.`) {
  const result = run(name, commandArgs);
  report(result.ok, `${name}${result.ok && result.output ? `: ${result.output.split("\n")[0]}` : " available"}`, fix);
  return result;
}
function atLeast(actual, minimum) {
  const parts = actual.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(parts.length, required.length); index++) {
    const difference = (parts[index] ?? 0) - (required[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

console.log(`Desktop prerequisites for ${target}\nBaseline: ${selected.baseline}`);
report(atLeast(process.versions.node, "22"), `Node.js ${process.versions.node}`, "Install Node.js 22 or later.");
report(existsSync(path.join(root, "node_modules/@tauri-apps/cli/tauri.js")), "Local Tauri CLI", "Run npm ci.");
const base = JSON.parse(readFileSync(path.join(root, "desktop/tauri.conf.json"), "utf8"));
const override = JSON.parse(readFileSync(path.join(root, `desktop/tauri.${selected.config}.conf.json`), "utf8"));
for (const icon of override.bundle.icon ?? base.bundle.icon) {
  report(existsSync(path.join(root, "desktop", icon)), `Bundle icon ${icon}`, "Run node scripts/generate-branding.mjs --platform-icons.");
}

if (!report(process.platform === selected.platform && process.arch === selected.arch, `Native build host ${process.platform}/${process.arch}`, `Use a ${selected.platform}/${selected.arch} host. Desktop package cross-compilation is not supported.`)) {
  process.exitCode = 1;
} else {
  const pin = readFileSync(path.join(root, "rust-toolchain.toml"), "utf8").match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
  const rustup = run("rustup", ["toolchain", "list"]);
  // Listing installed toolchains does not download the missing project toolchain.
  const installed = rustup.ok && rustup.output.split("\n").some(line => line.startsWith(`${pin}-`));
  if (report(installed, `Rust ${pin} toolchain installed`, `Install rustup, then run rustup toolchain install ${pin} --profile minimal --component rustfmt --component clippy.`)) {
    const rust = command("rustup", ["run", pin, "rustc", "--version", "--verbose"]);
    const version = rust.output.match(/^rustc ([\d.]+)/)?.[1];
    report(version === pin, `Compiler matches Rust ${pin}`, "Remove RUSTUP_TOOLCHAIN overrides and use the committed rust-toolchain.toml.");
    command("rustup", ["run", pin, "cargo", "--version"]);
    const installedTargets = run("rustup", ["target", "list", "--installed", "--toolchain", pin]);
    report(installedTargets.ok && installedTargets.output.split("\n").includes(target), `Rust target ${target}`, `Run rustup target add --toolchain ${pin} ${target}.`);
  }

  if (selected.platform === "darwin") {
    const version = command("sw_vers", ["-productVersion"]);
    report(version.ok && atLeast(version.output, "14.0"), "macOS 14 or later", "Use macOS 14 or later.");
    command("xcode-select", ["-p"], "Install Xcode Command Line Tools with xcode-select --install.");
    command("xcrun", ["--find", "clang"], "Complete Xcode setup or install Xcode Command Line Tools.");
    command("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
    command("hdiutil", ["help"]);
    report(existsSync("/usr/bin/codesign"), "codesign available", "Install Xcode Command Line Tools.");
    command("plutil", ["-lint", path.join(root, "desktop/Info.plist")]);
    warning("Local app/DMG compilation needs no Apple credentials. Distribution signing and notarization require separate verification.");
  } else if (selected.platform === "linux") {
    const os = existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8") : "";
    const baseline = /^ID=["']?ubuntu["']?$/m.test(os) && /^VERSION_ID=["']?22\.04["']?$/m.test(os);
    if (release) report(baseline, "Ubuntu 22.04 package build baseline", "Build release packages on an updated Ubuntu 22.04 x64 host to preserve the glibc baseline.");
    else if (!baseline) warning("Use Ubuntu 22.04 for distributable packages. A newer host can increase the required glibc version.");
    for (const name of ["cc", "make", "pkg-config", "dpkg-deb", "patchelf", "wget", "curl", "file"]) command(name);
    for (const [name, minimum] of [["webkit2gtk-4.1", "2.44"], ["gtk+-3.0", "3.24"], ["ayatana-appindicator3-0.1", "0"], ["openssl", "1.1"], ["dbus-1", "1.12"], ["gstreamer-1.0", "1.20"]]) {
      const result = run("pkg-config", ["--modversion", name]);
      report(result.ok && atLeast(result.output, minimum), `${name} >= ${minimum}${result.ok ? ` (${result.output})` : ""}`, "Install the Linux development packages listed in docs/desktop-packaging.md and apply security updates.");
    }
    for (const element of ["playbin", "decodebin", "avdec_h264", "opusdec", "vorbisdec"]) {
      const result = run("gst-inspect-1.0", [element]);
      report(result.ok, `GStreamer ${element}`, "Install gstreamer1.0-tools, plugins-base, plugins-good, plugins-bad and libav.");
    }
    warning("Native use also needs a graphical session, a portal backend, and an unlocked Secret Service provider. Validate these on the destination desktop.");
  } else {
    const programs = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const locator = path.join(programs, "Microsoft Visual Studio/Installer/vswhere.exe");
    const tools = run(locator, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"]);
    report(tools.ok && tools.output.length > 0, "Visual Studio C++ build tools", "Install Visual Studio Build Tools with Desktop development with C++ and a Windows SDK.");
    const runtime = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let version;
    for (const registry of [`HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\${runtime}`, `HKLM\\Software\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${runtime}`]) {
      const found = run("reg.exe", ["query", registry, "/v", "pv"]);
      version ??= found.output.match(/pv\s+REG_SZ\s+([\d.]+)/)?.[1];
    }
    report(Boolean(version && atLeast(version, "111.0.1661.41")), `WebView2 111 or later${version ? ` (${version})` : ""}`, "Install the current Microsoft Edge WebView2 Evergreen Runtime.");
  }
  process.exitCode = failures ? 1 : 0;
}
console.log(`\n${failures ? `${failures} prerequisite check(s) failed.` : "Desktop build prerequisites found."} No build, tests, installation, signing, or publishing performed.`);
