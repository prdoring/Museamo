import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopKeys = ['desktop_windows', 'desktop_macos', 'desktop_linux'];
export const scopeKeys = ['tests', 'android', 'ios', 'desktop', ...desktopKeys, 'ios_package', 'desktop_package', 'release'];
const docs = new Set([
  'README.md', 'CONTRIBUTING.md', 'DESIGN.md', 'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'NOTICE',
  'native/ios/MuseamoNative/README.md', 'ios/App/CapApp-SPM/README.md',
  '.github/PULL_REQUEST_TEMPLATE.md', 'scripts/docs-banner.mjs',
]);
const tooling = new Set([
  'scripts/release.mjs', 'scripts/release-artifacts.mjs', 'scripts/release-prepare.mjs',
  'scripts/release-configure-ci.mjs', 'scripts/release-signing.mjs', 'scripts/release-signing.ps1',
  'scripts/android-ci-signing.mjs', 'scripts/ios-signing.mjs', 'scripts/ios-testflight.mjs',
  'scripts/run-ios-simulator.mjs', 'scripts/test-ios-ui.mjs', 'scripts/desktop-doctor.mjs',
  'scripts/generate-branding.mjs',
]);
const emptyScope = () => Object.fromEntries(scopeKeys.map(key => [key, false]));
const fullScope = (release = false) => Object.fromEntries(scopeKeys.map(key => [key, key === 'release' ? release : true]));

/** Only known documentation/tooling paths avoid native checks; unknown inputs run everything. */
export function classifyChanges(files, { manual = false } = {}) {
  if (manual) return fullScope();
  const scope = emptyScope();
  const select = (...keys) => { for (const key of keys) scope[key] = true; };
  const selectDesktop = (...targets) => select('desktop', ...(targets.length ? targets : desktopKeys));
  for (const file of files) {
    if (docs.has(file) || file.startsWith('docs/') || file.startsWith('.github/ISSUE_TEMPLATE/')) continue;
    select('tests');
    if (file === 'scripts/ci-changes.mjs' || file.startsWith('.github/workflows/')) {
      Object.assign(scope, fullScope(scope.release));
    } else if (tooling.has(file) || /^scripts\/[^/]+\.test\.mjs$/.test(file)
      || file.startsWith('.githooks/') || file === '.gitignore') {
      // Release/signing and developer helpers have their own Node tests. They do not change app code.
    } else if (file.startsWith('src/') && /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
      || file.startsWith('test-fixtures/')) {
      // Frontend test changes are covered by the Linux test job.
    } else if (file.startsWith('native/ios/MuseamoNative/Tests/')) {
      select('ios');
    } else if (/^android\/app\/src\/(test|androidTest)\//.test(file)) {
      select('android');
    } else if (file.startsWith('desktop/test-fixtures/') || /^desktop\/src\/(.*\/)?[^/]*tests\.rs$/.test(file)) {
      selectDesktop();
    } else if (/^crates\/.*\/(tests\/|[^/]*tests\.rs$)/.test(file)) {
      select('android');
      selectDesktop();
    } else if (file.startsWith('ios/App/AppUITests/')) {
      select('ios', 'ios_package');
    } else if (file.startsWith('ios/') || file.startsWith('native/ios/')
      || ['scripts/generate-ios-assets.mjs', 'scripts/branding-art.mjs'].includes(file)) {
      select('ios', 'ios_package', 'release');
    } else if (file.startsWith('android/') || /^scripts\/build-sync-android\.(mjs|ps1)$/.test(file)) {
      select('android', 'release');
    } else if (['desktop/tauri.macos.conf.json', 'desktop/Info.plist', 'desktop/icons/icon.icns'].includes(file)) {
      selectDesktop('desktop_macos');
      select('desktop_package', 'release');
    } else if (['desktop/tauri.windows.conf.json', 'desktop/icons/icon.ico'].includes(file)) {
      selectDesktop('desktop_windows');
      select('desktop_package', 'release');
    } else if (file === 'desktop/tauri.linux.conf.json') {
      selectDesktop('desktop_linux');
      select('desktop_package', 'release');
    } else if (file.startsWith('desktop/') || file === 'scripts/desktop.mjs') {
      selectDesktop();
      select('desktop_package', 'release');
    } else if (file.startsWith('crates/') || ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml'].includes(file)) {
      selectDesktop();
      select('android', 'desktop_package', 'release');
    } else {
      // Shared UI, dependencies, bundled assets, and new/unclassified paths retain full coverage.
      Object.assign(scope, fullScope(true));
    }
  }
  return scope;
}

