import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VAULT_SCHEMA, defaultKdf, fingerprint, openVault, readVault, sealVault, vaultFile, writeVault } from '../scripts/lib/vault.mjs';
import { tmpDir } from './helpers.mjs';

const TOKEN = 'ghp_exampleTokenValue0123456789abcdefghij';
const PASS = 'correct horse battery staple';
// Tests use small parameters so they run fast, through the test-only allowWeakKdfForTests flag. The command line never passes a kdf or the flag, so real vaults use defaultKdf().
const FAST = { name: 'argon2id', memory: 8, passes: 1, parallelism: 1 };
const FAST_SCRYPT = { name: 'scrypt', N: 1024, r: 8, p: 1 };

test('a sealed vault opens with the passphrase and returns the token and a working signing key', () => {
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST, allowWeakKdfForTests: true });
  assert.equal(vault.schema, VAULT_SCHEMA);
  const opened = openVault(vault, PASS);
  assert.equal(opened.token, TOKEN);
  const sig = crypto.sign(null, Buffer.from('m'), opened.privateKey);
  assert.equal(crypto.verify(null, Buffer.from('m'), vault.publicKey, sig), true);
});

test('the scrypt fallback seals and opens the same way', () => {
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST_SCRYPT, allowWeakKdfForTests: true });
  assert.equal(vault.kdf.name, 'scrypt');
  assert.equal(openVault(vault, PASS).token, TOKEN);
});

test('the token never appears in the vault text, in clear or as base64', () => {
  const text = JSON.stringify(sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST, allowWeakKdfForTests: true }));
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes(Buffer.from(TOKEN).toString('base64')), false);
  assert.equal(text.includes('PRIVATE KEY'), false);
});

test('a wrong passphrase releases nothing and the error does not say why', () => {
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST, allowWeakKdfForTests: true });
  assert.throws(() => openVault(vault, 'not the passphrase'), (e) => e.code === 'BAD_PASSPHRASE' && !/token/i.test(e.message));
});

test('changing any header field breaks decryption, so the parameters cannot be downgraded', () => {
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST, allowWeakKdfForTests: true });
  const weaker = { ...vault, kdf: { ...vault.kdf, passes: 2 } };
  assert.throws(() => openVault(weaker, PASS), /BAD_PASSPHRASE|did not open/);
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => openVault({ ...vault, publicKey: other }, PASS), /did not open/);
});

test('a short passphrase and a token with spaces or control characters are refused', () => {
  assert.throws(() => sealVault({ token: TOKEN, passphrase: 'short', kdf: FAST, allowWeakKdfForTests: true }), /at least 12/);
  for (const bad of ['', 'has space', 'tab\there', 'line\nbreak', 'x'.repeat(5000), 'abc']) {
    assert.throws(() => sealVault({ token: bad, passphrase: PASS, kdf: FAST, allowWeakKdfForTests: true }), /token/i, JSON.stringify(bad.slice(0, 12)));
  }
});

test('the default parameters meet the OWASP minimum, with a scrypt fallback when argon2 is missing', () => {
  const a = defaultKdf({ hasArgon2: true });
  assert.equal(a.name, 'argon2id');
  assert.ok(a.memory >= 47104 && a.passes >= 1 && a.parallelism >= 1);
  const s = defaultKdf({ hasArgon2: false });
  assert.deepEqual([s.name, s.N >= 2 ** 17, s.r, s.p], ['scrypt', true, 8, 1]);
});

test('hostile parameters in a vault file are refused before any key is derived', () => {
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST, allowWeakKdfForTests: true });
  for (const kdf of [{ ...vault.kdf, memory: 2 ** 30 }, { ...vault.kdf, passes: 1000 }, { ...vault.kdf, name: 'md5' }]) {
    assert.throws(() => openVault({ ...vault, kdf }, PASS), /kdf|parameters/i);
  }
});

test('writeVault stores one file under the workspace home, readable only by the owner, and refuses to replace it silently', () => {
  const home = tmpDir();
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST, allowWeakKdfForTests: true });
  writeVault(home, vault);
  assert.equal(vaultFile(home), path.join(home, 'vault', 'vault.json'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(vaultFile(home)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(vaultFile(home))).mode & 0o777, 0o700);
  }
  assert.deepEqual(readVault(home), vault);
  assert.throws(() => writeVault(home, vault), /already exists/);
  writeVault(home, vault, { replace: true });
});

test('readVault reports a missing or malformed vault plainly', () => {
  const home = tmpDir();
  assert.throws(() => readVault(home), (e) => e.code === 'NO_VAULT' && /credential setup/.test(e.message));
  fs.mkdirSync(path.dirname(vaultFile(home)), { recursive: true });
  fs.writeFileSync(vaultFile(home), '{"schema":"other/1"}');
  assert.throws(() => readVault(home), /not a Riverwright vault/);
});

