import { spawnSync } from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { validateUploadConfig } from './ios-testflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.tools', 'ios-signing');
const repository = 'prdoring/Museamo';

export function findOpenSSL(env = process.env) {
  const candidates = [env.MUSEAMO_OPENSSL, ...(process.platform === 'win32' ? [path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'openssl.exe')] : []), 'openssl'].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['version'], { encoding: 'utf8', windowsHide: true });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error('OpenSSL was not found. On Windows, install Git for Windows, or set MUSEAMO_OPENSSL to your OpenSSL executable.');
}

function run(command, args, { input, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd: root, input, env, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  // Do not print child-process error objects, arguments, passwords, or files.
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed. Check your file selections, password, or GitHub login and try again.`);
  return result.stdout;
}

async function question(label) {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await reader.question(`${label}: `)).trim(); } finally { reader.close(); }
}

export async function password(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run this helper in your own interactive terminal. Passwords are entered privately, never in command arguments or chat.');
  process.stdout.write(`${label} (hidden): `);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = '';
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      process.stdin.removeListener('data', receive);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
      value = '';
    };
    const receive = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') { finish(new Error('Cancelled.')); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ' && char !== '\u001b') value += char;
      }
    };
    process.stdin.on('data', receive);
  });
}

export function assertPassword(value) {
  if (value.length < 12 || value.length > 128 || !/^[\x20-\x7e]+$/.test(value)) throw new Error('Use a password of 12–128 printable ASCII characters; spaces are supported. Save it in your password manager.');
}

export function createRequest({ openssl, destination, passphrase }) {
  assertPassword(passphrase);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const key = path.join(destination, 'distribution.key.pem');
  const csr = path.join(destination, 'distribution.certSigningRequest');
  if (existsSync(key) || existsSync(csr)) throw new Error('A signing request or key already exists. Keep the existing files; do not replace a key used by an Apple certificate.');
  const config = path.join(destination, 'request.cnf');
  writeFileSync(config, '[req]\nprompt=no\ndistinguished_name=identity\n[identity]\nCN=Museamo Distribution\n', { mode: 0o600 });
  try {
    run(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-sha256', '-keyout', key, '-out', csr, '-config', config, '-passout', 'env:MUSEAMO_IOS_KEY_PASSWORD'], { env: { ...process.env, MUSEAMO_IOS_KEY_PASSWORD: passphrase } });
  } finally { rmSync(config, { force: true }); }
  return csr;
}

export function packageCertificate({ openssl, destination, certificatePath, passphrase }) {
  assertPassword(passphrase);
  const keyPath = path.join(destination, 'distribution.key.pem');
  const p12 = path.join(destination, 'distribution.p12');
  if (existsSync(p12)) throw new Error('distribution.p12 already exists. Keep it; this helper will not overwrite it.');
  const certificate = new X509Certificate(readFileSync(certificatePath));
  if (!certificate.subject.split('\n').some(line => line.startsWith('CN=Apple Distribution:'))) throw new Error('Download an Apple Distribution certificate, not Apple Development or Developer ID.');
  if (!(Date.parse(certificate.validTo) > Date.now())) throw new Error('This distribution certificate has expired.');
  const key = createPrivateKey({ key: readFileSync(keyPath), passphrase });
  if (!certificate.checkPrivateKey(key)) throw new Error('This certificate belongs to a different private key. Download the certificate issued for this signing request.');
  const pem = path.join(destination, 'distribution.certificate.pem');
  writeFileSync(pem, certificate.toString(), { mode: 0o600 });
  try {
    // Explicit algorithms remain compatible with Apple's security import tool.
    run(openssl, ['pkcs12', '-export', '-inkey', keyPath, '-in', pem, '-out', p12, '-name', 'Museamo Apple Distribution', '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1', '-passin', 'env:MUSEAMO_IOS_KEY_PASSWORD', '-passout', 'env:MUSEAMO_IOS_KEY_PASSWORD'], { env: { ...process.env, MUSEAMO_IOS_KEY_PASSWORD: passphrase } });
  } finally { rmSync(pem, { force: true }); }
  return p12;
}

function selectedPath(value) { return path.resolve(value.replace(/^"(.*)"$/, '$1')); }

async function configure() {
  console.log(`This sends signing credentials to encrypted GitHub Actions secrets for ${repository}. It does not upload an app to Apple.`);
  run('gh', ['repo', 'view', repository, '--json', 'nameWithOwner']);
  const team = await question('Apple Team ID (10 characters)');
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error('Enter the Apple Team ID from developer.apple.com/account membership details.');
  const p12 = readFileSync(path.join(directory, 'distribution.p12'));
  const profile = readFileSync(selectedPath(await question('Full path to the downloaded App Store Connect .mobileprovision file')));
  const apiKey = readFileSync(selectedPath(await question('Full path to AuthKey_KEYID.p8')));
  const keyId = await question('App Store Connect team API Key ID (10 characters)');
  const issuerId = await question('App Store Connect Issuer ID (UUID)');
  const apiEnv = { ASC_API_KEY_BASE64: apiKey.toString('base64'), ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuerId };
  validateUploadConfig(apiEnv);
  const passphrase = await password('Signing key/P12 password');
  assertPassword(passphrase);
  run(findOpenSSL(), ['pkcs12', '-in', path.join(directory, 'distribution.p12'), '-noout', '-passin', 'env:MUSEAMO_IOS_KEY_PASSWORD'], { env: { ...process.env, MUSEAMO_IOS_KEY_PASSWORD: passphrase } });
  // Use standard input; secret bodies are never command arguments or output.
  const secrets = { IOS_DISTRIBUTION_P12_BASE64: p12.toString('base64'), IOS_DISTRIBUTION_P12_PASSWORD: passphrase, IOS_PROVISIONING_PROFILE_BASE64: profile.toString('base64'), ...apiEnv };
  for (const [name, value] of Object.entries(secrets)) {
    run('gh', ['secret', 'set', name, '--repo', repository], { input: value });
    console.log(`Saved ${name}.`);
  }
  run('gh', ['variable', 'set', 'IOS_TEAM_ID', '--repo', repository, '--body', team]);
  console.log('Saved IOS_TEAM_ID. GitHub signing configuration is ready. The first Mac build will verify the profile and certificate match.');
}

async function main(command) {
  if (command === 'request') {
    const passphrase = await password('Choose a signing key password');
    assertPassword(passphrase);
    if (passphrase !== await password('Repeat that password')) throw new Error('Passwords did not match. Nothing was created.');
    const csr = createRequest({ openssl: findOpenSSL(), destination: directory, passphrase });
    console.log(`Created the Apple certificate request:\n${csr}\n\nUpload only that request to Apple. Keep distribution.key.pem and your password for the next step.`);
  } else if (command === 'package') {
    const certificatePath = selectedPath(await question('Full path to the Apple Distribution .cer file'));
    const passphrase = await password('Signing key password chosen during request');
    console.log(`Created ${packageCertificate({ openssl: findOpenSSL(), destination: directory, certificatePath, passphrase })}\nThe P12 uses the same password as your signing key.`);
  } else if (command === 'configure') await configure();
  else console.log('Use npm run ios:signing -- request, package, or configure. Follow docs/testflight-setup.md.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
