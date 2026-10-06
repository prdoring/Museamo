import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appleTargets, buildAppleCore } from './build-sync-ios.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
test('Windows fails before spawning or writing Apple build outputs', () => {
  let called = false;
  assert.throws(() => buildAppleCore({ platform: 'win32', run: () => { called = true; } }), /macOS and Xcode/);
  assert.equal(called, false);
});
test('locked libraries, lib-prefixed slices and native headers form one framework without inheriting desktop targets', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'museamo-apple-build-'));
  const include = path.join(root, 'crates', 'sync-core', 'include'); mkdirSync(include, { recursive: true }); writeFileSync(path.join(include, 'museamo_sync.h'), 'fixture ABI header');
  const calls = [], env = { CARGO_TARGET_DIR: 'custom output', CARGO_BUILD_TARGET: 'desktop-target' };
  const destination = path.join(root, 'native', 'ios', 'MuseamoNative', 'Frameworks', 'MuseamoSyncCore.xcframework');
  const run = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd === 'cargo') { const target = args[args.indexOf('--target') + 1], output = path.join(options.env.CARGO_TARGET_DIR, target, 'release'); mkdirSync(output, { recursive: true }); writeFileSync(path.join(output, 'libmuseamo_sync_core.a'), target); }
    if (cmd === 'lipo') { for (const library of args.slice(1, -2)) assert.ok(existsSync(library)); assert.match(path.basename(args.at(-1)), /^lib.*\.a$/); writeFileSync(args.at(-1), 'universal library'); }
    if (cmd === 'xcodebuild') { const slices = args.flatMap((value, index) => value === '-library' ? [args[index + 1]] : []); assert.equal(slices.length, 3); for (const slice of slices) assert.match(path.basename(slice), /^lib.*\.a$/); mkdirSync(args.at(-1), { recursive: true }); writeFileSync(path.join(args.at(-1), 'Info.plist'), 'new framework'); }
    return { status: 0 };
  };
  try {
    buildAppleCore({ root, platform: 'darwin', run, env });
    assert.deepEqual(calls.filter(c => c.cmd === 'cargo').map(c => c.args.at(-1)), appleTargets);
    assert.equal(readFileSync(path.join(destination, 'Info.plist'), 'utf8'), 'new framework');
    assert.equal(env.CARGO_BUILD_TARGET, 'desktop-target'); assert.equal(calls[0].options.env.CARGO_BUILD_TARGET, undefined);
    assert.equal(calls[0].options.env.IPHONEOS_DEPLOYMENT_TARGET, '16.4');
    assert.throws(() => buildAppleCore({ root, platform: 'darwin', env, run: cmd => ({ status: cmd === 'cargo' ? 1 : 0 }) }), /cargo failed/);
    assert.equal(readFileSync(path.join(destination, 'Info.plist'), 'utf8'), 'new framework');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
