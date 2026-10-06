import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyChanges, changedFiles, checkResults, releaseEligible, scopeKeys } from './ci-changes.mjs';

const scope = (...selected) => Object.fromEntries(scopeKeys.map(key => [key, selected.includes(key)]));
const desktopScope = (...selected) => scope('tests', 'desktop', 'desktop_windows', 'desktop_macos', 'desktop_linux', ...selected);
const all = scope(...scopeKeys);
for (const [description, files, expected] of [
  ['the Apple README PR', ['README.md', 'docs/images/banner.svg', 'scripts/docs-banner.mjs'], scope()],
  ['documentation and issue templates', ['docs/releases.md', 'LICENSE', '.github/ISSUE_TEMPLATE/bug_report.yml'], scope()],
  ['native package documentation', ['native/ios/MuseamoNative/README.md', 'ios/App/CapApp-SPM/README.md'], scope()],
  ['an unchanged tree', [], scope()],
  ['frontend tests', ['src/platform.test.ts', 'src/App.test.tsx', 'test-fixtures/hashtags.json'], scope('tests')],
  ['release and signing tools', ['scripts/release.mjs', 'scripts/release-prepare.test.mjs', 'scripts/ios-testflight.mjs'], scope('tests')],
  ['desktop developer helpers', ['scripts/desktop-doctor.mjs', 'scripts/generate-branding.mjs'], scope('tests')],
  ['Swift tests', ['native/ios/MuseamoNative/Tests/MuseamoNativeTests/LibraryStoreTests.swift'], scope('tests', 'ios')],
  ['Android tests', ['android/app/src/test/Test.kt', 'android/app/src/androidTest/Test.kt'], scope('tests', 'android')],
  ['desktop tests', ['desktop/src/integration_tests.rs', 'desktop/src/identity/tests.rs', 'desktop/test-fixtures/library.json'], desktopScope()],
  ['Rust core tests', ['crates/sync-core/src/tests.rs', 'crates/sync-core/tests/integration.rs'], desktopScope('android', 'ios')],
  ['iPhone UI tests', ['ios/App/AppUITests/PersistenceSmokeTests.swift'], scope('tests', 'ios', 'ios_package')],
  ['iPhone implementation', ['ios/App/App/MuseamoPlugin.swift'], scope('tests', 'ios', 'ios_package', 'release')],
  ['Swift storage', ['native/ios/MuseamoNative/Sources/MuseamoNative/LibraryStore.swift'], scope('tests', 'ios', 'ios_package', 'release')],
  ['generated iPhone assets', ['scripts/generate-ios-assets.mjs'], scope('tests', 'ios', 'ios_package', 'release')],
  ['Android implementation', ['android/app/src/main/Widget.kt'], scope('tests', 'android', 'release')],
  ['Android native builder', ['scripts/build-sync-android.mjs'], scope('tests', 'android', 'release')],
  ['desktop implementation', ['desktop/src/store.rs'], desktopScope('desktop_package', 'release')],
  ['shared desktop packaging', ['desktop/tauri.conf.json', 'scripts/desktop.mjs'], desktopScope('desktop_package', 'release')],
  ['Mac packaging', ['desktop/tauri.macos.conf.json', 'desktop/Info.plist', 'desktop/icons/icon.icns'], scope('tests', 'desktop', 'desktop_macos', 'desktop_package', 'release')],
  ['Windows packaging', ['desktop/tauri.windows.conf.json', 'desktop/icons/icon.ico'], scope('tests', 'desktop', 'desktop_windows', 'desktop_package', 'release')],
  ['Linux packaging', ['desktop/tauri.linux.conf.json'], scope('tests', 'desktop', 'desktop_linux', 'desktop_package', 'release')],
  ['shared Rust implementation', ['crates/sync-core/src/lib.rs', 'Cargo.lock'], desktopScope('android', 'ios', 'ios_package', 'desktop_package', 'release')],
  ['shared frontend code', ['src/App.tsx'], all],
  ['dependency updates', ['package-lock.json'], all],
  ['bundled Markdown assets', ['public/fonts/SourceSerif4-LICENSE.md'], all],
  ['an unfamiliar path', ['new-platform/library.md'], all],
  ['workflow configuration', ['.github/workflows/ci.yml', 'scripts/ci-changes.mjs'], { ...all, release: false }],
  ['mixed documentation and app changes', ['docs/ios-development.md', 'src/platform.ts'], all],
  ['app changes before workflow changes', ['src/App.tsx', '.github/workflows/ci.yml'], all],
]) {
  test(`${description} selects the needed work`, () => assert.deepEqual(classifyChanges(files), expected));
}

