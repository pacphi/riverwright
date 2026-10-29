import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { auditAmbient } from '../scripts/lib/ambient.mjs';
import { tmpDir } from './helpers.mjs';

const SECRET = 'ghp_thisValueMustNeverBePrinted0123456789';
// A fake runner: it answers by program and arguments and records nothing else.
const runner = (answers) => async (file, args) => {
  const key = `${file} ${args.join(' ')}`;
  for (const [needle, result] of Object.entries(answers)) if (key.startsWith(needle)) return { code: 0, stdout: '', stderr: '', error: null, ...result };
  return { code: null, stdout: '', stderr: '', error: 'not-found' };
};
const audit = (over = {}) => auditAmbient({ env: {}, userHome: tmpDir(), run: runner({}), ...over });
const ids = (f) => f.map((x) => x.id).sort();

test('a clean machine has no findings', async () => {
  assert.deepEqual(await audit(), []);
});

test('token variables are reported by name only, never by value, and empty ones are ignored', async () => {
  const findings = await audit({ env: { GH_TOKEN: SECRET, GITHUB_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: 'x', PATH: '/bin' } });
  assert.deepEqual(ids(findings), ['env:GH_TOKEN', 'env:GITHUB_ENTERPRISE_TOKEN']);
  assert.equal(JSON.stringify(findings).includes(SECRET), false);
});

test('a logged-in gh is reported from its exit status alone; its output is never read', async () => {
  const findings = await audit({ run: runner({ 'gh auth status': { code: 0, stdout: `Logged in, token: ${SECRET}`, stderr: SECRET } }) });
  assert.deepEqual(ids(findings), ['gh-login']);
  assert.equal(JSON.stringify(findings).includes(SECRET), false);
  assert.deepEqual(await audit({ run: runner({ 'gh auth status': { code: 1 } }) }), []);
});

test('git credential helpers are reported by their name, without arguments', async () => {
  const findings = await audit({ run: runner({ 'git config --global --get-all credential.helper': { stdout: `osxkeychain\nstore --file=/home/me/.tokens-${SECRET}\n!f() { echo ${SECRET}; }; f\n` } }) });
  assert.deepEqual(ids(findings), ['git-helper:custom', 'git-helper:osxkeychain', 'git-helper:store']);
  assert.equal(JSON.stringify(findings).includes(SECRET), false);
  assert.equal(JSON.stringify(findings).includes('.tokens'), false);
});

test('loaded SSH keys are counted, and private key files are listed by file name only', async () => {
  const userHome = tmpDir();
  fs.mkdirSync(path.join(userHome, '.ssh'));
  for (const f of ['id_ed25519', 'id_ed25519.pub', 'known_hosts', 'config']) fs.writeFileSync(path.join(userHome, '.ssh', f), SECRET);
  const findings = await audit({ userHome, run: runner({ 'ssh-add -l': { stdout: `256 SHA256:${SECRET} me (ED25519)\n256 SHA256:abc other (ED25519)\n` } }) });
  assert.deepEqual(ids(findings), ['ssh-agent', 'ssh-key-file:id_ed25519']);
  assert.match(findings.find((f) => f.id === 'ssh-agent').what, /2 keys/);
  assert.equal(JSON.stringify(findings).includes(SECRET), false);
});

test('a gh config file is reported by presence, not read', async () => {
  const userHome = tmpDir();
  fs.mkdirSync(path.join(userHome, '.config', 'gh'), { recursive: true });
  fs.writeFileSync(path.join(userHome, '.config', 'gh', 'hosts.yml'), `oauth_token: ${SECRET}\n`);
  const findings = await audit({ userHome });
  assert.deepEqual(ids(findings), ['gh-config']);
  assert.equal(JSON.stringify(findings).includes(SECRET), false);
});

test('every finding explains what it means and what to do', async () => {
  const findings = await audit({ env: { GH_TOKEN: SECRET } });
  for (const f of findings) assert.ok(f.what && f.why && f.fix, f.id);
});
