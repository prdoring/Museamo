import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const ANDROID_NDK_VERSION = "30.0.14904198";
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libraryName = "libmuseamo_sync_core.so";
const targets = [
  ["arm64-v8a", "aarch64-linux-android", "aarch64-linux-android24"],
  ["armeabi-v7a", "armv7-linux-androideabi", "armv7a-linux-androideabi24"],
  ["x86", "i686-linux-android", "i686-linux-android24"],
  ["x86_64", "x86_64-linux-android", "x86_64-linux-android24"],
];

export function buildSyncCore({ root = rootDirectory, env = process.env, platform = process.platform, arch = process.arch, argv = process.argv.slice(2), spawn = spawnSync } = {}) {
  // The macOS NDK uses this directory name on both Intel and Apple Silicon.
  const hosts = { "win32/x64": "windows-x86_64", "linux/x64": "linux-x86_64", "darwin/x64": "darwin-x86_64", "darwin/arm64": "darwin-x86_64" };
  const host = hosts[`${platform}/${arch}`];
  if (!host) throw new Error(`Unsupported Android build host: ${platform}/${arch}. Use Windows x64, Linux x64, or macOS x64/arm64.`);
  if (argv.some(argument => argument !== "--release")) throw new Error("Only --release is supported by the Android sync-core builder.");
  const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
  if (!sdk && !env.ANDROID_NDK_HOME) throw new Error("Set ANDROID_HOME to your Android SDK folder before building sync-core.");
  const ndk = path.resolve(root, env.ANDROID_NDK_HOME || path.join(sdk, "ndk", ANDROID_NDK_VERSION));
  const bin = path.join(ndk, "toolchains", "llvm", "prebuilt", host, "bin");
  if (!existsSync(bin)) throw new Error(`Missing Android NDK toolchain: ${bin}. Install NDK ${ANDROID_NDK_VERSION} with sdkmanager, or set ANDROID_NDK_HOME.`);
  const cargo = env.CARGO || (platform === "win32" ? path.join(os.homedir(), ".cargo", "bin", "cargo.exe") : "cargo");
  const release = argv.includes("--release");
  const requested = env.SYNC_ANDROID_ABIS?.split(",").map(value => value.trim());
  if (requested?.some(abi => !targets.some(([known]) => known === abi))) throw new Error("Unknown SYNC_ANDROID_ABIS target. Select arm64-v8a, armeabi-v7a, x86, or x86_64.");
  const selected = targets.filter(([abi]) => !requested || requested.includes(abi));
  const targetDirectory = path.resolve(root, env.CARGO_TARGET_DIR || "target");
  const ar = path.join(bin, "llvm-ar" + (platform === "win32" ? ".exe" : ""));
  if (!existsSync(ar)) throw new Error(`Missing NDK archiver: ${ar}`);
  const builds = selected.map(([abi, target, clang]) => {
    const linker = path.join(bin, clang + "-clang" + (platform === "win32" ? ".cmd" : ""));
    if (!existsSync(linker)) throw new Error(`Missing NDK compiler: ${linker}`);
    const targetKey = target.replaceAll("-", "_");
    const cargoEnv = { ...env, CARGO_TARGET_DIR: targetDirectory,
      [`CARGO_TARGET_${targetKey.toUpperCase()}_LINKER`]: linker, [`CC_${targetKey}`]: linker, [`AR_${targetKey}`]: ar };
    // This build chooses every Rust target explicitly, regardless of desktop shell defaults.
    delete cargoEnv.CARGO_BUILD_TARGET;
    return { abi, target, cargoEnv };
  });
  const jniDirectory = path.join(root, "android", "app", "src", "main", "jniLibs");
  // Remove only our generated library. A failed build must not leave earlier ABI outputs available for packaging.
  for (const [abi] of targets) rmSync(path.join(jniDirectory, abi, libraryName), { force: true });
  const staging = mkdtempSync(path.join(os.tmpdir(), "museamo-sync-core-"));
  try {
    for (const { abi, target, cargoEnv } of builds) {
      const args = ["build", "--locked", "-p", "museamo-sync-core", "--features", "android", "--target", target, "--target-dir", targetDirectory, ...(release ? ["--release"] : [])];
      const result = spawn(cargo, args, { cwd: root, env: cargoEnv, stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const error = new Error(`Android sync-core build failed for ${abi}${result.signal ? ` (${result.signal})` : ""}.`);
        error.exitCode = result.status || 1;
        throw error;
      }
      copyFileSync(path.join(targetDirectory, target, release ? "release" : "debug", libraryName), path.join(staging, abi + ".so"));
    }
    for (const { abi } of builds) {
      const destination = path.join(jniDirectory, abi);
      mkdirSync(destination, { recursive: true });
      copyFileSync(path.join(staging, abi + ".so"), path.join(destination, libraryName));
      process.stdout.write(`Packaged sync-core for ${abi}\n`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildSyncCore(); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode || 1;
  }
}
