// The sealed credential vault (ADR-0010). One file holds the GitHub token and an Ed25519 signing key,
// encrypted under a key derived from the human's passphrase. The agent can read the file but cannot open it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';
import { readTextIfExists, writeFileAtomic } from './fsx.mjs';

export const VAULT_SCHEMA = 'riverwright-vault/1';
export const MIN_PASSPHRASE = 12;
export const vaultFile = (home) => path.join(home, 'vault', 'vault.json');

// OWASP Password Storage cheat sheet: Argon2id at 46 MiB or more with t=1, p=1; scrypt N=2^17, r=8, p=1.
// We use more than the floor because an unlock is rare and human-paced.
export function defaultKdf({ hasArgon2 = typeof crypto.argon2Sync === 'function' } = {}) {
  return hasArgon2
    ? { name: 'argon2id', memory: 65536, passes: 3, parallelism: 1 }
    : { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 };
}

const LIMITS = {
  argon2id: { memory: [8, 2 ** 19], passes: [1, 10], parallelism: [1, 4] },
  scrypt: { N: [2 ** 10, 2 ** 20], r: [1, 16], p: [1, 4] },
};

// Bounds and the memory cap handed to scrypt must agree, or a legal-looking vault fails inside Node.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const scryptBytes = (kdf) => 128 * kdf.r * (kdf.N + kdf.p + 2);

// The weakest kdf sealVault will create (OWASP Password Storage cheat sheet). Opening accepts less, for old files and tests.
const FLOOR = {
  argon2id: { memory: 46 * 1024, passes: 1, parallelism: 1 },
  scrypt: { N: 2 ** 17, r: 8, p: 1 },
};

const OWN = (v, k) => Object.prototype.hasOwnProperty.call(v, k);

function checkKdf(kdf) {
  const limits = OWN(LIMITS, kdf?.name) ? LIMITS[kdf.name] : null;
  if (!limits) throw new RiverwrightError('BAD_VAULT', 'unsupported kdf in the vault');
  for (const [key, [lo, hi]] of Object.entries(limits)) {
    if (!Number.isInteger(kdf[key]) || kdf[key] < lo || kdf[key] > hi) {
      throw new RiverwrightError('BAD_VAULT', `kdf parameters out of range in the vault (${key})`);
    }
  }
  if (kdf.name === 'scrypt' && scryptBytes(kdf) > SCRYPT_MAXMEM) {
    throw new RiverwrightError('BAD_VAULT', 'kdf parameters out of range in the vault (scrypt memory)');
  }
}

function checkFloor(kdf) {
  for (const [key, min] of Object.entries(FLOOR[kdf.name])) {
    if (kdf[key] < min) throw new RiverwrightError('WEAK_KDF', `the key derivation is weaker than the minimum (${key})`);
  }
}

const causeOf = (e) => (typeof e?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(e.code) ? e.code : (e?.constructor?.name ?? 'Error'));

export function deriveKey(passphrase, kdf, salt) {
  checkKdf(kdf);
  const message = Buffer.from(String(passphrase).normalize('NFKC'), 'utf8');
  try {
    if (kdf.name === 'argon2id') {
      if (typeof crypto.argon2Sync !== 'function') {
        throw new RiverwrightError('VAULT_KDF_UNAVAILABLE', 'this vault uses argon2id, which needs Node 24.7 or newer; the passphrase was not tried');
      }
      return crypto.argon2Sync('argon2id', { message, nonce: salt, parallelism: kdf.parallelism, tagLength: 32, memory: kdf.memory, passes: kdf.passes });
    }
    return crypto.scryptSync(message, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM });
  } catch (e) {
    if (e instanceof RiverwrightError) throw e;
    throw new RiverwrightError('VAULT_KDF_UNAVAILABLE', `the key derivation could not run (${causeOf(e)}); the passphrase was not tried`);
  }
}

const canonical = (x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`
  : JSON.stringify(x));

// The header is authenticated: changing the kdf, the salt or the public key makes decryption fail.
// Keys are sorted, so the file may be re-serialised in any key order.
const aadOf = (v) => Buffer.from(canonical({ schema: v.schema, kdf: v.kdf, publicKey: v.publicKey }), 'utf8');

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;

export function fingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `sha256:${crypto.createHash('sha256').update(der).digest('hex')}`;
}

export function checkPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || [...passphrase.normalize('NFKC')].length < MIN_PASSPHRASE) {
    throw new RiverwrightError('WEAK_PASSPHRASE', `the passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
}

