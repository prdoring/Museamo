import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const bundleId = 'com.prdoring.museamo';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const signingSecrets = ['IOS_DISTRIBUTION_P12_BASE64', 'IOS_DISTRIBUTION_P12_PASSWORD', 'IOS_PROVISIONING_PROFILE_BASE64'];
const uploadSecrets = ['ASC_API_KEY_BASE64', 'ASC_KEY_ID', 'ASC_ISSUER_ID'];

export function decodeSecret(value, name) {
  const text = String(value ?? '').replace(/\s/g, '');
  if (!text || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new Error(`${name} must contain a Base64-encoded file; see docs/testflight-setup.md.`);
  }
  return Buffer.from(text, 'base64');
}

export function validateUploadConfig(env) {
  for (const name of uploadSecrets) if (!env[name]?.trim()) throw new Error(`Missing ${name}; see docs/testflight-setup.md.`);
  if (!/^[A-Z0-9]{10}$/.test(env.ASC_KEY_ID)) throw new Error('ASC_KEY_ID must be the 10-character Apple key ID.');
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(env.ASC_ISSUER_ID)) throw new Error('ASC_ISSUER_ID must be the team key issuer UUID.');
  const key = createPrivateKey(decodeSecret(env.ASC_API_KEY_BASE64, 'ASC_API_KEY_BASE64'));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Use the App Store Connect team API .p8 key (P-256).');
  return key;
}

export function validateConfig(env) {
  for (const name of signingSecrets) if (!env[name]?.trim()) throw new Error(`Missing ${name}; see docs/testflight-setup.md.`);
  if (!/^[A-Z0-9]{10}$/.test(env.IOS_TEAM_ID ?? '')) throw new Error('Set the IOS_TEAM_ID repository variable to your 10-character Apple Team ID.');
  decodeSecret(env.IOS_DISTRIBUTION_P12_BASE64, 'IOS_DISTRIBUTION_P12_BASE64');
  decodeSecret(env.IOS_PROVISIONING_PROFILE_BASE64, 'IOS_PROVISIONING_PROFILE_BASE64');
  if (env.TESTFLIGHT_UPLOAD === 'true') validateUploadConfig(env);
}

export function validateReleaseIdentity(env, version, commit) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid iPhone release version.');
  if (!/^[a-f\d]{40}$/.test(commit)) throw new Error('Invalid iPhone source commit.');
  if (env.MUSEAMO_RELEASE_COMMIT || env.MUSEAMO_RELEASE_VERSION) {
    if (env.MUSEAMO_RELEASE_COMMIT !== commit || env.MUSEAMO_RELEASE_VERSION !== version) throw new Error('iPhone checkout differs from the reserved release identity.');
  }
  return { version, commit };
}

// Apple's build number components are bounded to 4, 2, and 2 digits. Retries
// advance the final component; new workflow runs advance the earlier ones.
export function buildNumber(runNumber, attempt) {
  if (!/^\d+$/.test(String(runNumber)) || !/^\d+$/.test(String(attempt))) throw new Error('Missing GitHub run number or attempt.');
  const run = Number(runNumber), retry = Number(attempt);
  if (!Number.isSafeInteger(run) || run < 1 || run > 999900 || retry < 1 || retry > 100) throw new Error('GitHub build number is outside Apple build-number limits.');
  return `${Math.floor((run - 1) / 100) + 1}.${(run - 1) % 100}.${retry - 1}`;
}

export function validateProfile(profile, team, certificateSHA1, now = Date.now()) {
  const entitlements = profile.Entitlements ?? {};
  if (!/^[a-f\d-]{36}$/i.test(profile.UUID ?? '')) throw new Error('Provisioning profile has no valid UUID.');
  if (!profile.TeamIdentifier?.includes(team) || entitlements['com.apple.developer.team-identifier'] !== team) throw new Error('Provisioning profile belongs to a different Apple team.');
  const prefix = profile.ApplicationIdentifierPrefix?.[0];
  if (!prefix || entitlements['application-identifier'] !== `${prefix}.${bundleId}`) throw new Error(`Provisioning profile must use the explicit bundle ID ${bundleId}.`);
  if (!(Date.parse(profile.ExpirationDate) > now)) throw new Error('Provisioning profile has expired. Create and download a new profile.');
  if (entitlements['get-task-allow'] !== false || profile.ProvisionedDevices || profile.ProvisionsAllDevices) throw new Error('Use an App Store Connect distribution profile, not Development, Ad Hoc, or Enterprise.');
  if (!profile.DeveloperCertificates?.some(cert => createHash('sha1').update(Buffer.from(cert, 'base64')).digest('hex').toUpperCase() === certificateSHA1.toUpperCase())) throw new Error('Provisioning profile does not include the imported distribution certificate.');
  return profile.UUID;
}

