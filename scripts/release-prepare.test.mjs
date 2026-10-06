import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareRelease, nextIdentity, trustedRun } from './release-prepare.mjs';

function git(directory, ...args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'museamo-reservation-test-'));
  const remote = path.join(directory, 'remote.git'), checkout = path.join(directory, 'checkout');
  git(directory, 'init', '--bare', remote);
  mkdirSync(checkout);
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Tests');
  git(checkout, 'config', 'user.email', 'tests@example.invalid');
  const files = {
    'package.json': JSON.stringify({ version: '0.4.0' }),
    'package-lock.json': JSON.stringify({ version: '0.4.0', packages: { '': { version: '0.4.0' } } }),
    'desktop/tauri.conf.json': JSON.stringify({ version: '0.4.0' }),
    'Cargo.toml': '[workspace.package]\nversion = "0.4.0"\n',
    'Cargo.lock': '[[package]]\nname = "museamo-desktop"\nversion = "0.4.0"\n\n[[package]]\nname = "museamo-sync-core"\nversion = "0.4.0"\n\n[[package]]\nname = "unrelated"\nversion = "0.4.0"\n',
    'android/app/build.gradle': 'versionName "0.4.0"\nversionCode 5\n',
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(checkout, file)), { recursive: true });
    writeFileSync(path.join(checkout, file), text);
  }
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', 'Baseline');
  git(checkout, 'tag', '-a', 'v0.4.0', '-m', 'Existing release');
  git(checkout, 'remote', 'add', 'origin', remote);
  git(checkout, 'push', 'origin', 'main', '--tags');
  writeFileSync(path.join(checkout, 'feature.txt'), 'feature');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', 'Merged feature');
  git(checkout, 'push', 'origin', 'main');
  return { directory, remote, checkout, sourceCommit: git(checkout, 'rev-parse', 'HEAD') };
}

test('patch versions compare numerically and reserve Android codes across all existing tags', () => {
  assert.deepEqual(nextIdentity('0.4.0', 5, []), { version: '0.4.1', versionCode: 6 });
  assert.deepEqual(nextIdentity('0.4.0', 5, [{ version: '0.4.9', versionCode: 7 }, { version: '0.4.10', versionCode: 6 }]), { version: '0.4.11', versionCode: 8 });
  assert.deepEqual(nextIdentity('0.5.0', 8, [{ version: '0.4.99', versionCode: 9 }]), { version: '0.5.1', versionCode: 10 });
  assert.throws(() => nextIdentity('invalid', 5, []), /version/);
  assert.throws(() => nextIdentity('0.4.0', 2100000000, []), /exhausted/);
});

test('only successful push checks on own-repository main are eligible', () => {
  const run = { name: 'Checks', conclusion: 'success', event: 'push', head_branch: 'main', repository: { full_name: 'owner/repo' }, head_repository: { full_name: 'owner/repo' } };
  assert.equal(trustedRun({ workflow_run: run }, 'owner/repo'), true);
  for (const replacement of [{ conclusion: 'failure' }, { event: 'pull_request' }, { head_branch: 'feature' }, { head_repository: { full_name: 'fork/repo' } }, { name: 'Other workflow' }]) {
    assert.equal(trustedRun({ workflow_run: { ...run, ...replacement } }, 'owner/repo'), false);
  }
  assert.equal(trustedRun({}, 'owner/repo'), false);
});

test('reservation commits consistent versions, preserves main, and recovers failed-build reruns', () => {
  const f = fixture();
  try {
    const reservation = prepareRelease({ directory: f.checkout, sourceCommit: f.sourceCommit, runId: '123' });
    assert.equal(reservation.tag, 'v0.4.1');
    assert.equal(reservation.versionCode, 6);
    assert.equal(git(f.remote, 'rev-parse', 'main'), f.sourceCommit);
    assert.equal(git(f.checkout, 'rev-parse', 'HEAD^'), f.sourceCommit);
    assert.equal(git(f.checkout, 'status', '--porcelain'), '');
    const lock = readFileSync(path.join(f.checkout, 'Cargo.lock'), 'utf8');
    assert.match(lock, /name = "museamo-desktop"\nversion = "0.4.1"/);
    assert.match(lock, /name = "museamo-sync-core"\nversion = "0.4.1"/);
    assert.match(lock, /name = "unrelated"\nversion = "0.4.0"/);
    const npmLock = JSON.parse(readFileSync(path.join(f.checkout, 'package-lock.json')));
    assert.equal(npmLock.version, '0.4.1');
    assert.equal(npmLock.packages[''].version, '0.4.1');
    assert.match(readFileSync(path.join(f.checkout, 'docs/release-notes/0.4.1.md'), 'utf8'), /Merged feature/);
    assert.deepEqual(prepareRelease({ directory: f.checkout, sourceCommit: f.sourceCommit, runId: '123' }), reservation);
    const duplicate = prepareRelease({ directory: f.checkout, sourceCommit: f.sourceCommit, runId: '124' });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.commit, reservation.commit);
    assert.equal(git(f.checkout, 'tag', '--list', 'v*').split('\n').length, 2);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('racing reservations allocate unique versions and leave remote main untouched', async () => {
  const f = fixture();
  try {
    const second = path.join(f.directory, 'second');
    git(f.directory, 'clone', '--branch', 'main', f.remote, second);
    const first = f.sourceCommit;
    writeFileSync(path.join(f.checkout, 'next.txt'), 'next');
    git(f.checkout, 'add', '.');
    git(f.checkout, 'commit', '-m', 'Next merge');
    git(f.checkout, 'push', 'origin', 'main');
    const next = git(f.checkout, 'rev-parse', 'HEAD');
    const execute = (directory, sourceCommit, runId) => new Promise((resolve, reject) => {
      const code = `import(${JSON.stringify(new URL('./release-prepare.mjs', import.meta.url).href)}).then(({prepareRelease}) => console.log(JSON.stringify(prepareRelease(${JSON.stringify({ directory, sourceCommit, runId })})))).catch(error => { console.error(error.message); process.exitCode = 1; });`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code]);
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    });
    const reservations = await Promise.all([execute(f.checkout, next, '201'), execute(second, first, '202')]);
    assert.deepEqual(reservations.map(value => value.version).sort(), ['0.4.1', '0.4.2']);
    assert.deepEqual(reservations.map(value => value.versionCode).sort(), [6, 7]);
    assert.equal(git(f.remote, 'rev-parse', 'main'), next);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});