test('the fingerprint is a stable sha256 of the public key', () => {
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST, allowWeakKdfForTests: true });
  assert.match(fingerprint(vault.publicKey), /^sha256:[0-9a-f]{64}$/);
  assert.equal(fingerprint(vault.publicKey), fingerprint(vault.publicKey));
});

const SEAL = (extra = {}) => sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST, allowWeakKdfForTests: true, ...extra });

test('sealVault refuses a kdf below the OWASP floor unless the test-only flag is passed', () => {
  for (const kdf of [FAST, { ...FAST, memory: 47103 }, FAST_SCRYPT, { name: 'scrypt', N: 2 ** 16, r: 8, p: 1 }, { name: 'scrypt', N: 2 ** 17, r: 4, p: 1 }]) {
    assert.throws(() => sealVault({ token: TOKEN, passphrase: PASS, kdf }), (e) => e.code === 'WEAK_KDF', JSON.stringify(kdf));
  }
  const atFloor = sealVault({ token: TOKEN, passphrase: PASS, kdf: { name: 'argon2id', memory: 47104, passes: 1, parallelism: 1 } });
  assert.equal(openVault(atFloor, PASS).token, TOKEN);
});

test('a kdf that cannot run is a Riverwright error at seal time, not a raw Node error', () => {
  for (const kdf of [{ name: 'scrypt', N: 2 ** 20, r: 16, p: 1 }, { name: 'scrypt', N: 2 ** 17, r: 16, p: 1 }]) {
    assert.throws(() => sealVault({ token: TOKEN, passphrase: PASS, kdf, allowWeakKdfForTests: true }), (e) => e.name === 'RiverwrightError' && e.code === 'BAD_VAULT');
  }
});

test('scrypt parameters that would exceed the memory cap are refused as bad vaults, not as a wrong passphrase', () => {
  const vault = SEAL({ kdf: FAST_SCRYPT });
  const hostile = { ...vault, kdf: { ...vault.kdf, N: 2 ** 20, r: 16 } };
  assert.throws(() => openVault(hostile, PASS), (e) => e.code === 'BAD_VAULT');
});

test('a missing argon2 on this Node is reported as an unavailable kdf, never as a wrong passphrase', () => {
  const vault = SEAL();
  const saved = crypto.argon2Sync;
  crypto.argon2Sync = undefined;
  try {
    assert.throws(() => openVault(vault, PASS), (e) => e.code === 'VAULT_KDF_UNAVAILABLE' && !/passphrase did not/.test(e.message) && !e.message.includes(PASS));
  } finally {
    crypto.argon2Sync = saved;
  }
});

test('an unexpected error while deriving the key surfaces as VAULT_KDF_UNAVAILABLE naming the cause class', () => {
  const vault = SEAL();
  const saved = crypto.argon2Sync;
  crypto.argon2Sync = () => { throw new TypeError('boom'); };
  try {
    assert.throws(() => openVault(vault, PASS), (e) => e.code === 'VAULT_KDF_UNAVAILABLE' && /TypeError/.test(e.message) && !e.message.includes(PASS));
  } finally {
    crypto.argon2Sync = saved;
  }
});

test('an unsupported kdf name is not echoed in the error message', () => {
  const vault = SEAL();
  const evil = '\u001b[31mevil';
  assert.throws(() => openVault({ ...vault, kdf: { ...vault.kdf, name: evil } }, PASS), (e) => e.code === 'BAD_VAULT' && !e.message.includes('evil'));
});

test('tampering with the salt, or giving salt, nonce or tag a wrong length, is refused', () => {
  const vault = SEAL();
  const salt = Buffer.from(vault.kdf.salt, 'base64');
  salt[0] ^= 1;
  assert.throws(() => openVault({ ...vault, kdf: { ...vault.kdf, salt: salt.toString('base64') } }, PASS), (e) => e.code === 'BAD_PASSPHRASE');
  assert.throws(() => openVault({ ...vault, kdf: { ...vault.kdf, salt: Buffer.alloc(8).toString('base64') } }, PASS), (e) => e.code === 'BAD_VAULT');
  assert.throws(() => openVault({ ...vault, nonce: Buffer.alloc(8).toString('base64') }, PASS), (e) => e.code === 'BAD_VAULT');
  assert.throws(() => openVault({ ...vault, tag: Buffer.alloc(8).toString('base64') }, PASS), (e) => e.code === 'BAD_VAULT');
});

test('every seal uses a fresh salt and nonce', () => {
  const a = SEAL();
  const b = SEAL();
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.nonce, b.nonce);
});

test('the authenticated header does not depend on the order of keys in the file', () => {
  const vault = SEAL();
  const reordered = { ...vault, kdf: Object.fromEntries(Object.entries(vault.kdf).reverse()) };
  assert.equal(openVault(reordered, PASS).token, TOKEN);
});
