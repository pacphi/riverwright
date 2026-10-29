import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { auditAmbient, helperKind, resolveProgram } from '../scripts/lib/ambient.mjs';
import { tmpDir } from './helpers.mjs';

const SECRET = 'ghp_thisValueMustNeverBePrinted0123456789';
const GH = 'gh auth status';
const GIT = 'git config --show-origin --get-regexp ^credential\\..*helper$';
const SSH = 'ssh-add -l';
// A fake runner: it answers by program and arguments. A call it has no answer for is "not installed".
const runner = (answers, calls = []) => async (file, args, opts) => {
  calls.push({ file, args, opts });
  const key = `${file} ${args.join(' ')}`;
  for (const [needle, result] of Object.entries(answers)) if (key === needle) return { code: 0, stdout: '', stderr: '', error: null, ...result };
  return { code: null, stdout: '', stderr: '', error: 'not-found' };
};
// Every probe answers "nothing here": gh not logged in, no helpers, no agent identities.
const CLEAN = { [GH]: { code: 1 }, [GIT]: { code: 1 }, [SSH]: { code: 1 } };
const audit = (over = {}, answers = {}) => auditAmbient({ env: {}, userHome: tmpDir(), platform: 'linux', run: runner({ ...CLEAN, ...answers }), ...over });
const ids = (f) => f.map((x) => x.id).sort();
const noSecret = (f) => assert.equal(JSON.stringify(f).includes(SECRET), false);
const gitOut = (...lines) => ({ stdout: lines.map((l) => `file:/home/me/.gitconfig\t${l}\n`).join('') });

test('a clean machine has no findings', async () => {
  assert.deepEqual(await audit(), []);
});

test('token variables are reported by name only, never by value, and empty ones are ignored', async () => {
  const findings = await audit({ env: { GH_TOKEN: SECRET, GITHUB_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: 'x', PATH: '/bin' } });
  assert.deepEqual(ids(findings), ['env:GH_TOKEN', 'env:GITHUB_ENTERPRISE_TOKEN']);
  noSecret(findings);
});

test('a probe that cannot tell reports "unchecked", never silence', async () => {
  const findings = await auditAmbient({ env: {}, userHome: tmpDir(), platform: 'linux', run: runner({}) });
  assert.deepEqual(ids(findings), ['unchecked:gh', 'unchecked:git-config', 'unchecked:ssh-add']);
  for (const f of findings) assert.match(f.why, /not a sign that you are safe/);
});

test('gh: success is a login, exit 1 is not logged in, timeout and other codes are unchecked', async () => {
  const f0 = await audit({}, { [GH]: { code: 0, stdout: `token: ${SECRET}`, stderr: SECRET } });
  assert.deepEqual(ids(f0), ['gh-login']);
  noSecret(f0);
  assert.deepEqual(await audit({}, { [GH]: { code: 1, stderr: SECRET } }), []);
  assert.deepEqual(ids(await audit({}, { [GH]: { code: null, error: 'timeout' } })), ['unchecked:gh']);
  assert.deepEqual(ids(await audit({}, { [GH]: { code: 4 } })), ['unchecked:gh']);
  assert.deepEqual(ids(await audit({}, { [GH]: { code: null, error: 'not-found' } })), ['unchecked:gh']);
  assert.match((await audit({}, { [GH]: { code: null, error: 'timeout' } }))[0].what, /did not answer in time/);
});

test('only the four fixed programs and argument lists are run, with the injected env and a timeout', async () => {
  const calls = [];
  const env = { PATH: '/bin' };
  await auditAmbient({ env, userHome: tmpDir(), platform: 'linux', run: runner(CLEAN, calls) });
  assert.deepEqual(calls.map((c) => [c.file, c.args]), [
    ['gh', ['auth', 'status']],
    ['git', ['config', '--show-origin', '--get-regexp', '^credential\\..*helper$']],
    ['ssh-add', ['-l']],
  ]);
  for (const c of calls) {
    assert.equal(c.opts.env, env);
    assert.ok(c.opts.timeoutMs > 0 && c.opts.timeoutMs <= 10000);
  }
});