function xml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]); }
export function exportOptions(team, uuid, certificateSHA1) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>export</string>
<key>signingStyle</key><string>manual</string>
<key>teamID</key><string>${xml(team)}</string>
<key>signingCertificate</key><string>${xml(certificateSHA1)}</string>
<key>provisioningProfiles</key><dict><key>${bundleId}</key><string>${xml(uuid)}</string></dict>
<key>manageAppVersionAndBuildNumber</key><false/>
<key>uploadSymbols</key><true/>
</dict></plist>
`;
}

// Never include command arguments or child-process error objects in failures:
// security's import command necessarily receives the P12 password as an argument.
function run(command, args, { input, visible = false, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd: root, env, input, encoding: 'utf8', stdio: visible ? 'inherit' : 'pipe', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status ?? 'could not start'}). Check the preceding build output or the signing instructions.`);
  return result.stdout;
}

function paths(env = process.env) {
  if (process.platform !== 'darwin' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || !env.RUNNER_TEMP) throw new Error('Signing, uploading, and cleanup run only on a GitHub-hosted Mac. Use the iPhone TestFlight workflow from Windows.');
  const directory = path.join(path.resolve(env.RUNNER_TEMP), 'museamo-testflight');
  return { directory, keychain: path.join(directory, 'signing.keychain-db'), receipt: path.join(directory, 'installed-profile.json'), exportDir: path.join(directory, 'export') };
}

function readPlist(filename) {
  const code = 'import plistlib,json,sys,datetime,base64\ndef encode(x):\n if isinstance(x,datetime.datetime): return x.isoformat()+"Z"\n if isinstance(x,bytes): return base64.b64encode(x).decode()\n raise TypeError()\nwith open(sys.argv[1],"rb") as f: print(json.dumps(plistlib.load(f),default=encode))';
  return JSON.parse(run('python3', ['-c', code, filename]));
}

function build(env) {
  validateConfig(env);
  const p = paths(env);
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const commit = run('git', ['rev-parse', 'HEAD']).trim();
  validateReleaseIdentity(env, version, commit);
  mkdirSync(p.directory, { recursive: true, mode: 0o700 });
  const certificate = path.join(p.directory, 'distribution.p12');
  const profilePath = path.join(p.directory, 'distribution.mobileprovision');
  writeFileSync(certificate, decodeSecret(env.IOS_DISTRIBUTION_P12_BASE64, 'IOS_DISTRIBUTION_P12_BASE64'), { mode: 0o600 });
  writeFileSync(profilePath, decodeSecret(env.IOS_PROVISIONING_PROFILE_BASE64, 'IOS_PROVISIONING_PROFILE_BASE64'), { mode: 0o600 });
  const password = randomBytes(32).toString('hex');
  const originalKeychains = run('security', ['list-keychains', '-d', 'user']).match(/"([^"\n]+)"/g)?.map(value => value.slice(1, -1)) ?? [];
  writeFileSync(path.join(p.directory, 'keychains.json'), JSON.stringify(originalKeychains));
  run('security', ['create-keychain', '-p', password, p.keychain]);
  run('security', ['set-keychain-settings', '-lut', '21600', p.keychain]);
  run('security', ['unlock-keychain', '-p', password, p.keychain]);
  run('security', ['import', certificate, '-P', env.IOS_DISTRIBUTION_P12_PASSWORD, '-t', 'cert', '-f', 'pkcs12', '-k', p.keychain, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
  run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, p.keychain]);
  run('security', ['list-keychains', '-d', 'user', '-s', p.keychain, ...originalKeychains]);
  const identities = run('security', ['find-identity', '-v', '-p', 'codesigning', p.keychain]);
  const matches = [...identities.matchAll(/\b([A-F\d]{40})\s+"Apple Distribution:[^"\n]*"/g)];
  if (matches.length !== 1) throw new Error('The P12 must contain exactly one valid Apple Distribution identity and its private key.');
  const sha1 = matches[0][1];
  const decodedProfile = path.join(p.directory, 'profile.plist');
  writeFileSync(decodedProfile, run('security', ['cms', '-D', '-i', profilePath]), { mode: 0o600 });
  const uuid = validateProfile(readPlist(decodedProfile), env.IOS_TEAM_ID, sha1);
  const profileDir = path.join(homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles');
  mkdirSync(profileDir, { recursive: true });
  const installed = path.join(profileDir, `${uuid}.mobileprovision`);
  if (existsSync(installed)) throw new Error('A profile with this UUID is already installed; refusing to replace it.');
  // Record ownership before copying so cleanup can recover a partially failed write.
  writeFileSync(p.receipt, JSON.stringify({ uuid }));
  writeFileSync(installed, readFileSync(profilePath), { flag: 'wx', mode: 0o600 });
  const number = buildNumber(env.GITHUB_RUN_NUMBER, env.GITHUB_RUN_ATTEMPT);
  const archive = path.join(p.directory, 'Museamo.xcarchive');
  const options = path.join(p.directory, 'ExportOptions.plist');
  writeFileSync(options, exportOptions(env.IOS_TEAM_ID, uuid, sha1));
  console.log(`Building Museamo ${version} (${number}) for iPhone.`);
  run('xcodebuild', ['-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-configuration', 'Release', '-destination', 'generic/platform=iOS', '-archivePath', archive, '-derivedDataPath', path.join(p.directory, 'DerivedData'), `DEVELOPMENT_TEAM=${env.IOS_TEAM_ID}`, 'CODE_SIGN_STYLE=Manual', `CODE_SIGN_IDENTITY=${sha1}`, `PROVISIONING_PROFILE_SPECIFIER=${uuid}`, `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${number}`, 'archive'], { visible: true });
  const info = readPlist(path.join(archive, 'Products', 'Applications', 'App.app', 'Info.plist'));
  if (info.CFBundleIdentifier !== bundleId || info.CFBundleVersion !== number || info.CFBundleShortVersionString !== version) throw new Error('Archived app identity or version does not match the requested TestFlight build.');
  run(process.execPath, ['scripts/generate-ios-assets.mjs', '--verify-app', path.join(archive, 'Products', 'Applications', 'App.app')], { visible: true });
  run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportPath', p.exportDir, '-exportOptionsPlist', options], { visible: true });
  const record = { version, buildNumber: number, bundleId, commit, runId: env.GITHUB_RUN_ID };
  writeFileSync(path.join(p.directory, 'build-record.json'), JSON.stringify(record, null, 2) + '\n');
  if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, `Museamo **${version} (${number})** was signed and exported for iPhone.\n\nCommit: \`${commit}\`. Upload is a separate step; a signed artifact alone is not a TestFlight installation.\n`, { flag: 'a' });
}

