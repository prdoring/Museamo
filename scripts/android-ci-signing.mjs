import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeSecret } from './ios-testflight.mjs';

export function validateAndroidSigning(env) {
  for (const name of ['MUSEAMO_KEYSTORE_BASE64', 'MUSEAMO_KEY_ALIAS', 'MUSEAMO_STORE_PASSWORD', 'MUSEAMO_KEY_PASSWORD']) {
    if (!env[name]?.trim()) throw new Error(`Missing ${name}. Configure the existing Android release key; see docs/releases.md.`);
  }
  if (!/^[a-f\d]{64}$/i.test(env.MUSEAMO_ANDROID_CERT_SHA256 || '')) throw new Error('Set MUSEAMO_ANDROID_CERT_SHA256 to the existing release certificate fingerprint.');
  return decodeSecret(env.MUSEAMO_KEYSTORE_BASE64, 'MUSEAMO_KEYSTORE_BASE64');
}

export function main(command, env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || !env.RUNNER_TEMP) throw new Error('Android CI credentials require a GitHub-hosted runner.');
  const directory = path.join(path.resolve(env.RUNNER_TEMP), 'museamo-android-signing');
  if (command === 'cleanup') { rmSync(directory, { recursive: true, force: true }); return; }
  if (command !== 'restore') throw new Error('Use restore or cleanup.');
  const keystore = validateAndroidSigning(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'release.p12');
  writeFileSync(filename, keystore, { mode: 0o600, flag: 'wx' });
  appendFileSync(env.GITHUB_ENV, `MUSEAMO_KEYSTORE=${filename}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