test('git helpers: every scope and URL-scoped keys, reported by kind only', async () => {
  const findings = await audit({}, {
    [GIT]: gitOut(
      'credential.helper osxkeychain',
      `credential.https://github.com.helper store --file=/home/me/.tokens-${SECRET}`,
      `credential.https://me:${SECRET}@github.com.helper !f() { echo ${SECRET}; }; f`,
      'credential.https://github.com.helper !gh auth git-credential',
      'credential.helper !/opt/homebrew/bin/gh auth git-credential',
      'credential.helper',
      'credential.helper ',
    ),
  });
  assert.deepEqual(ids(findings), ['git-helper:custom', 'git-helper:gh', 'git-helper:osxkeychain', 'git-helper:store']);
  noSecret(findings);
  assert.equal(JSON.stringify(findings).includes('.tokens'), false);
});

test('helperKind names what a helper is without trusting paths or arguments', () => {
  assert.equal(helperKind('osxkeychain'), 'osxkeychain');
  assert.equal(helperKind('/usr/libexec/git-core/git-credential-osxkeychain'), 'osxkeychain');
  assert.equal(helperKind('"C:/Program Files/Git/mingw64/bin/git-credential-manager.exe"'), 'manager');
  assert.equal(helperKind('!gh auth git-credential'), 'gh');
  assert.equal(helperKind('!gh something-else'), 'custom');
  assert.equal(helperKind('/tmp/evil/store'), 'custom');
  assert.equal(helperKind('!store'), 'custom');
  assert.equal(helperKind('https://me:tok@example.com/h'), 'custom');
  assert.equal(helperKind(''), null);
});

test('git: exit 1 means none configured; a failure or timeout is unchecked', async () => {
  assert.deepEqual(await audit({}, { [GIT]: { code: 1 } }), []);
  assert.deepEqual(ids(await audit({}, { [GIT]: { code: 128 } })), ['unchecked:git-config']);
  assert.deepEqual(ids(await audit({}, { [GIT]: { code: null, error: 'timeout' } })), ['unchecked:git-config']);
});

test('ssh-add: keys are counted; exit 1 and 2 are answers; failures are unchecked', async () => {
  const findings = await audit({}, { [SSH]: { stdout: `256 SHA256:${SECRET} me (ED25519)\n256 SHA256:abc other (ED25519)\n` } });
  assert.deepEqual(ids(findings), ['ssh-agent']);
  assert.match(findings[0].what, /2 keys/);
  assert.match(findings[0].fix, /forward/);
  noSecret(findings);
  assert.deepEqual(await audit({}, { [SSH]: { code: 1 } }), []);
  assert.deepEqual(await audit({}, { [SSH]: { code: 2 } }), []);
  assert.deepEqual(ids(await audit({}, { [SSH]: { code: null, error: 'timeout' } })), ['unchecked:ssh-add']);
});

const keyFile = (dir, name, first, body = SECRET) => fs.writeFileSync(path.join(dir, '.ssh', name), `${first}\n${body}\n`);

test('private key files are found by their first line, whatever the name, and only the name is reported', async () => {
  const userHome = tmpDir();
  fs.mkdirSync(path.join(userHome, '.ssh'));
  keyFile(userHome, 'id_ed25519', '-----BEGIN OPENSSH PRIVATE KEY-----');
  keyFile(userHome, 'github_ed25519', '-----BEGIN OPENSSH PRIVATE KEY-----');
  keyFile(userHome, 'work.pem', '-----BEGIN RSA PRIVATE KEY-----');
  keyFile(userHome, 'putty.ppk', 'PuTTY-User-Key-File-3: ssh-ed25519');
  keyFile(userHome, 'weird name', '-----BEGIN PRIVATE KEY-----');
  keyFile(userHome, 'id_ed25519.pub', 'ssh-ed25519 AAAA me@host', '');
  keyFile(userHome, 'known_hosts', SECRET);
  keyFile(userHome, 'config', 'Host *');
  fs.mkdirSync(path.join(userHome, '.ssh', 'id_dir'));
  const findings = await audit({ userHome });
  assert.deepEqual(ids(findings), ['ssh-key-file:github_ed25519', 'ssh-key-file:id_ed25519', 'ssh-key-file:putty.ppk', 'ssh-key-file:unusual-name-1', 'ssh-key-file:work.pem']);
  noSecret(findings);
  assert.equal(JSON.stringify(findings).includes('weird name'), false);
});

