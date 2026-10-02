import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error("Set ANDROID_HOME to your Android SDK folder before building sync-core.");
const ndkDirectory = path.join(sdk, "ndk");
const versions = existsSync(ndkDirectory) ? readdirSync(ndkDirectory).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
const ndk = process.env.ANDROID_NDK_HOME || (versions[0] && path.join(ndkDirectory, versions[0]));
if (!ndk) throw new Error("Install an Android NDK with sdkmanager, or set ANDROID_NDK_HOME.");
const host = { win32: "windows-x86_64", linux: "linux-x86_64", darwin: "darwin-x86_64" }[process.platform];
if (!host) throw new Error(`Unsupported build host: ${process.platform}`);
const bin = path.join(ndk, "toolchains", "llvm", "prebuilt", host, "bin");
const cargo = process.env.CARGO || (process.platform === "win32" ? path.join(os.homedir(), ".cargo", "bin", "cargo.exe") : "cargo");
const release = process.argv.includes("--release");
const requested = process.env.SYNC_ANDROID_ABIS?.split(",").map(value => value.trim());
const targets = [
  ["arm64-v8a", "aarch64-linux-android", "aarch64-linux-android24"],
  ["armeabi-v7a", "armv7-linux-androideabi", "armv7a-linux-androideabi24"],
  ["x86", "i686-linux-android", "i686-linux-android24"],
  ["x86_64", "x86_64-linux-android", "x86_64-linux-android24"],
];
if (requested?.some(abi => !targets.some(([known]) => known === abi))) throw new Error("Unknown SYNC_ANDROID_ABIS target.");
for (const [abi, target, clang] of targets) {
  if (requested && !requested.includes(abi)) continue;
  const linker = path.join(bin, clang + "-clang" + (process.platform === "win32" ? ".cmd" : ""));
  if (!existsSync(linker)) throw new Error(`Missing NDK compiler: ${linker}`);
  const targetKey = target.replaceAll("-", "_");
  const env = { ...process.env, [`CARGO_TARGET_${targetKey.toUpperCase()}_LINKER`]: linker,
    [`CC_${targetKey}`]: linker, [`AR_${targetKey}`]: path.join(bin, "llvm-ar" + (process.platform === "win32" ? ".exe" : "")) };
  const args = ["build", "-p", "museamo-sync-core", "--features", "android", "--target", target, ...(release ? ["--release"] : [])];
  const result = spawnSync(cargo, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const destination = path.join(root, "android", "app", "src", "main", "jniLibs", abi);
  mkdirSync(destination, { recursive: true });
  copyFileSync(path.join(root, "target", target, release ? "release" : "debug", "libmuseamo_sync_core.so"), path.join(destination, "libmuseamo_sync_core.so"));
  process.stdout.write(`Packaged sync-core for ${abi}\n`);
}