function gitFiles(directory, ...args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Could not determine changed files: ${result.stderr?.trim() || result.error?.message}`);
  return result.stdout.split('\0').filter(Boolean);
}
function requireCommit(value) {
  if (!/^[a-f\d]{40}$/.test(value || '')) throw new Error('Missing or invalid change-comparison commit.');
  return value;
}

export function changedFiles(directory, eventName, event) {
  if (eventName === 'pull_request') {
    const base = requireCommit(event.pull_request?.base?.sha), head = requireCommit(event.pull_request?.head?.sha);
    return gitFiles(directory, 'diff', '--name-only', '-z', '--no-renames', `${base}...${head}`, '--');
  }
  if (eventName === 'push') {
    const before = requireCommit(event.before), after = requireCommit(event.after);
    if (/^0{40}$/.test(before)) return gitFiles(directory, 'ls-tree', '-r', '--name-only', '-z', after);
    // Use the entire push, rather than just HEAD^, so multiple commits cannot hide app changes.
    return gitFiles(directory, 'diff', '--name-only', '-z', '--no-renames', before, after, '--');
  }
  throw new Error(`Unsupported change event: ${eventName}`);
}

export function checkResults(needs) {
  if (needs.changes?.result !== 'success') throw new Error('Change detection failed or was canceled.');
  const scope = {};
  for (const key of scopeKeys) {
    const value = needs.changes.outputs?.[key];
    if (!['true', 'false'].includes(value)) throw new Error(`Missing check scope: ${key}`);
    scope[key] = value === 'true';
  }
  const expected = {
    tests: scope.tests, android: scope.android, 'native-tests': scope.android, ios: scope.ios,
    'desktop-windows': scope.desktop_windows, 'desktop-macos': scope.desktop_macos, 'desktop-linux': scope.desktop_linux,
  };
  for (const [job, required] of Object.entries(expected)) {
    const result = needs[job]?.result;
    if (required ? result !== 'success' : !['success', 'skipped'].includes(result)) {
      throw new Error(`${job}: ${result || 'missing'} (${required ? 'required for these changes' : 'not selected'}).`);
    }
  }
}

export function releaseEligible(record, checkedRun) {
  if (record?.schema !== 1 || record.event !== 'push'
    || record.sourceCommit !== checkedRun?.head_sha || record.runId !== String(checkedRun?.id)
    || !scopeKeys.every(key => typeof record.scope?.[key] === 'boolean')) {
    throw new Error('Missing, invalid, or mismatched CI change-scope record; release refused.');
  }
  return record.scope.release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const [command = 'detect', recordPath = 'ci-change-scope.json'] = process.argv.slice(2);
    if (command === 'check-results') {
      checkResults(JSON.parse(process.env.CI_JOB_RESULTS));
      console.log('All checks required for these changes passed.');
    } else if (command === 'release') {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      const release = releaseEligible(JSON.parse(readFileSync(recordPath, 'utf8')), event.workflow_run);
      appendFileSync(process.env.GITHUB_OUTPUT, `release=${release}\n`);
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, release
        ? 'App or bundle changes are eligible for an automatic release.\n'
        : 'No app or bundle changes: no version reservation, native release builds, publication, or TestFlight upload.\n');
    } else if (command === 'detect') {
      const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      const files = manual ? [] : changedFiles(directory, process.env.GITHUB_EVENT_NAME, event);
      const scope = classifyChanges(files, { manual });
      writeFileSync(recordPath, JSON.stringify({ schema: 1, event: process.env.GITHUB_EVENT_NAME,
        sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, scope }, null, 2) + '\n');
      for (const [key, value] of Object.entries(scope)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `## Change scope\n\n${manual ? 'Manual run: full validation.' : `${files.length} changed paths.`}\n\n`
        + '| Work | Selected |\n| --- | --- |\n'
        + Object.entries(scope).map(([key, value]) => `| ${key} | ${value ? 'Yes' : 'No'} |\n`).join(''));
    } else throw new Error(`Unknown CI scope command: ${command}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
