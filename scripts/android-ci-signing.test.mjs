import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, validateAndroidSigning } from './android-ci-signing.mjs';
import { configurationOptions } from './release-configure-ci.mjs';

test('backup configuration accepts direct Node flags and paths forwarded by PowerShell npm', () => {
  const filename = path.resolve('../museamo-signing-backup.p12');
  assert.deepEqual(configurationOptions([]), {});
  assert.deepEqual(configurationOptions(['--keystore', filename]), { keystore: filename, alias: 'museamo-release' });
  assert.deepEqual(configurationOptions([filename]), { keystore: filename, alias: 'museamo-release' });
  assert.deepEqual(configurationOptions(['--keystore', filename, '--alias', 'original']), { keystore: filename, alias: 'original' });
  for (const args of [['--keystore'], ['--invalid'], [filename, '--alias'], [filename, 'unexpected']]) assert.throws(() => configurationOptions(args), /Use --keystore/);
});

const config = () => ({ MUSEAMO_KEYSTORE_BASE64: 'YWJj', MUSEAMO_KEY_ALIAS: 'original', MUSEAMO_STORE_PASSWORD: 'secret-store', MUSEAMO_KEY_PASSWORD: 'secret-key', MUSEAMO_ANDROID_CERT_SHA256: 'a'.repeat(64) });
test('Android CI requires complete original identity and a pinned certificate', () => {
  assert.equal(validateAndroidSigning(config()).toString(), 'abc');
  for (const name of Object.keys(config())) {
    const env = config(); delete env[name];
    assert.throws(() => validateAndroidSigning(env), new RegExp(name));
  }
  assert.throws(() => validateAndroidSigning({ ...config(), MUSEAMO_KEYSTORE_BASE64: 'invalid!' }), /Base64/);
  assert.throws(() => main('restore', config()), /GitHub-hosted runner/);
});
test('temporary Android credentials are removed after partial failure without touching other files', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'museamo-ci-signing-test-'));
  try {
    const env = { ...config(), GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: directory, GITHUB_ENV: path.join(directory, 'env') };
    main('restore', env);
    assert.equal(readFileSync(path.join(directory, 'museamo-android-signing/release.p12'), 'utf8'), 'abc');
    assert.doesNotMatch(readFileSync(env.GITHUB_ENV, 'utf8'), /secret-store|secret-key/);
    assert.throws(() => main('restore', env), /EEXIST/);
    main('cleanup', env);
    assert.equal(existsSync(path.join(directory, 'museamo-android-signing')), false);
    assert.equal(existsSync(env.GITHUB_ENV), true);
    main('cleanup', env);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
