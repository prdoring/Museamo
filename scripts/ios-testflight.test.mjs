import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildNumber, validateConfig, validateUploadConfig, validateProfile, exportOptions, decodeSecret, main, validateReleaseIdentity } from './ios-testflight.mjs';

const team = 'ABCDE12345';
const certificate = Buffer.from('test-only-certificate');
const sha1 = createHash('sha1').update(certificate).digest('hex');
function profile() { return { UUID: '01234567-89ab-cdef-0123-456789abcdef', TeamIdentifier: [team], ApplicationIdentifierPrefix: ['OLDER12345'], ExpirationDate: '2099-01-01T00:00:00Z', DeveloperCertificates: [certificate.toString('base64')], Entitlements: { 'com.apple.developer.team-identifier': team, 'application-identifier': 'OLDER12345.com.prdoring.museamo', 'get-task-allow': false } }; }
function config() { return { IOS_TEAM_ID: team, IOS_DISTRIBUTION_P12_BASE64: 'YWJj', IOS_DISTRIBUTION_P12_PASSWORD: 'test password', IOS_PROVISIONING_PROFILE_BASE64: 'YWJj' }; }

test('build numbers are monotonic for new runs and retries, including rollover', () => {
  assert.equal(buildNumber('1', '1'), '1.0.0');
  assert.equal(buildNumber('1', '2'), '1.0.1');
  assert.equal(buildNumber('100', '100'), '1.99.99');
  assert.equal(buildNumber('101', '1'), '2.0.0');
  assert.equal(buildNumber('999900', '1'), '9999.99.0');
  for (const args of [[0, 1], [1, 0], ['1;echo', 1], [1, 101], [999901, 1]]) assert.throws(() => buildNumber(...args));
});

test('missing credentials fail early without echoing secret values', () => {
  for (const name of Object.keys(config())) {
    const env = config(); delete env[name];
    assert.throws(() => validateConfig(env), new RegExp(name));
  }
  assert.doesNotThrow(() => validateConfig(config()));
  assert.throws(() => validateConfig({ ...config(), TESTFLIGHT_UPLOAD: 'true' }), /ASC_API_KEY_BASE64/);
  assert.throws(() => decodeSecret('not a key!', 'TEST_SECRET'), /TEST_SECRET must contain/);
  assert.equal(decodeSecret('YW\nJj', 'TEST_SECRET').toString(), 'abc');
});

test('API upload requires a team issuer and a P-256 private key', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const env = { ASC_KEY_ID: 'KEYID12345', ASC_ISSUER_ID: '01234567-89ab-cdef-0123-456789abcdef', ASC_API_KEY_BASE64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') };
  assert.doesNotThrow(() => validateUploadConfig(env));
  assert.throws(() => validateUploadConfig({ ...env, ASC_ISSUER_ID: '' }), /ASC_ISSUER_ID/);
  const { privateKey: wrong } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  assert.throws(() => validateUploadConfig({ ...env, ASC_API_KEY_BASE64: Buffer.from(wrong.export({ type: 'pkcs8', format: 'pem' })).toString('base64') }), /P-256/);
});

test('App Store profile binds the team, explicit app, expiry, and signing certificate', () => {
  assert.equal(validateProfile(profile(), team, sha1), profile().UUID);
  assert.throws(() => validateProfile(profile(), 'OTHER12345', sha1), /different Apple team/);
  const wildcard = profile(); wildcard.Entitlements['application-identifier'] = 'OLDER12345.*';
  assert.throws(() => validateProfile(wildcard, team, sha1), /explicit bundle ID/);
  assert.throws(() => validateProfile({ ...profile(), ExpirationDate: '2000-01-01' }, team, sha1), /expired/);
  assert.throws(() => validateProfile(profile(), team, '0'.repeat(40)), /does not include/);
  assert.throws(() => validateProfile({ ...profile(), UUID: '../outside' }, team, sha1), /UUID/);
});

test('Development, Ad Hoc, and Enterprise profiles cannot produce a TestFlight build', () => {
  const development = profile(); development.Entitlements['get-task-allow'] = true;
  for (const invalid of [development, { ...profile(), ProvisionedDevices: ['device'] }, { ...profile(), ProvisionsAllDevices: true }]) assert.throws(() => validateProfile(invalid, team, sha1), /App Store Connect distribution profile/);
});

