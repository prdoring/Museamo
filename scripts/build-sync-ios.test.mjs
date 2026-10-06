import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appleTargets, buildAppleCore } from './build-sync-ios.mjs';
test('Windows fails before spawning or writing Apple build outputs', () => {
  let called = false;
  assert.throws(() => buildAppleCore({ platform: 'win32', run: () => { called = true; } }), /macOS and Xcode/);
  assert.equal(called, false);
});
test('device and both simulator architectures are distinct from Mac host tests', () => {
  assert.deepEqual(appleTargets, ['aarch64-apple-ios', 'aarch64-apple-ios-sim', 'x86_64-apple-ios', 'aarch64-apple-darwin', 'x86_64-apple-darwin']);
});
