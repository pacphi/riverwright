import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePushKey, readPushKey, savePushKey, clearPushKey, sshPushEnv, pushKeyFile, PUSHKEY_SCHEMA } from '../scripts/lib/pushkey.mjs';
import { callMain, tmpDir } from './helpers.mjs';

const SK = 'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIA me@laptop';
const PLAIN = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA me@laptop';

function keyFiles() {
  const dir = tmpDir('rw-sshkey-');
  const pub = path.join(dir, 'id_ed25519_sk.pub');
  fs.writeFileSync(pub, `${SK}\n`);
  fs.writeFileSync(path.join(dir, 'id_ed25519_sk'), 'not a real key handle');
  return { dir, pub, priv: path.join(dir, 'id_ed25519_sk') };
}

test('only a FIDO2 security-key public key is accepted, never an ordinary SSH key', () => {
  assert.equal(parsePushKey(SK).type, 'sk-ssh-ed25519@openssh.com');
  assert.equal(parsePushKey('sk-ecdsa-sha2-nistp256@openssh.com AAAA x').type, 'sk-ecdsa-sha2-nistp256@openssh.com');
  for (const bad of [PLAIN, '', 'garbage', 'ssh-rsa AAAA x', `${SK}\n${SK}`]) assert.throws(() => parsePushKey(bad), /security-key|FIDO2/, JSON.stringify(bad));
});

test('the config is saved under the workspace vault directory and read back', () => {
  const home = tmpDir();
  const k = keyFiles();
  assert.equal(readPushKey(home), null);
  savePushKey(home, { publicKeyFile: k.pub });
  assert.equal(pushKeyFile(home), path.join(home, 'vault', 'push-key.json'));
  assert.deepEqual(readPushKey(home), { schema: 'riverwright-pushkey/1', publicKeyFile: k.pub, privateKeyFile: k.priv, type: 'sk-ssh-ed25519@openssh.com' });
  clearPushKey(home);
  assert.equal(readPushKey(home), null);
});

test('a missing key file, a relative path or an unquotable path is refused', () => {
  const home = tmpDir();
  assert.throws(() => savePushKey(home, { publicKeyFile: path.join(tmpDir(), 'nope.pub') }), /not found|no such/i);
  assert.throws(() => savePushKey(home, { publicKeyFile: 'id_ed25519_sk.pub' }), /absolute/);
  const dir = tmpDir();
  const weird = path.join(dir, 'a$b.pub');
  fs.writeFileSync(weird, SK);
  assert.throws(() => savePushKey(home, { publicKeyFile: weird }), /quoted safely/);
  const plain = path.join(dir, 'plain.pub');
  fs.writeFileSync(plain, PLAIN);
  assert.throws(() => savePushKey(home, { publicKeyFile: plain }), /security-key/);
});

test('a missing private key file, a non-.pub name, a directory and an oversized file are refused', () => {
  const home = tmpDir();
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.pub'), SK);
  assert.throws(() => savePushKey(home, { publicKeyFile: path.join(dir, 'a.pub') }), /private key.*not found/i);
  fs.writeFileSync(path.join(dir, 'b'), SK);
  assert.throws(() => savePushKey(home, { publicKeyFile: path.join(dir, 'b') }), /\.pub/);
  fs.mkdirSync(path.join(dir, 'c.pub'));
  assert.throws(() => savePushKey(home, { publicKeyFile: path.join(dir, 'c.pub') }), /regular file|readable/);
  fs.writeFileSync(path.join(dir, 'd.pub'), `${SK}${' '.repeat(100000)}`);
  assert.throws(() => savePushKey(home, { publicKeyFile: path.join(dir, 'd.pub') }), /regular file|readable/);
  assert.equal(readPushKey(home), null);
});