export function checkToken(token) {
  if (typeof token !== 'string' || !/^[!-~]{8,4096}$/.test(token)) {
    throw new RiverwrightError('BAD_TOKEN', 'the token must be 8 to 4096 printable characters with no spaces');
  }
}

// allowWeakKdfForTests lets tests use small parameters. The command line must never pass it.
export function sealVault({ token, passphrase, kdf = defaultKdf(), now = null, allowWeakKdfForTests = false }) {
  checkPassphrase(passphrase);
  checkToken(token);
  checkKdf(kdf);
  if (allowWeakKdfForTests !== true) checkFloor(kdf);
  const salt = crypto.randomBytes(SALT_LEN);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const header = {
    schema: VAULT_SCHEMA,
    kdf: { ...kdf, salt: salt.toString('base64') },
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  };
  const nonce = crypto.randomBytes(NONCE_LEN);
  const key = deriveKey(passphrase, header.kdf, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(aadOf(header));
  const plain = JSON.stringify({ token, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    ...header,
    cipher: 'aes-256-gcm',
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    createdAt: now,
  };
}

export function openVault(vault, passphrase) {
  validateVault(vault);
  // Key derivation is outside the try: only a GCM authentication failure may mean "wrong passphrase".
  const key = deriveKey(passphrase, vault.kdf, Buffer.from(vault.kdf.salt, 'base64'));
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(vault.nonce, 'base64'), { authTagLength: TAG_LEN });
    decipher.setAAD(aadOf(vault));
    decipher.setAuthTag(Buffer.from(vault.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(vault.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new RiverwrightError('BAD_PASSPHRASE', 'the passphrase did not open the vault');
  }
  const { token, privateKey } = JSON.parse(plain);
  return { token, privateKey: crypto.createPrivateKey(privateKey), publicKey: vault.publicKey };
}

export function validateVault(v) {
  if (v?.schema !== VAULT_SCHEMA) throw new RiverwrightError('BAD_VAULT', 'this is not a Riverwright vault');
  for (const key of ['nonce', 'ciphertext', 'tag', 'publicKey']) {
    if (typeof v[key] !== 'string' || !v[key]) throw new RiverwrightError('BAD_VAULT', `the vault is missing "${key}"`);
  }
  if (v.cipher !== 'aes-256-gcm') throw new RiverwrightError('BAD_VAULT', 'unsupported cipher in the vault');
  if (typeof v.kdf?.salt !== 'string') throw new RiverwrightError('BAD_VAULT', 'the vault is missing its salt');
  for (const [label, value, min, exact] of [['salt', v.kdf.salt, SALT_LEN, false], ['nonce', v.nonce, NONCE_LEN, true], ['tag', v.tag, TAG_LEN, true]]) {
    const raw = Buffer.from(value, 'base64');
    if (raw.toString('base64') !== value || (exact ? raw.length !== min : raw.length < min)) {
      throw new RiverwrightError('BAD_VAULT', `the vault has a malformed ${label}`);
    }
  }
  checkKdf(v.kdf);
  // Printed by "credential status" from a file the agent can edit, so it must be a plain timestamp or absent.
  if (v.createdAt !== undefined && v.createdAt !== null && !(typeof v.createdAt === 'string' && ISO_UTC.test(v.createdAt))) {
    throw new RiverwrightError('BAD_VAULT', 'the vault has a malformed creation time');
  }
  try {
    fingerprint(v.publicKey);
  } catch {
    throw new RiverwrightError('BAD_VAULT', 'the vault has a malformed public key');
  }
  return v;
}

export function readVault(home) {
  const text = readTextIfExists(vaultFile(home));
  if (text === null) {
    throw new RiverwrightError('NO_VAULT', `no sealed credential yet: run "riverwright credential setup" in a terminal (looked in ${vaultFile(home)})`);
  }
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    throw new RiverwrightError('BAD_VAULT', `${vaultFile(home)} is not valid JSON`);
  }
  return validateVault(v);
}

export function writeVault(home, vault, { replace = false } = {}) {
  validateVault(vault);
  const file = vaultFile(home);
  if (!replace && fs.existsSync(file)) {
    throw new RiverwrightError('VAULT_EXISTS', `a sealed credential already exists at ${file}; pass --replace to overwrite it`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, `${JSON.stringify(vault, null, 2)}\n`, { mode: 0o600 });
}