test('manual validation runs all checks without requesting an automatic release', () => {
  assert.deepEqual(classifyChanges(['README.md'], { manual: true }), { ...all, release: false });
});

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'museamo-ci-scope-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('museamo-ci-scope-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function git(directory, ...args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function put(directory, filename, text) {
  mkdirSync(path.dirname(path.join(directory, filename)), { recursive: true });
  writeFileSync(path.join(directory, filename), text);
}
function commit(directory, subject) {
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', subject);
  return git(directory, 'rev-parse', 'HEAD');
}
function repository(t) {
  const directory = fixture(t);
  git(directory, 'init', '-b', 'main');
  git(directory, 'config', 'user.name', 'Tests');
  git(directory, 'config', 'user.email', 'tests@example.invalid');
  put(directory, 'README.md', 'Docs\n');
  put(directory, 'src/app.ts', 'app\n');
  return { directory, before: commit(directory, 'Baseline') };
}

test('the entire multi-commit push is compared, including app changes before a docs commit', t => {
  const f = repository(t);
  put(f.directory, 'src/app.ts', 'changed app\n');
  commit(f.directory, 'App change');
  put(f.directory, 'README.md', 'Changed docs\n');
  const after = commit(f.directory, 'Docs change');
  assert.deepEqual(changedFiles(f.directory, 'push', { before: f.before, after }).sort(), ['README.md', 'src/app.ts']);
  assert.deepEqual(classifyChanges(changedFiles(f.directory, 'push', { before: f.before, after })), all);
  assert.deepEqual(classifyChanges(changedFiles(f.directory, 'push', { before: '0'.repeat(40), after })), all);
});

test('moving code into docs still checks the deleted source path', t => {
  const f = repository(t);
  mkdirSync(path.join(f.directory, 'docs'));
  renameSync(path.join(f.directory, 'src/app.ts'), path.join(f.directory, 'docs/example.ts'));
  const after = commit(f.directory, 'Move source');
  assert.deepEqual(changedFiles(f.directory, 'push', { before: f.before, after }).sort(), ['docs/example.ts', 'src/app.ts']);
  assert.deepEqual(classifyChanges(changedFiles(f.directory, 'push', { before: f.before, after })), all);
});

test('PR comparison excludes unrelated changes to the base branch', t => {
  const f = repository(t);
  git(f.directory, 'checkout', '-b', 'docs');
  put(f.directory, 'README.md', 'Changed docs\n');
  const head = commit(f.directory, 'Docs change');
  git(f.directory, 'checkout', 'main');
  put(f.directory, 'src/app.ts', 'Main advanced\n');
  const base = commit(f.directory, 'Unrelated app change');
  const files = changedFiles(f.directory, 'pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } });
  assert.deepEqual(files, ['README.md']);
  assert.deepEqual(classifyChanges(files), scope());
});

test('invalid events and missing comparison commits fail instead of skipping work', t => {
  const f = repository(t);
  assert.throws(() => changedFiles(f.directory, 'push', { after: f.before }), /invalid/);
  assert.throws(() => changedFiles(f.directory, 'push', { before: 'f'.repeat(40), after: f.before }), /determine/);
  assert.throws(() => changedFiles(f.directory, 'workflow_run', {}), /Unsupported/);
});

function results(selected = scope()) {
  const needs = { changes: { result: 'success', outputs: Object.fromEntries(Object.entries(selected).map(([key, value]) => [key, String(value)])) } };
  const flags = { tests: 'tests', android: 'android', 'native-tests': 'android', ios: 'ios',
    'desktop-windows': 'desktop_windows', 'desktop-macos': 'desktop_macos', 'desktop-linux': 'desktop_linux' };
  for (const [job, flag] of Object.entries(flags)) needs[job] = { result: selected[flag] ? 'success' : 'skipped' };
  return needs;
}
test('the required build check accepts intentional skips but blocks detection and selected-job failures', () => {
  checkResults(results());
  checkResults(results(all));
  checkResults(results(scope('tests', 'desktop', 'desktop_macos', 'desktop_package', 'release')));
  for (const status of ['failure', 'cancelled', 'skipped']) {
    const failed = results(all);
    failed.ios.result = status;
    assert.throws(() => checkResults(failed), /ios/);
  }
  const failed = results();
  failed.changes.result = 'failure';
  assert.throws(() => checkResults(failed), /detection/);
  failed.changes.result = 'success';
  delete failed.changes.outputs.ios;
  assert.throws(() => checkResults(failed), /scope/);
  assert.throws(() => checkResults({ changes: results().changes }), /missing/);
});

test('release eligibility is bound to the original successful Checks run and source', () => {
  const checked = { id: 123, head_sha: 'a'.repeat(40) };
  const record = { schema: 1, event: 'push', runId: '123', sourceCommit: checked.head_sha, scope: scope() };
  assert.equal(releaseEligible(record, checked), false);
  assert.equal(releaseEligible({ ...record, scope: all }, checked), true);
  for (const replacement of [{ schema: 2 }, { event: 'pull_request' }, { runId: '124' }, { sourceCommit: 'b'.repeat(40) }, { scope: { release: true } }]) {
    assert.throws(() => releaseEligible({ ...record, ...replacement }, checked), /refused/);
  }
  assert.throws(() => releaseEligible(null, checked), /refused/);
});

test('the release CLI explicitly outputs false for a docs-only main run', t => {
  const directory = fixture(t), output = path.join(directory, 'output'), summary = path.join(directory, 'summary');
  const checked = { id: 123, head_sha: 'a'.repeat(40) };
  put(directory, 'event.json', JSON.stringify({ workflow_run: checked }));
  put(directory, 'record.json', JSON.stringify({ schema: 1, event: 'push', runId: '123', sourceCommit: checked.head_sha, scope: scope() }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./ci-changes.mjs', import.meta.url)), 'release', path.join(directory, 'record.json')], {
    encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: path.join(directory, 'event.json'), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, 'utf8'), 'release=false\n');
  assert.match(readFileSync(summary, 'utf8'), /no version reservation/);
});
