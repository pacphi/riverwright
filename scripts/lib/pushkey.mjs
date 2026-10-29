// Optional hardware push key (ADR-0010, tier 2). A FIDO2 security-key SSH key ("sk-" type) may sign the push
// only: the private key never leaves the hardware, so a same-user agent cannot sign without a touch.
// Pull requests and comments still use the sealed token. This module only records which key to use and builds
// the ssh command; it never reads a private key file, it cannot check that the key was made with
// "-O verify-required", and it cannot be tested without a security key in hand (owner check, Task 16).
import fs from 'node:fs';
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';
import { readBounded, writeFileAtomic } from './fsx.mjs';
import { shown } from './printable.mjs';

export const PUSHKEY_SCHEMA = 'riverwright-pushkey/1';
export const SK_TYPES = ['sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'];
export const pushKeyFile = (home) => path.join(home, 'vault', 'push-key.json');

const CAP = 8192; // a public key line, or this config file, is far smaller

export function parsePushKey(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const type = lines.length === 1 ? lines[0].split(/\s+/)[0] : null;
  if (!SK_TYPES.includes(type)) {
    throw new RiverwrightError('NOT_SK_KEY', `this is not a FIDO2 security-key public key (expected ${SK_TYPES.join(' or ')}). Create one with: ssh-keygen -t ed25519-sk -O verify-required`);
  }
  return { type };
}

// The path ends up inside double quotes in GIT_SSH_COMMAND, which git hands to a shell.
function assertQuotable(p) {
  if (typeof p !== 'string' || !(path.posix.isAbsolute(p) || path.win32.isAbsolute(p))) throw new RiverwrightError('UNSAFE_PATH', 'the key path must be absolute');
  const posix = path.posix.isAbsolute(p);
  if (/["$`%\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(posix ? p : p.replace(/\\/g, '/'))) throw new RiverwrightError('UNSAFE_PATH', `path ${shown(p, 80)} cannot be quoted safely in every shell`);
}

const privateOf = (pub) => (pub.endsWith('.pub') ? pub.slice(0, -4) : null);

export function savePushKey(home, { publicKeyFile }) {
  assertQuotable(publicKeyFile);
  const privateKeyFile = privateOf(publicKeyFile);
  if (!privateKeyFile) throw new RiverwrightError('BAD_KEY_NAME', 'name the public key file (it ends in .pub)');
  assertQuotable(privateKeyFile);
  let text;
  try {
    text = readBounded(publicKeyFile, CAP);
  } catch {
    throw new RiverwrightError('BAD_KEY_FILE', `${shown(publicKeyFile, 80)} is not a readable regular file of at most ${CAP} bytes`);
  }
  if (text === null) throw new RiverwrightError('NO_KEY_FILE', `key file not found: ${shown(publicKeyFile, 80)}`);
  const { type } = parsePushKey(text);
  // Existence only; the private key's contents are never read.
  let st = null;
  try { st = fs.statSync(privateKeyFile); } catch { /* reported below */ }
  if (!st?.isFile()) throw new RiverwrightError('NO_KEY_FILE', `the private key file was not found next to the public key: ${shown(privateKeyFile, 80)}`);
  fs.mkdirSync(path.dirname(pushKeyFile(home)), { recursive: true, mode: 0o700 });
  writeFileAtomic(pushKeyFile(home), `${JSON.stringify({ schema: PUSHKEY_SCHEMA, publicKeyFile, privateKeyFile, type }, null, 2)}\n`, { mode: 0o600 });
}

// The file is plain data an agent could edit, so every field is checked again on read.
export function readPushKey(home) {
  const file = pushKeyFile(home);
  let text;
  try {
    text = readBounded(file, CAP);
  } catch {
    throw new RiverwrightError('BAD_PUSHKEY', `${shown(file, 80)} is not a readable push-key file`);
  }
  if (text === null) return null;
  let v;
  try { v = JSON.parse(text); } catch { throw new RiverwrightError('BAD_PUSHKEY', `${shown(file, 80)} is not valid JSON (the push-key file)`); }
  const bad = (why) => new RiverwrightError('BAD_PUSHKEY', `${shown(file, 80)} is not a valid push-key file (${why}); run "riverwright credential push-key set" again`);
  if (!v || typeof v !== 'object' || v.schema !== PUSHKEY_SCHEMA) throw bad('schema');
  if (!SK_TYPES.includes(v.type)) throw bad('type');
  try { assertQuotable(v.publicKeyFile); assertQuotable(v.privateKeyFile); } catch (e) { throw bad(e.message); }
  if (v.privateKeyFile !== privateOf(v.publicKeyFile)) throw bad('the private key does not match the public key');
  return { schema: v.schema, publicKeyFile: v.publicKeyFile, privateKeyFile: v.privateKeyFile, type: v.type };
}

export function clearPushKey(home) {
  fs.rmSync(pushKeyFile(home), { force: true });
}

// The environment for one git push that must use only the security key. null means "no hardware key set".
export function sshPushEnv(home) {
  const k = readPushKey(home);
  if (!k) return null;
  return { GIT_SSH_COMMAND: `ssh -i "${k.privateKeyFile.replace(/\\/g, '/')}" -o IdentitiesOnly=yes -o IdentityAgent=none` };
}
