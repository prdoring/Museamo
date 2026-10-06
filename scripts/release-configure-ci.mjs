import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { X509Certificate } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureSigning } from './release-signing.mjs';
import { password } from './ios-signing.mjs';

// This opt-in command transfers the existing identity directly to Actions secrets.
// No secret values are printed or included in command arguments.
const repository = 'prdoring/Museamo';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed. Check authentication, signing access, and Android SDK configuration.`);
  return result.stdout;
}

export function configurationOptions(argv) {
  const args = [...argv];
  if (!args.length) return {};
  if (args[0] === '--keystore') args.shift();
  const keystore = args.shift();
  if (!keystore || keystore.startsWith('-') || (args.length && (args.length !== 2 || args[0] !== '--alias' || !args[1] || args[1].startsWith('-')))) throw new Error('Use --keystore PATH [--alias ALIAS], a positional PATH, or no arguments for the saved identity.');
  return { keystore: path.resolve(keystore), alias: args[1] || 'museamo-release' };
}

export async function configure(argv = process.argv.slice(2)) {
  const options = configurationOptions(argv);
  run('gh', ['auth', 'status']);
  if (options.keystore) {
    process.env.MUSEAMO_KEYSTORE = options.keystore;
    process.env.MUSEAMO_KEY_ALIAS = options.alias;
    const passphrase = await password('Portable Android backup password');
    process.env.MUSEAMO_STORE_PASSWORD = passphrase;
    process.env.MUSEAMO_KEY_PASSWORD = passphrase;
  } else {
    await configureSigning();
  }
  const keytool = [process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'keytool.exe'), 'C:/Program Files/Android/Android Studio/jbr/bin/keytool.exe'].filter(Boolean).find(existsSync);
  if (!keytool) throw new Error('Set JAVA_HOME to the JDK used by Android builds.');
  run(keytool, ['-certreq', '-keystore', process.env.MUSEAMO_KEYSTORE, '-alias', process.env.MUSEAMO_KEY_ALIAS, '-storepass:env', 'MUSEAMO_STORE_PASSWORD', '-keypass:env', 'MUSEAMO_KEY_PASSWORD']);
  const certificate = run(keytool, ['-exportcert', '-keystore', process.env.MUSEAMO_KEYSTORE, '-alias', process.env.MUSEAMO_KEY_ALIAS, '-storepass:env', 'MUSEAMO_STORE_PASSWORD'], { encoding: null });
  const fingerprint = new X509Certificate(certificate).fingerprint256.replaceAll(':', '').toLowerCase();
  const sdk = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA, 'Android/Sdk');
  const tools = path.join(sdk, 'build-tools/36.0.0');
  if (!existsSync(path.join(tools, 'apksigner.bat'))) throw new Error('Set ANDROID_HOME to an SDK containing build-tools 36.0.0.');
  const temporary = mkdtempSync(path.join(tmpdir(), 'museamo-ci-key-check-'));
  try {
    run('gh', ['release', 'download', 'v0.4.0', '--repo', repository, '--pattern', 'Museamo-0.4.0-android.apk', '--dir', temporary]);
    const apk = path.join(temporary, 'Museamo-0.4.0-android.apk');
    const verification = run('cmd.exe', ['/d', '/c', 'apksigner.bat', 'verify', '--print-certs', apk], { cwd: tools });
    const matches = [...verification.matchAll(/Signer #\d+ certificate SHA-256 digest: ([a-f\d]{64})/gi)];
    if (matches.length !== 1 || matches[0][1].toLowerCase() !== fingerprint) throw new Error('Existing keystore does not match the published Android APK. Restore the original key.');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  const values = {
    MUSEAMO_KEYSTORE_BASE64: readFileSync(process.env.MUSEAMO_KEYSTORE).toString('base64'),
    MUSEAMO_KEY_ALIAS: process.env.MUSEAMO_KEY_ALIAS,
    MUSEAMO_STORE_PASSWORD: process.env.MUSEAMO_STORE_PASSWORD,
    MUSEAMO_KEY_PASSWORD: process.env.MUSEAMO_KEY_PASSWORD,
  };
  for (const [name, value] of Object.entries(values)) {
    run('gh', ['secret', 'set', name, '--repo', repository], { input: value });
    console.log(`Configured ${name}.`);
  }
  run('gh', ['variable', 'set', 'MUSEAMO_ANDROID_CERT_SHA256', '--repo', repository, '--body', fingerprint]);
  console.log('Configured the existing published Android signing identity for automatic releases.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await configure(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
