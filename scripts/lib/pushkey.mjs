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

// The path ends up inside double quotes in GIT_SSH_COMMAND. Git runs that string through its own POSIX sh
// (also on Windows, where it is Git for Windows' sh), so the quoting is POSIX-sh quoting only: it is not safe
// for cmd.exe or PowerShell. Characters that are special inside POSIX double quotes ($ ` \ and ") are refused,
// as are % and control or format characters. Space, ', ;, ! and # are accepted on purpose: they are literal
// inside double quotes in sh, so do not tighten or loosen this list without a test.
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

// The config file is plain data, so it is not trusted for the key type. The public file is re-read and
// re-parsed, and the private file must sit next to it. Fails closed with BAD_PUSHKEY, so a forged config
// that points at an ordinary ssh key cannot pass as a hardware key. null means "no hardware key set".
export function verifiedPushKey(home) {
  const k = readPushKey(home);
  if (!k) return null;
  const bad = (why) => new RiverwrightError('BAD_PUSHKEY', `the push key ${shown(k.publicKeyFile, 80)} is not usable (${why}); run "riverwright credential push-key set" again`);
  let text;
  try { text = readBounded(k.publicKeyFile, CAP); } catch { throw bad('the public key file is not a readable regular file'); }
  if (text === null) throw bad('the public key file is missing');
  let type;
  try { ({ type } = parsePushKey(text)); } catch { throw bad('it is not a security-key public key'); }
  if (type !== k.type) throw bad('the key type no longer matches the saved one');
  let st = null;
  try { st = fs.statSync(k.privateKeyFile); } catch { /* reported below */ }
  if (!st?.isFile()) throw bad('the private key file is missing');
  return k;
}

export function clearPushKey(home) {
  fs.rmSync(pushKeyFile(home), { force: true });
}

// The environment for one git push that must use only the security key. null means "no hardware key set".
// The command isolates ssh from the user's and the system's ssh configuration (ADR-0010 item 6: the push uses
// only the hardware key). A config file could add other identities, a ProxyCommand or a PKCS11 provider, and
// IdentitiesOnly still offers IdentityFile lines from it. Ignoring a file is not editing it, so ADR-0008 is
// respected. Cost: the owner's host aliases, ports and ProxyJump do not apply to this push, which goes
// straight to the git host. The platform is a parameter so both -F values can be tested.
export function sshPushEnv(home, { platform = process.platform } = {}) {
  const k = verifiedPushKey(home);
  if (!k) return null;
  const none = platform === 'win32' ? 'NUL' : '/dev/null';
  const opts = [
    '-o IdentityFile=none',
    `-i "${k.privateKeyFile.replace(/\\/g, '/')}"`,
    '-o IdentitiesOnly=yes',
    '-o IdentityAgent=none',
    '-o CertificateFile=none',
    '-o PKCS11Provider=none',
    '-o ProxyCommand=none',
    `-o PubkeyAcceptedAlgorithms=${SK_TYPES.join(',')}`,
  ];
  return { GIT_SSH_COMMAND: `ssh -F ${none} ${opts.join(' ')}` };
}