test('an unreadable ~/.ssh or key file is "unchecked", a missing one is not', async () => {
  const noSsh = tmpDir();
  assert.deepEqual(await audit({ userHome: noSsh }), []);
  const fileAsDir = tmpDir();
  fs.writeFileSync(path.join(fileAsDir, '.ssh'), 'x');
  assert.deepEqual(ids(await audit({ userHome: fileAsDir })), ['unchecked:ssh-dir']);
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const home = tmpDir();
    fs.mkdirSync(path.join(home, '.ssh'));
    keyFile(home, 'locked', '-----BEGIN OPENSSH PRIVATE KEY-----');
    fs.chmodSync(path.join(home, '.ssh', 'locked'), 0);
    assert.deepEqual(ids(await audit({ userHome: home })), ['unchecked:ssh-key-files']);
  }
});

test('omitting userHome uses the home directory instead of skipping the file checks', async () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.ssh'));
  keyFile(home, 'id_rsa', '-----BEGIN RSA PRIVATE KEY-----');
  const findings = await auditAmbient({ env: {}, platform: 'linux', homedir: () => home, run: runner(CLEAN) });
  assert.deepEqual(ids(findings), ['ssh-key-file:id_rsa']);
});

test('a gh config file is found where gh keeps it, by presence only', async () => {
  const write = (...parts) => { const f = path.join(...parts, 'hosts.yml'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `oauth_token: ${SECRET}\n`); };
  const a = tmpDir(); write(a, '.config', 'gh');
  const fa = await audit({ userHome: a });
  assert.deepEqual(ids(fa), ['gh-config']);
  noSecret(fa);
  const b = tmpDir(); const dirB = path.join(tmpDir(), 'custom'); write(dirB);
  assert.deepEqual(ids(await audit({ userHome: b, env: { GH_CONFIG_DIR: dirB } })), ['gh-config']);
  const xdg = tmpDir(); write(xdg, 'gh');
  assert.deepEqual(ids(await audit({ userHome: tmpDir(), env: { XDG_CONFIG_HOME: xdg } })), ['gh-config']);
  const appData = tmpDir(); write(appData, 'GitHub CLI');
  assert.deepEqual(ids(await audit({ userHome: tmpDir(), platform: 'win32', env: { AppData: appData, PATH: '' } }, { })), ['gh-config', 'unchecked:gh', 'unchecked:git-config', 'unchecked:ssh-add']);
});

test('on Windows programs are found on an absolute PATH only, never in the current directory', async () => {
  const bin = tmpDir();
  fs.writeFileSync(path.join(bin, 'gh.exe'), '');
  const seen = [];
  const env = { PATH: `;.;relative;${bin}` };
  assert.equal(resolveProgram('gh', { env, platform: 'win32', exists: (p) => p === path.win32.join(bin, 'gh.exe') }), path.win32.join(bin, 'gh.exe'));
  assert.equal(resolveProgram('git', { env: { PATH: '.' }, platform: 'win32', exists: () => true }), null);
  assert.equal(resolveProgram('git', { env: {}, platform: 'linux' }), 'git');
  const findings = await auditAmbient({ env: { PATH: '.' }, userHome: tmpDir(), platform: 'win32', run: async (f) => { seen.push(f); return { code: 1, stdout: '', stderr: '', error: null }; } });
  assert.deepEqual(seen, []);
  assert.deepEqual(ids(findings), ['unchecked:gh', 'unchecked:git-config', 'unchecked:ssh-add']);
});

test('every finding explains what it means and what to do, without over-claiming', async () => {
  const userHome = tmpDir();
  fs.mkdirSync(path.join(userHome, '.ssh'));
  keyFile(userHome, 'id_ed25519', '-----BEGIN OPENSSH PRIVATE KEY-----');
  const findings = await audit({ env: { GH_TOKEN: SECRET }, userHome }, { [GH]: { code: 0 }, [GIT]: gitOut('credential.helper store'), [SSH]: { stdout: 'a\n' } });
  assert.ok(findings.length >= 5);
  for (const f of findings) assert.ok(f.what && f.why && f.fix, f.id);
  assert.equal(findings.some((f) => /can use it to publish without Riverwright/.test(f.why)), false);
});
