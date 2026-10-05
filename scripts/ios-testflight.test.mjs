import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildNumber, validateConfig, validateUploadConfig, validateProfile, exportOptions, decodeSecret, main } from './ios-testflight.mjs';

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

test('distribution is manual and defaults to exporting without upload', () => {
  const workflow = readFileSync(new URL('../.github/workflows/testflight.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request):/m);
  assert.match(workflow, /default: false/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /if: inputs\.upload/);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /path:.*(p12|p8|mobileprovision|keychain)/);
});
