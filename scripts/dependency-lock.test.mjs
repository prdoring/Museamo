import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('committed dependencies support npm ci in an empty checkout without the local installation', () => {
  assert.ok(process.env.npm_execpath, 'Run this check through npm run test:release.');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = mkdtempSync(path.join(tmpdir(), 'museamo-lock-test-'));
  try {
    for (const filename of ['package.json', 'package-lock.json']) copyFileSync(path.join(root, filename), path.join(directory, filename));
    const config = path.join(directory, 'empty.npmrc');
    writeFileSync(config, '');
    const result = spawnSync(process.execPath, [process.env.npm_execpath, 'ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', config, '--globalconfig', path.join(directory, 'global.npmrc'), '--cache', path.join(directory, 'cache')], {
      cwd: directory, encoding: 'utf8', timeout: 60000, env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
    });
    assert.equal(result.status, 0, `Clean-checkout dependency validation failed:\n${result.stderr || result.error?.message || result.stdout}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
