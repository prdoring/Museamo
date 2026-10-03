import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSyncCore, ANDROID_NDK_VERSION } from "./build-sync-android.mjs";

const libraryName = "libmuseamo_sync_core.so";
const abiTargets = {
  "arm64-v8a": "aarch64-linux-android",
  "armeabi-v7a": "armv7-linux-androideabi",
  x86: "i686-linux-android",
  x86_64: "x86_64-linux-android",
};
const compilers = ["aarch64-linux-android24", "armv7a-linux-androideabi24", "i686-linux-android24", "x86_64-linux-android24"];

function fixture({ platform = "linux", arch = "x64", override = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "museamo-android-builder-test-"));
  const sdk = path.join(root, "sdk");
  const ndk = override ? path.join(root, "custom-ndk") : path.join(sdk, "ndk", ANDROID_NDK_VERSION);
  const host = { linux: "linux-x86_64", darwin: "darwin-x86_64", win32: "windows-x86_64" }[platform];
  const bin = path.join(ndk, "toolchains", "llvm", "prebuilt", host, "bin");
  mkdirSync(bin, { recursive: true });
  const suffix = platform === "win32" ? ".cmd" : "";
  for (const clang of compilers) writeFileSync(path.join(bin, clang + "-clang" + suffix), "fixture compiler");
  writeFileSync(path.join(bin, "llvm-ar" + (platform === "win32" ? ".exe" : "")), "fixture archiver");
  const env = { ANDROID_HOME: sdk, CARGO: "fixture-cargo", ...(override ? { ANDROID_NDK_HOME: ndk } : {}) };
  const calls = [];
  const spawn = (cargo, args, options) => {
    calls.push({ cargo, args, ...options });
    const target = args[args.indexOf("--target") + 1];
    const output = path.join(args[args.indexOf("--target-dir") + 1], target, args.includes("--release") ? "release" : "debug");
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, libraryName), `new ${target}`);
    return { status: 0 };
  };
  const packaged = abi => path.join(root, "android", "app", "src", "main", "jniLibs", abi, libraryName);
  const oldLibraries = () => {
    for (const abi of Object.keys(abiTargets)) {
      mkdirSync(path.dirname(packaged(abi)), { recursive: true });
      writeFileSync(packaged(abi), "stale native library");
    }
  };
  return { root, sdk, bin, env, calls, spawn, packaged, oldLibraries, build: options => buildSyncCore({ root, env, platform, arch, argv: [], spawn, ...options }), dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function withFixture(options, callback) {
  const context = fixture(options);
  try { callback(context); }
  finally { context.dispose(); }
}

test("default build pins the NDK and packages all four locked Cargo targets", () => {
  withFixture({}, context => {
    mkdirSync(path.join(context.sdk, "ndk", "99.0.0"), { recursive: true });
    context.build();
    assert.equal(context.calls.length, 4);
    assert.deepEqual(context.calls.map(call => call.args[call.args.indexOf("--target") + 1]), Object.values(abiTargets));
    for (const [abi, target] of Object.entries(abiTargets)) assert.equal(readFileSync(context.packaged(abi), "utf8"), `new ${target}`);
    for (const call of context.calls) {
      assert.equal(call.cargo, "fixture-cargo");
      assert.ok(call.args.includes("--locked"));
      assert.ok(!call.args.includes("--release"));
      assert.equal(call.cwd, context.root);
      assert.ok(Object.values(call.env).some(value => value.includes(`${ANDROID_NDK_VERSION}`) && value.includes("clang")));
    }
  });
});

test("relative and absolute Cargo output overrides package the release output and clear the desktop target", () => {
  for (const absolute of [false, true]) withFixture({}, context => {
    const output = absolute ? path.join(context.root, "absolute output") : "relative output";
    const env = { ...context.env, CARGO_TARGET_DIR: output, CARGO_BUILD_TARGET: "aarch64-apple-darwin", SYNC_ANDROID_ABIS: "x86_64" };
    context.build({ env, argv: ["--release"] });
    const [call] = context.calls;
    assert.equal(call.env.CARGO_TARGET_DIR, path.resolve(context.root, output));
    assert.equal(call.args[call.args.indexOf("--target-dir") + 1], call.env.CARGO_TARGET_DIR);
    assert.equal(call.env.CARGO_BUILD_TARGET, undefined);
    assert.equal(env.CARGO_BUILD_TARGET, "aarch64-apple-darwin");
    assert.ok(call.args.includes("--release"));
    assert.equal(readFileSync(context.packaged("x86_64"), "utf8"), "new x86_64-linux-android");
  });
});

test("NDK override works without an SDK and SDK_ROOT works without ANDROID_HOME", () => {
  withFixture({ override: true }, context => {
    context.build({ env: { CARGO: "fixture-cargo", ANDROID_NDK_HOME: "custom-ndk", SYNC_ANDROID_ABIS: "x86" } });
    assert.ok(context.calls[0].env.CC_i686_linux_android.startsWith(context.bin));
  });
  withFixture({}, context => {
    context.build({ env: { CARGO: "fixture-cargo", ANDROID_SDK_ROOT: context.sdk, SYNC_ANDROID_ABIS: "x86" } });
    assert.equal(context.calls.length, 1);
  });
});

test("ABI selection removes earlier generated libraries while preserving unrelated libraries", () => {
  withFixture({}, context => {
    context.oldLibraries();
    const otherLibrary = path.join(path.dirname(context.packaged("arm64-v8a")), "libother.so");
    writeFileSync(otherLibrary, "unrelated library");
    context.build({ env: { ...context.env, SYNC_ANDROID_ABIS: " x86_64, x86_64 " } });
    assert.equal(context.calls.length, 1);
    for (const abi of ["arm64-v8a", "armeabi-v7a", "x86"]) assert.equal(existsSync(context.packaged(abi)), false);
    assert.equal(readFileSync(otherLibrary, "utf8"), "unrelated library");
  });
});

test("a failed later build does not package partial or stale native libraries", () => {
  withFixture({}, context => {
    context.oldLibraries();
    let count = 0;
    const spawn = (...args) => ++count === 2 ? { status: 7 } : context.spawn(...args);
    assert.throws(() => context.build({ spawn }), error => error.exitCode === 7 && error.message.includes("armeabi-v7a"));
    for (const abi of Object.keys(abiTargets)) assert.equal(existsSync(context.packaged(abi)), false);
  });
});

test("toolchain validation stops before Cargo and does not fall back to a newer NDK", () => {
  withFixture({}, context => {
    rmSync(path.join(context.sdk, "ndk", ANDROID_NDK_VERSION), { recursive: true });
    mkdirSync(path.join(context.sdk, "ndk", "99.0.0"), { recursive: true });
    assert.throws(() => context.build(), /Install NDK 30\.0\.14904198/);
    assert.equal(context.calls.length, 0);
  });
  withFixture({}, context => {
    rmSync(path.join(context.bin, "i686-linux-android24-clang"));
    assert.throws(() => context.build(), /Missing NDK compiler/);
    assert.equal(context.calls.length, 0);
  });
});

test("supported hosts use their NDK binaries and Windows executable suffixes", () => {
  for (const [platform, arch] of [["linux", "x64"], ["win32", "x64"], ["darwin", "x64"], ["darwin", "arm64"]]) {
    withFixture({ platform, arch }, context => {
      context.build({ env: { ...context.env, SYNC_ANDROID_ABIS: "x86_64" } });
      const [call] = context.calls;
      assert.ok(call.env.CC_x86_64_linux_android.startsWith(context.bin));
      assert.equal(call.env.CC_x86_64_linux_android.endsWith(".cmd"), platform === "win32");
      assert.equal(call.env.AR_x86_64_linux_android.endsWith(".exe"), platform === "win32");
    });
  }
});

test("unsupported hosts and invalid ABI lists fail before spawning Cargo", () => {
  withFixture({}, context => {
    for (const [platform, arch] of [["linux", "arm64"], ["win32", "arm64"], ["darwin", "ia32"], ["freebsd", "x64"]]) {
      assert.throws(() => context.build({ platform, arch }), /Unsupported Android build host/);
    }
    for (const abis of ["", "arm64-v8a,", "unknown", "x86,,x86_64"]) {
      assert.throws(() => context.build({ env: { ...context.env, SYNC_ANDROID_ABIS: abis } }), /Unknown SYNC_ANDROID_ABIS/);
    }
    assert.equal(context.calls.length, 0);
  });
});