test('export is manual, preserves build identity, and does not upload', () => {
  const xml = exportOptions(team, profile().UUID, sha1);
  assert.match(xml, /<key>method<\/key><string>app-store-connect<\/string>/);
  assert.match(xml, /<key>destination<\/key><string>export<\/string>/);
  assert.match(xml, /<key>manageAppVersionAndBuildNumber<\/key><false\/>/);
  assert.match(xml, /com\.prdoring\.museamo/);
  assert.match(exportOptions('x<&', profile().UUID, sha1), /x&lt;&amp;/);
});

test('credential mutations cannot run on the Windows development computer', () => {
  if (process.platform === 'darwin') return;
  assert.throws(() => main('build', config()), /GitHub-hosted Mac/);
  assert.throws(() => main('cleanup', {}), /GitHub-hosted Mac/);
});

test('archive provisioning applies only to the App release target, never package resource bundles', () => {
  const builder = readFileSync(new URL('./ios-testflight.mjs', import.meta.url), 'utf8');
  const project = readFileSync(new URL('../ios/App/App.xcodeproj/project.pbxproj', import.meta.url), 'utf8');
  const archiveCommand = builder.match(/run\('xcodebuild', \[.*'archive'\]/)[0];
  assert.match(archiveCommand, /MUSEAMO_APP_PROVISIONING_PROFILE=\$\{uuid\}/);
  assert.doesNotMatch(archiveCommand, /[`'"]PROVISIONING_PROFILE(?:_SPECIFIER)?=/);
  const appRelease = project.match(/504EC3181FED79650016851F \/\* Release \*\/ = \{([\s\S]*?)\n\t\t\};/)[1];
  assert.match(appRelease, /PRODUCT_BUNDLE_IDENTIFIER = com\.prdoring\.museamo;/);
  assert.match(appRelease, /PROVISIONING_PROFILE_SPECIFIER = "\$\(MUSEAMO_APP_PROVISIONING_PROFILE\)";/);
  assert.equal(project.match(/PROVISIONING_PROFILE_SPECIFIER/g)?.length, 1);
});

test('manual validation defaults to no upload and trusted reusable release calls are supported', () => {
  const workflow = readFileSync(new URL('../.github/workflows/testflight.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request):/m);
  assert.match(workflow, /default: false/);
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(workflow, /if: inputs\.upload/);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /path:.*(p12|p8|mobileprovision|keychain)/);
});

// Execute the workflow's actual preflight, with the GitHub API replaced by fixtures.
// This checks the signing gate without accessing credentials or launching a build.
function candidateGate() {
  const workflow = readFileSync(new URL('../.github/workflows/testflight.yml', import.meta.url), 'utf8');
  const body = workflow.match(/Require successful checks for the exact candidate commit[\s\S]*?script: \|\r?\n([\s\S]*?)      - uses: actions\/checkout@v4/)[1];
  return new (Object.getPrototypeOf(async function () {}).constructor)('context', 'github', 'core', body.replace(/^            /gm, ''));
}
function checkedCandidate() {
  const context = { eventName: 'workflow_dispatch', ref: 'refs/heads/codex/ios-sharing', sha: 'a'.repeat(40), repo: { owner: 'prdoring', repo: 'Museamo' } };
  const run = { id: 123, head_sha: context.sha, status: 'completed', conclusion: 'success', event: 'pull_request', repository: { full_name: 'prdoring/Museamo' }, head_repository: { full_name: 'prdoring/Museamo' }, html_url: 'https://github.com/prdoring/Museamo/actions/runs/123' };
  const jobs = ['tests', 'ios', 'build'].map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const requests = [];
  const outputs = [];
  const summary = { addHeading() { return this; }, addRaw() { return this; }, async write() {} };
  return { context, run, jobs, requests, outputs, core: { setOutput(...args) { outputs.push(args); }, summary }, github: { rest: { actions: { async listWorkflowRuns(params) { requests.push(params); return { data: { workflow_runs: [run] } }; }, listJobsForWorkflowRun() {} } }, async paginate(method, params) { requests.push(params); return jobs; } } };
}

test('an explicit iPhone candidate signs only the exact checked own-repository commit', async () => {
  const fixture = checkedCandidate();
  await candidateGate()(fixture.context, fixture.github, fixture.core);
  assert.equal(fixture.requests[0].head_sha, fixture.context.sha);
  assert.equal(fixture.requests[0].workflow_id, 'ci.yml');
  assert.equal(fixture.requests[1].run_id, fixture.run.id);
  assert.deepEqual(fixture.outputs, [['checked-run', 123]]);
  const workflow = readFileSync(new URL('../.github/workflows/testflight.yml', import.meta.url), 'utf8');
  assert.match(workflow, /inputs\.candidate && startsWith\(github\.ref, 'refs\/heads\/codex\/'\)/);
  assert.match(workflow, /actions: read/);
  assert.ok(workflow.indexOf('Require successful checks') < workflow.indexOf('actions/checkout@v4'));
  assert.ok(workflow.indexOf('Require successful checks') < workflow.indexOf('secrets.IOS_DISTRIBUTION_P12_BASE64', workflow.indexOf('    steps:')));
});

test('candidate signing rejects forks, stale commits, failed checks and nonmanual events', async () => {
  const mutations = [
    f => { f.run.head_sha = 'b'.repeat(40); },
    f => { f.run.head_repository.full_name = 'someone/Museamo'; },
    f => { f.run.repository.full_name = 'someone/Museamo'; },
    f => { f.run.status = 'in_progress'; },
    f => { f.run.conclusion = 'failure'; },
    f => { f.run.event = 'pull_request_target'; },
    f => { f.context.eventName = 'pull_request'; },
    f => { f.context.ref = 'refs/heads/main'; },
    f => { f.context.sha = '../not-a-commit'; },
  ];
  for (const mutate of mutations) {
    const fixture = checkedCandidate(); mutate(fixture);
    await assert.rejects(candidateGate()(fixture.context, fixture.github, fixture.core), /Candidates require|needs successful/);
    assert.deepEqual(fixture.outputs, []);
  }
});

test('candidate signing requires iPhone and aggregate checks to actually run successfully', async () => {
  for (const name of ['tests', 'ios', 'build']) {
    for (const conclusion of ['skipped', 'cancelled', 'failure']) {
      const fixture = checkedCandidate(); fixture.jobs.find(job => job.name === name).conclusion = conclusion;
      await assert.rejects(candidateGate()(fixture.context, fixture.github, fixture.core), /skipped checks are insufficient/);
      assert.deepEqual(fixture.outputs, []);
    }
  }
});

test('mainline caller grants the read permissions required by the reusable iPhone workflow', () => {
  const caller = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const callee = readFileSync(new URL('../.github/workflows/testflight.yml', import.meta.url), 'utf8');
  const callerPermissions = caller.match(/  testflight:\r?\n[\s\S]*?    permissions:\r?\n([\s\S]*?)    uses:/)[1];
  const calleePermissions = callee.match(/^permissions:\r?\n([\s\S]*?)\r?\nconcurrency:/m)[1];
  const levels = { none: 0, read: 1, write: 2 };
  for (const [, permission, level] of calleePermissions.matchAll(/^  (\w+): (read|write)\s*$/gm)) {
    const inherited = callerPermissions.match(new RegExp(`^      ${permission}: (none|read|write)\\s*$`, 'm'))?.[1] ?? 'none';
    assert.ok(levels[inherited] >= levels[level], `Mainline TestFlight must grant ${permission}: ${level} to its reusable workflow.`);
  }
});

test('iPhone identity uses the checked-out release commit rather than workflow_run default SHA', () => {
  const commit = 'a'.repeat(40);
  const env = { MUSEAMO_RELEASE_VERSION: '0.4.1', MUSEAMO_RELEASE_COMMIT: commit, GITHUB_SHA: 'b'.repeat(40) };
  assert.deepEqual(validateReleaseIdentity(env, '0.4.1', commit), { version: '0.4.1', commit });
  assert.throws(() => validateReleaseIdentity(env, '0.4.0', commit), /reserved release identity/);
  assert.throws(() => validateReleaseIdentity(env, '0.4.1', 'b'.repeat(40)), /reserved release identity/);
});
