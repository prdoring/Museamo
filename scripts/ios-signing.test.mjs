import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { assertPassword, createRequest, findOpenSSL, packageCertificate } from './ios-signing.mjs';

test('signing passwords support spaces but reject empty, short, or incompatible text', () => {
  assert.doesNotThrow(() => assertPassword('test only strong password'));
  for (const value of ['', 'short', 'password\nwith newline', 'nonascii password \u00e9']) assert.throws(() => assertPassword(value));
});

test('Windows-compatible CSR and P12 flow preserves keys and rejects mismatched certificates', () => {
  const openssl = findOpenSSL();
  const directory = mkdtempSync(path.join(tmpdir(), 'museamo-ios-signing-test-'));
  const passphrase = 'test only passphrase';
  try {
    const csr = createRequest({ openssl, destination: directory, passphrase });
    const encrypted = readFileSync(path.join(directory, 'distribution.key.pem'));
    assert.throws(() => createPrivateKey(encrypted));
    const privateKey = createPrivateKey({ key: encrypted, passphrase });
    assert.equal(privateKey.asymmetricKeyType, 'rsa');
    assert.equal(spawnSync(openssl, ['req', '-in', csr, '-verify', '-noout']).status, 0);
    assert.throws(() => createRequest({ openssl, destination: directory, passphrase }), /already exists/);
    const cert = path.join(directory, 'test.cer');
    const fixtureRequest = path.join(directory, 'test-distribution.csr');
    const fixtureKey = path.join(directory, 'test-only.key.pem');
    writeFileSync(fixtureKey, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const keyOptions = ['-key', fixtureKey];
    const fixtureOptions = { input: `${passphrase}\n` };
    // Apple's LibreSSL x509 lacks -subj; put the fixture subject in a CSR
    // using req, which supports this on both Windows OpenSSL and macOS.
    const requestResult = spawnSync(openssl, ['req', '-new', ...keyOptions, '-subj', '/CN=Apple Distribution: Test Only (ABCDE12345)', '-out', fixtureRequest], fixtureOptions);
    assert.equal(requestResult.status, 0, requestResult.stderr?.toString());
    const result = spawnSync(openssl, ['x509', '-req', '-in', fixtureRequest, '-signkey', fixtureKey, '-days', '1', '-outform', 'DER', '-out', cert]);
    assert.equal(result.status, 0, result.stderr?.toString());
    const p12 = packageCertificate({ openssl, destination: directory, certificatePath: cert, passphrase });
    assert.equal(spawnSync(openssl, ['pkcs12', '-in', p12, '-noout', '-passin', 'stdin'], fixtureOptions).status, 0);
    assert.throws(() => packageCertificate({ openssl, destination: directory, certificatePath: cert, passphrase }), /already exists/);
    rmSync(p12);
    const other = path.join(directory, 'other');
    createRequest({ openssl, destination: other, passphrase });
    assert.throws(() => packageCertificate({ openssl, destination: other, certificatePath: cert, passphrase }), /different private key/);
    writeFileSync(cert, 'invalid certificate');
    assert.throws(() => packageCertificate({ openssl, destination: directory, certificatePath: cert, passphrase }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