function upload(env) {
  validateUploadConfig(env);
  const p = paths(env);
  const files = readdirSync(p.exportDir).filter(file => file.endsWith('.ipa'));
  if (files.length !== 1) throw new Error('Expected exactly one exported IPA.');
  const keyDirectory = path.join(p.directory, 'api-keys');
  mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(keyDirectory, `AuthKey_${env.ASC_KEY_ID}.p8`), decodeSecret(env.ASC_API_KEY_BASE64, 'ASC_API_KEY_BASE64'), { mode: 0o600 });
  const childEnv = { ...env, API_PRIVATE_KEYS_DIR: keyDirectory };
  const args = ['-f', path.join(p.exportDir, files[0]), '-t', 'ios', '--apiKey', env.ASC_KEY_ID, '--apiIssuer', env.ASC_ISSUER_ID];
  run('xcrun', ['altool', '--validate-app', ...args], { visible: true, env: childEnv });
  run('xcrun', ['altool', '--upload-app', ...args], { visible: true, env: childEnv });
  if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, '\nApple accepted the upload. Processing in **App Store Connect → Museamo → TestFlight** follows; enable automatic distribution on your internal group to deliver processed builds.\n', { flag: 'a' });
}

function cleanup(env) {
  const p = paths(env);
  if (!existsSync(p.directory)) return;
  let failed = false;
  if (existsSync(p.keychain)) {
    try { run('security', ['delete-keychain', p.keychain]); } catch { failed = true; }
  }
  const keychainsFile = path.join(p.directory, 'keychains.json');
  if (existsSync(keychainsFile)) {
    try { run('security', ['list-keychains', '-d', 'user', '-s', ...JSON.parse(readFileSync(keychainsFile, 'utf8'))]); } catch { failed = true; }
  }
  if (existsSync(p.receipt)) {
    const { uuid } = JSON.parse(readFileSync(p.receipt, 'utf8'));
    if (!/^[a-f\d-]{36}$/i.test(uuid)) throw new Error('Invalid cleanup receipt.');
    rmSync(path.join(homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles', `${uuid}.mobileprovision`), { force: true });
  }
  rmSync(p.directory, { recursive: true, force: true });
  if (failed) throw new Error('Temporary keychain cleanup failed. The GitHub-hosted runner will be destroyed when the job ends.');
  console.log('Removed this workflow’s temporary signing files and profile.');
}

export function main(command, env = process.env) {
  if (command === 'check') { validateConfig(env); console.log('TestFlight configuration is present.'); }
  else if (command === 'build') build(env);
  else if (command === 'upload') upload(env);
  else if (command === 'cleanup') cleanup(env);
  else throw new Error('Use check, build, upload, or cleanup. See docs/testflight-setup.md.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
