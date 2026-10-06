import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const appleTargets = ['aarch64-apple-ios', 'aarch64-apple-ios-sim', 'x86_64-apple-ios', 'aarch64-apple-darwin', 'x86_64-apple-darwin'];
export function buildAppleCore({ platform = process.platform, run = spawnSync, root: directory = root, env: environment = process.env } = {}) {
  if (platform !== 'darwin') throw new Error('Apple sync frameworks require macOS and Xcode. Use the GitHub iPhone build workflow from Windows.');
  directory = path.resolve(directory);
  const targetDirectory = path.resolve(directory, environment.CARGO_TARGET_DIR || 'target');
  const env = { ...environment, CARGO_TARGET_DIR: targetDirectory, IPHONEOS_DEPLOYMENT_TARGET: '16.4', MACOSX_DEPLOYMENT_TARGET: '13.0' };
  delete env.CARGO_BUILD_TARGET;
  const execute = (cmd, args) => {
    const result = run(cmd, args, { cwd: directory, env, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`${cmd} failed building the Apple sync framework (${result.status ?? result.error?.message}).`);
  };
  const staging = path.join(directory, '.tools', 'sync-ios');
  const destination = path.join(directory, 'native', 'ios', 'MuseamoNative', 'Frameworks', 'MuseamoSyncCore.xcframework');
  mkdirSync(staging, { recursive: true });
  const headers = path.join(staging, 'headers');
  mkdirSync(headers, { recursive: true });
  copyFileSync(path.join(directory, 'crates', 'sync-core', 'include', 'museamo_sync.h'), path.join(headers, 'museamo_sync.h'));
  writeFileSync(path.join(headers, 'module.modulemap'), 'module MuseamoSyncCore { header "museamo_sync.h" export * }\n');
  execute('rustup', ['target', 'add', ...appleTargets]);
  for (const target of appleTargets) execute('cargo', ['build', '--locked', '-p', 'museamo-sync-core', '--features', 'ffi', '--release', '--target-dir', targetDirectory, '--target', target]);
  const library = target => path.join(targetDirectory, target, 'release', 'libmuseamo_sync_core.a');
  for (const folder of ['simulator', 'macos']) mkdirSync(path.join(staging, folder), { recursive: true });
  const sim = path.join(staging, 'simulator', 'libmuseamo_sync_core.a'), mac = path.join(staging, 'macos', 'libmuseamo_sync_core.a');
  execute('lipo', ['-create', library(appleTargets[1]), library(appleTargets[2]), '-output', sim]);
  execute('lipo', ['-create', library(appleTargets[3]), library(appleTargets[4]), '-output', mac]);
  const output = path.join(staging, 'MuseamoSyncCore.xcframework');
  if (existsSync(output)) rmSync(output, { recursive: true });
  execute('xcodebuild', ['-create-xcframework', '-library', library(appleTargets[0]), '-headers', headers, '-library', sim, '-headers', headers, '-library', mac, '-headers', headers, '-output', output]);
  mkdirSync(path.dirname(destination), { recursive: true });
  if (existsSync(destination)) rmSync(destination, { recursive: true });
  renameSync(output, destination);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildAppleCore(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