test('the private key file is never read', () => {
  const home = tmpDir();
  const k = keyFiles();
  const orig = fs.readFileSync;
  const seen = [];
  fs.readFileSync = (p, ...r) => { seen.push(String(p)); return orig(p, ...r); };
  try { savePushKey(home, { publicKeyFile: k.pub }); sshPushEnv(home); } finally { fs.readFileSync = orig; }
  assert.equal(seen.includes(k.priv), false);
});

test('sshPushEnv builds an ssh command that uses only that key, and is null when none is set', () => {
  const home = tmpDir();
  assert.equal(sshPushEnv(home), null);
  const k = keyFiles();
  savePushKey(home, { publicKeyFile: k.pub });
  const env = sshPushEnv(home);
  assert.deepEqual(Object.keys(env), ['GIT_SSH_COMMAND']);
  assert.ok(env.GIT_SSH_COMMAND.startsWith('ssh '));
  assert.ok(env.GIT_SSH_COMMAND.includes(`-i "${k.priv.replace(/\\/g, '/')}"`));
  assert.match(env.GIT_SSH_COMMAND, /-o IdentitiesOnly=yes/);
  assert.match(env.GIT_SSH_COMMAND, /-o IdentityAgent=none/);
});

test('a tampered push-key file is refused rather than turned into a command', () => {
  const home = tmpDir();
  const k = keyFiles();
  savePushKey(home, { publicKeyFile: k.pub });
  const good = JSON.parse(fs.readFileSync(pushKeyFile(home), 'utf8'));
  const write = (v) => fs.writeFileSync(pushKeyFile(home), JSON.stringify(v));
  const cases = [
    { ...good, privateKeyFile: `${k.priv}" -o ProxyCommand=evil "` },
    { ...good, privateKeyFile: path.join(k.dir, 'other_key') },
    { ...good, privateKeyFile: 'relative/key' },
    { ...good, type: 'ssh-ed25519' },
    { ...good, schema: 'other/1' },
    { ...good, publicKeyFile: 5 },
  ];
  for (const c of cases) {
    write(c);
    assert.throws(() => sshPushEnv(home), /push-key|push key|quoted|absolute|match/i, JSON.stringify(c));
  }
  fs.writeFileSync(pushKeyFile(home), 'not json');
  assert.throws(() => sshPushEnv(home), /push-key/i);
  assert.equal(PUSHKEY_SCHEMA, 'riverwright-pushkey/1');
});

test('credential push-key set, show and clear work from the command line and store no secret', async () => {
  const home = tmpDir();
  const k = keyFiles();
  const run = (args) => callMain(['credential', ...args], { env: { RIVERWRIGHT_HOME: home, PATH: '' } });
  const set = await run(['push-key', 'set', k.pub]);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /touch/i);
  assert.match((await run(['push-key', 'show'])).stdout, /id_ed25519_sk/);
  assert.equal(fs.readFileSync(pushKeyFile(home), 'utf8').includes('not a real key handle'), false);
  assert.equal((await run(['push-key', 'clear'])).code, 0);
  assert.match((await run(['push-key', 'show'])).stdout, /No hardware push key/);
  assert.equal((await run(['push-key'])).code, 1);
  assert.equal((await run(['push-key', 'set'])).code, 1);
  assert.equal((await run(['push-key', 'set', k.pub, 'extra'])).code, 1);
  assert.equal((await run(['push-key', 'bogus'])).code, 1);
});

test('show prints a tampered path without control characters', async () => {
  const home = tmpDir();
  const k = keyFiles();
  savePushKey(home, { publicKeyFile: k.pub });
  const v = JSON.parse(fs.readFileSync(pushKeyFile(home), 'utf8'));
  v.publicKeyFile = `${k.pub}\x1b[2J`;
  fs.writeFileSync(pushKeyFile(home), JSON.stringify(v));
  const r = await callMain(['credential', 'push-key', 'show'], { env: { RIVERWRIGHT_HOME: home, PATH: '' } });
  assert.equal((r.stdout + r.stderr).includes('\x1b'), false);
  assert.equal(r.code, 1);
});
