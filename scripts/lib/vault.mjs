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

function checkKdf(kdf) {
  const limits = LIMITS[kdf?.name];
  if (!limits) throw new RiverwrightError('BAD_VAULT', `unsupported kdf "${kdf?.name}" in the vault`);
  for (const [key, [lo, hi]] of Object.entries(limits)) {
    if (!Number.isInteger(kdf[key]) || kdf[key] < lo || kdf[key] > hi) {
      throw new RiverwrightError('BAD_VAULT', `kdf parameters out of range in the vault (${key})`);
    }
  }
}

export function deriveKey(passphrase, kdf, salt) {
  checkKdf(kdf);
  const message = Buffer.from(String(passphrase).normalize('NFKC'), 'utf8');
  if (kdf.name === 'argon2id') {
    return crypto.argon2Sync('argon2id', { message, nonce: salt, parallelism: kdf.parallelism, tagLength: 32, memory: kdf.memory, passes: kdf.passes });
  }
  return crypto.scryptSync(message, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

// The header is authenticated: changing the kdf, the salt or the public key makes decryption fail.
const aadOf = (v) => Buffer.from(JSON.stringify({ schema: v.schema, kdf: v.kdf, publicKey: v.publicKey }), 'utf8');

export function fingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `sha256:${crypto.createHash('sha256').update(der).digest('hex')}`;
}

export function sealVault({ token, passphrase, kdf = defaultKdf(), now = null }) {
  if (typeof passphrase !== 'string' || [...passphrase.normalize('NFKC')].length < MIN_PASSPHRASE) {
    throw new RiverwrightError('WEAK_PASSPHRASE', `the passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  if (typeof token !== 'string' || !/^[!-~]{8,4096}$/.test(token)) {
    throw new RiverwrightError('BAD_TOKEN', 'the token must be 8 to 4096 printable characters with no spaces');
  }
  const salt = crypto.randomBytes(16);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const header = {
    schema: VAULT_SCHEMA,
    kdf: { ...kdf, salt: salt.toString('base64') },
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  };
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, header.kdf, salt), nonce);
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
  const salt = Buffer.from(vault.kdf.salt, 'base64');
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, vault.kdf, salt), Buffer.from(vault.nonce, 'base64'));
    decipher.setAAD(aadOf(vault));
    decipher.setAuthTag(Buffer.from(vault.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(vault.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    if (e instanceof RiverwrightError) throw e;
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
  checkKdf(v.kdf);
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
