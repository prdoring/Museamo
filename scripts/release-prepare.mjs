import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function compareVersions(a, b) {
  const parse = value => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Invalid release version.');
    const parts = value.split('.').map(Number);
    if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('Invalid release version.');
    return parts;
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

export function nextIdentity(version, versionCode, reservations) {
  compareVersions(version, version);
  let highest = version, code = versionCode;
  for (const reservation of reservations) {
    if (compareVersions(reservation.version, highest) > 0) highest = reservation.version;
    if (!Number.isSafeInteger(reservation.versionCode) || reservation.versionCode < 1) throw new Error('Invalid reserved Android versionCode.');
    code = Math.max(code, reservation.versionCode);
  }
  if (!Number.isSafeInteger(code) || code < 1 || code >= 2100000000) throw new Error('Android versionCode exhausted or invalid.');
  const parts = highest.split('.').map(Number);
  parts[2]++;
  const next = parts.join('.');
  compareVersions(next, next);
  return { version: next, versionCode: code + 1 };
}

export function updateVersions(directory, { version, versionCode }) {
  for (const filename of ['package.json', 'package-lock.json', 'desktop/tauri.conf.json']) {
    const location = path.join(directory, filename);
    const value = JSON.parse(readFileSync(location, 'utf8'));
    value.version = version;
    if (filename === 'package-lock.json') value.packages[''].version = version;
    writeFileSync(location, JSON.stringify(value, null, 2) + '\n');
  }
  const replace = (filename, pattern, replacement) => {
    const location = path.join(directory, filename), original = readFileSync(location, 'utf8');
    if (!pattern.test(original)) throw new Error(`Missing version in ${filename}.`);
    writeFileSync(location, original.replace(pattern, replacement));
  };
  replace('Cargo.toml', /(\[workspace.package\][\s\S]*?version\s*=\s*")[^"]+("\s*)/, `$1${version}$2`);
  for (const name of ['museamo-desktop', 'museamo-sync-core']) {
    replace('Cargo.lock', new RegExp(`(name = "${name}"\\s+version = ")[^"]+(")`), `$1${version}$2`);
  }
  replace('android/app/build.gradle', /versionName\s+"[^"]+"/, `versionName "${version}"`);
  replace('android/app/build.gradle', /versionCode\s+\d+/, `versionCode ${versionCode}`);
}

export function prepareRelease({ directory, sourceCommit, runId }) {
  if (!/^[a-f\d]{40}$/.test(sourceCommit) || !/^\d+$/.test(runId)) throw new Error('Invalid source commit or run ID.');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8', env: { ...process.env, MUSEAMO_RELEASE_PUSH: '1' } });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr?.trim() || 'could not start'}`);
    return result.stdout.trim();
  };
  if (git('status', '--porcelain')) throw new Error('Reservation requires a clean checkout.');
  git('fetch', 'origin', 'main', '--tags');
  git('merge-base', '--is-ancestor', sourceCommit, 'origin/main');
  git('checkout', '--detach', sourceCommit);
  // A tag push is the atomic reservation. On a collision, fetch and allocate again.
  for (let attempt = 0; attempt < 5; attempt++) {
    const reservations = [];
    for (const tag of git('tag', '--list', 'v*').split('\n').filter(tag => /^v\d+\.\d+\.\d+$/.test(tag))) {
      const gradle = git('show', `${tag}:android/app/build.gradle`);
      const versionCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1]);
      const contents = git('for-each-ref', '--format=%(contents)', `refs/tags/${tag}`);
      let metadata;
      if (contents.startsWith('{')) {
        metadata = JSON.parse(contents);
        if (metadata.schema !== 1 || metadata.version !== tag.slice(1) || metadata.versionCode !== versionCode || !/^[a-f\d]{40}$/.test(metadata.sourceCommit) || !/^\d+$/.test(metadata.runId) || git('rev-parse', `${tag}^`) !== metadata.sourceCommit) throw new Error(`Invalid reservation ${tag}.`);
      }
      reservations.push({ version: tag.slice(1), versionCode, tag, ...metadata });
    }
    const matching = reservations.filter(value => value.sourceCommit === sourceCommit);
    if (matching.length > 1) throw new Error('Multiple release reservations for the same source commit.');
    if (matching.length) {
      const existing = matching[0];
      return { ...existing, commit: git('rev-parse', `${existing.tag}^{commit}`), duplicate: existing.runId !== runId };
    }
    git('checkout', '--detach', sourceCommit);
    const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const gradle = readFileSync(path.join(directory, 'android/app/build.gradle'), 'utf8');
    const identity = nextIdentity(pkg.version, Number(gradle.match(/versionCode\s+(\d+)/)?.[1]), reservations);
    updateVersions(directory, identity);
    let baseline;
    for (const previous of reservations.sort((a, b) => compareVersions(b.version, a.version))) {
      const candidate = previous.sourceCommit || git('rev-parse', `${previous.tag}^{commit}`);
      const check = spawnSync('git', ['merge-base', '--is-ancestor', candidate, sourceCommit], { cwd: directory });
      if (check.status === 0) { baseline = candidate; break; }
    }
    const changes = git('log', '--format=- %s (%h)', baseline ? `${baseline}..${sourceCommit}` : '-1', ...(baseline ? [] : [sourceCommit]));
    mkdirSync(path.join(directory, 'docs/release-notes'), { recursive: true });
    writeFileSync(path.join(directory, 'docs/release-notes', `${identity.version}.md`), `# Museamo ${identity.version}\n\nAutomatic mainline release from ${sourceCommit}.\n\n${changes}\n`);
    const files = ['package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock', 'desktop/tauri.conf.json', 'android/app/build.gradle', `docs/release-notes/${identity.version}.md`];
    git('add', '--', ...files);
    git('-c', 'user.name=Museamo releases', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-m', `Release ${identity.version}`);
    const reservation = { schema: 1, ...identity, sourceCommit, runId };
    const tag = `v${identity.version}`;
    git('-c', 'user.name=Museamo releases', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'tag', '-a', tag, '-m', JSON.stringify(reservation));
    try {
      git('push', 'origin', `refs/tags/${tag}`);
      return { ...reservation, tag, commit: git('rev-parse', 'HEAD'), duplicate: false };
    } catch (error) {
      // Never remove or move a remote tag. Discard only our unpushed local tag.
      git('tag', '-d', tag);
      git('fetch', 'origin', '--tags');
      if (attempt === 4) throw error;
    }
  }
}

export function trustedRun(event, repository) {
  const checked = event.workflow_run;
  return checked?.name === 'Checks' && checked.conclusion === 'success' && checked.event === 'push' && checked.head_branch === 'main' && checked.repository?.full_name === repository && checked.head_repository?.full_name === repository;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_run') throw new Error('Reservation runs only after successful main CI in GitHub Actions.');
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (!trustedRun(event, process.env.GITHUB_REPOSITORY)) throw new Error('Not a trusted successful main push.');
    const result = prepareRelease({ directory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), sourceCommit: event.workflow_run.head_sha, runId: process.env.GITHUB_RUN_ID });
    for (const key of ['version', 'versionCode', 'tag', 'commit', 'runId', 'duplicate']) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${result[key]}\n`);
    console.log(`Reserved ${result.tag} from ${result.sourceCommit}: ${result.commit}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
