import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callMain, fakeSecretTerminal, tmpDir } from './helpers.mjs';
import { readVault, openVault, vaultFile, fingerprint } from '../scripts/lib/vault.mjs';
import { RiverwrightError } from '../scripts/lib/errors.mjs';
import { FAST_KDF, PASSPHRASE, TOKEN } from './receipt-helpers.mjs';

// Test hygiene (Task 17): "credential status" runs the ambient audit in the account's home (os.userInfo().homedir,
// which HOME does not change), so it would read the real ~/.ssh. Every call here passes the userInfo seam with an empty
// scratch home, and os.userInfo itself throws while this file runs: a call that skips the seam fails instead.
const realUserInfo = os.userInfo;
before(() => { os.userInfo = () => { throw new Error('a test read the real account home (os.userInfo) without the seam'); }; });
after(() => { os.userInfo = realUserInfo; });
const scratchAccount = () => ({ homedir: tmpDir('rw-account-') });
// R41: the vault always lives in the account home, <account>/.riverwright. newHome() makes a scratch account and returns
// its workspace; RIVERWRIGHT_HOME points somewhere else on purpose, so any code that follows it writes the wrong place.
const accounts = new Map();
const newHome = () => {
  const account = tmpDir('rw-account-');
  const home = path.join(account, '.riverwright');
  accounts.set(home, account);
  return home;
};
const acct = (home) => () => ({ homedir: accounts.get(home) });
const cred = (home, args, opts = {}) => callMain(['credential', ...args], { env: { RIVERWRIGHT_HOME: tmpDir('rw-other-'), PATH: '' }, testing: { now: '2026-10-02T14:03:11.000Z', kdf: FAST_KDF, userInfo: acct(home) }, ...opts });
const noTerminal = () => { throw new RiverwrightError('NO_TTY', 'Terminal approval needs a real terminal.'); };
const leaks = (r, t) => [TOKEN, PASSPHRASE].some((s) => r.stdout.includes(s) || r.stderr.includes(s) || (t?.written ?? []).join('').includes(s));

test('credential setup seals the token and prints only the public-key fingerprint', async () => {
  const home = newHome();
  const t = fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]);
  const r = await cred(home, ['setup'], { terminal: t });
  assert.equal(r.code, 0, r.stderr);
  const vault = readVault(home);
  assert.equal(openVault(vault, PASSPHRASE).token, TOKEN);
  assert.equal(vault.createdAt, '2026-10-02T14:03:11.000Z');
  assert.ok(r.stdout.includes(fingerprint(vault.publicKey)));
  assert.equal(leaks(r, t), false);
  assert.match(r.stdout, /never into a chat/i);
});

test('setup refuses mismatched or short passphrases and writes nothing, leaking nothing', async () => {
  const home = newHome();
  const t1 = fakeSecretTerminal([TOKEN, PASSPHRASE, `${PASSPHRASE}x`]);
  const mismatch = await cred(home, ['setup'], { terminal: t1 });
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /did not match/);
  assert.equal(leaks(mismatch, t1) || mismatch.stderr.includes(`${PASSPHRASE}x`), false);
  const t2 = fakeSecretTerminal([TOKEN, 'short', 'short']);
  const short = await cred(home, ['setup'], { terminal: t2 });
  assert.equal(short.code, 1);
  assert.match(short.stderr, /at least 12/);
  assert.equal(leaks(short, t2), false);
  assert.equal(fs.existsSync(vaultFile(home)), false);
});

test('setup refuses a malformed token without echoing it', async () => {
  const home = newHome();
  const bad = 'has a space in it';
  const t = fakeSecretTerminal([bad, PASSPHRASE, PASSPHRASE]);
  const r = await cred(home, ['setup'], { terminal: t });
  assert.equal(r.code, 1);
  assert.equal(r.stderr.includes(bad) || r.stdout.includes(bad) || t.written.join('').includes(bad), false);
  assert.equal(fs.existsSync(vaultFile(home)), false);
});

test('setup needs a real terminal and takes no secret from arguments or the environment', async () => {
  const home = newHome();
  const none = await cred(home, ['setup'], { terminal: noTerminal });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /real terminal/);
  const viaArg = await cred(home, ['setup', '--token', TOKEN], { terminal: fakeSecretTerminal([]) });
  assert.equal(viaArg.code, 1);
  assert.equal(leaks(viaArg), false);
  const viaPositional = await cred(home, ['setup', TOKEN], { terminal: fakeSecretTerminal([]) });
  assert.equal(viaPositional.code, 1);
  assert.equal(leaks(viaPositional), false);
  const viaEnv = await callMain(['credential', 'setup'], { env: { RIVERWRIGHT_HOME: tmpDir('rw-other-'), GH_TOKEN: TOKEN, RIVERWRIGHT_PASSPHRASE: PASSPHRASE }, testing: { kdf: FAST_KDF, userInfo: acct(home) }, terminal: noTerminal });
  assert.equal(viaEnv.code, 1);
  assert.equal(leaks(viaEnv), false);
  assert.equal(fs.existsSync(vaultFile(home)), false);
});

test('setup refuses a terminal that cannot hide typing', async () => {
  const home = newHome();
  const t = fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]);
  t.noEcho = false;
  const r = await cred(home, ['setup'], { terminal: t });
  assert.equal(r.code, 1);
  assert.equal(leaks(r, t), false);
  assert.equal(fs.existsSync(vaultFile(home)), false);
});

test('without the test seam, setup seals with the production key-derivation floor', async () => {
  const home = newHome();
  const r = await callMain(['credential', 'setup'], { env: { RIVERWRIGHT_HOME: tmpDir('rw-other-'), PATH: '' }, testing: { userInfo: acct(home) }, terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) });
  assert.equal(r.code, 0, r.stderr);
  const { kdf } = readVault(home);
  if (kdf.name === 'argon2id') assert.ok(kdf.memory >= 47104);
  else assert.ok(kdf.N >= 2 ** 17);
});

test('an existing vault is not replaced without --replace, and the refusal comes before any prompt', async () => {
  const home = newHome();
  await cred(home, ['setup'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) });
  const before = fs.readFileSync(vaultFile(home), 'utf8');
  const t = fakeSecretTerminal([]);
  const r = await cred(home, ['setup'], { terminal: t });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--replace/);
  assert.equal(t.written.join(''), '');
  assert.equal(fs.readFileSync(vaultFile(home), 'utf8'), before);
  const replaced = await cred(home, ['setup', '--replace'], { terminal: fakeSecretTerminal(['ghp_anotherTokenValue0123456789', PASSPHRASE, PASSPHRASE]) });
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.equal(openVault(readVault(home), PASSPHRASE).token, 'ghp_anotherTokenValue0123456789');
});

test('a failed --replace leaves the old vault untouched', async () => {
  const home = newHome();
  await cred(home, ['setup'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) });
  const before = fs.readFileSync(vaultFile(home), 'utf8');
  const r = await cred(home, ['setup', '--replace'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, 'different passphrase']) });
  assert.equal(r.code, 1);
  assert.equal(fs.readFileSync(vaultFile(home), 'utf8'), before);
});

test('credential status shows the fingerprint and no secret, and says so when there is no vault', async () => {
  const home = newHome();
  const none = await cred(home, ['status']);
  assert.equal(none.code, 0);
  assert.match(none.stdout, /No sealed credential/);
  await cred(home, ['setup'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) });
  const r = await cred(home, ['status']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(fingerprint(readVault(home).publicKey)));
  assert.match(r.stdout, /argon2id|scrypt/);
  assert.equal(leaks(r), false);
});

test('credential status lists ambient credential routes and never their values', async () => {
  const home = newHome();
  const r = await callMain(['credential', 'status'], { env: { RIVERWRIGHT_HOME: tmpDir('rw-other-'), GH_TOKEN: TOKEN, PATH: '' }, testing: { kdf: FAST_KDF, userInfo: scratchAccount } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /GH_TOKEN/);
  assert.match(r.stdout, /without Riverwright/);
  assert.equal(r.stdout.includes(TOKEN), false);
});

test('test hygiene: credential status audits the account home the userInfo seam gives, never the real one', async () => {
  const account = tmpDir('rw-account-');
  fs.mkdirSync(path.join(account, '.ssh'));
  fs.writeFileSync(path.join(account, '.ssh', 'id_seamtest'), '-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n');
  const r = await callMain(['credential', 'status'], { env: { RIVERWRIGHT_HOME: tmpDir(), PATH: '' }, testing: { userInfo: () => ({ homedir: account }) } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /id_seamtest/);
});

test('credential remove deletes the vault only after "remove" is typed at the terminal', async () => {
  const home = newHome();
  await cred(home, ['setup'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) });
  const wrong = await cred(home, ['remove'], { terminal: fakeSecretTerminal(['no']) });
  assert.equal(wrong.code, 1);
  assert.equal(fs.existsSync(vaultFile(home)), true);
  const noTty = await cred(home, ['remove'], { terminal: noTerminal });
  assert.equal(noTty.code, 1);
  assert.equal(fs.existsSync(vaultFile(home)), true);
  const ok = await cred(home, ['remove'], { terminal: fakeSecretTerminal(['remove']) });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(fs.existsSync(vaultFile(home)), false);
});

test('credential remove with no vault, and unknown subcommands, exit 1', async () => {
  const home = newHome();
  assert.equal((await cred(home, ['remove'], { terminal: fakeSecretTerminal(['remove']) })).code, 1);
  assert.equal((await cred(home, ['bogus'])).code, 1);
  assert.equal((await cred(home, [])).code, 1);
});

// ---- Fix round 1 ----
const setupVault = async (home) => { await cred(home, ['setup'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) }); };
const tamper = (home, edit) => { const f = vaultFile(home); const v = JSON.parse(fs.readFileSync(f, 'utf8')); edit(v); fs.writeFileSync(f, JSON.stringify(v)); };
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

test('I1: a vault with escape sequences and a forged fingerprint cannot spoof status output', async () => {
  const home = newHome();
  await setupVault(home);
  const real = fingerprint(readVault(home).publicKey);
  tamper(home, (v) => { v.createdAt = 'x\x1b[2J\x1b[1;1H\x9bFingerprint: sha256:deadbeef'; });
  const bad = await cred(home, ['status']);
  assert.equal(bad.code, 1);
  assert.equal(RAW_CONTROL.test(bad.stdout + bad.stderr), false);
  tamper(home, (v) => { v.createdAt = '2026-10-02T14:03:11.000Z'; v.kdf.name = 'argon2id\x1b[2J\nFingerprint: sha256:deadbeef'; });
  const r = await cred(home, ['status']);
  assert.equal(RAW_CONTROL.test(r.stdout.replace(/\n/g, '') + r.stderr), false);
  assert.equal(r.stdout.includes('\x1b'), false);
  assert.equal(r.stdout.includes('deadbeef'), false);
});

test('I1: the real fingerprint is the last line of status', async () => {
  const home = newHome();
  await setupVault(home);
  const real = fingerprint(readVault(home).publicKey);
  const r = await cred(home, ['status']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.at(-1), `Public-key fingerprint: ${real}`);
  assert.equal(lines.filter((l) => l.startsWith('Public-key fingerprint:')).length, 1);
});

test('I1: createdAt must be a strict ISO-8601 UTC string', () => {
  const home = newHome();
  return setupVault(home).then(() => {
    for (const bad of ['yesterday', '2026-10-02 14:03:11', '2026-10-02T14:03:11+02:00', 5]) {
      tamper(home, (v) => { v.createdAt = bad; });
      assert.throws(() => readVault(home), (e) => e.code === 'BAD_VAULT');
    }
    tamper(home, (v) => { delete v.createdAt; });
    assert.doesNotThrow(() => readVault(home));
  });
});

test('M1: a malformed publicKey gives a Riverwright error, not a stack trace', async () => {
  const home = newHome();
  await setupVault(home);
  tamper(home, (v) => { v.publicKey = 'garbage'; });
  const r = await cred(home, ['status']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /public key|vault/i);
  assert.equal(/\bat .*\.mjs|DECODER|unexpected error/.test(r.stderr), false);
});

test('M2: a bad token is refused before the passphrase is asked for', async () => {
  const home = newHome();
  const t = fakeSecretTerminal(['has a space in it', PASSPHRASE, PASSPHRASE]);
  const r = await cred(home, ['setup'], { terminal: t });
  assert.equal(r.code, 1);
  assert.equal(t.written.join('').includes('New passphrase'), false);
  const t2 = fakeSecretTerminal([TOKEN, 'short']);
  const r2 = await cred(home, ['setup'], { terminal: t2 });
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /at least 12/);
  assert.equal(t2.written.join('').includes('again'), false);
});

test('M3: --replace shows the fingerprint of the vault being replaced, sanitized', async () => {
  const home = newHome();
  await setupVault(home);
  const old = fingerprint(readVault(home).publicKey);
  const r = await cred(home, ['setup', '--replace'], { terminal: fakeSecretTerminal(['ghp_anotherTokenValue0123456789', PASSPHRASE, PASSPHRASE]) });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`Replacing the sealed credential with fingerprint ${old}`));
  const home2 = newHome();
  await setupVault(home2);
  tamper(home2, (v) => { v.publicKey = 'garbage\x1b[2J'; });
  const r2 = await cred(home2, ['setup', '--replace'], { terminal: fakeSecretTerminal(['ghp_anotherTokenValue0123456789', PASSPHRASE, PASSPHRASE]) });
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(r2.stdout.includes('\x1b'), false);
});

test('M5: flags that do not belong to the subcommand get the fixed usage message', async () => {
  const home = newHome();
  await setupVault(home);
  for (const args of [['status', '--replace'], ['remove', '--replace'], ['status', 'extra']]) {
    const r = await cred(home, args, { terminal: fakeSecretTerminal(['remove']) });
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /usage: riverwright credential/);
    assert.equal(fs.existsSync(vaultFile(home)), true);
  }
});

test('M7: vault file is 0600, its directory 0700, and no temp file is left behind', { skip: process.platform === 'win32' }, async () => {
  const home = newHome();
  await setupVault(home);
  const dir = path.dirname(vaultFile(home));
  assert.equal(fs.statSync(vaultFile(home)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(dir), ['vault.json']);
  await cred(home, ['setup', '--replace'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, 'different passphrase']) });
  assert.deepEqual(fs.readdirSync(dir), ['vault.json']);
});

// The hook's subcommand-slot rule (R26) rests on this: the CLI dispatches on its first argument only, so an option
// before "credential" makes the command unknown and nothing runs.
test('an option before the subcommand is an unknown command, so "rw --home x credential" never reaches credential', async () => {
  const home = newHome();
  for (const argv of [['--home', home, 'credential', 'status'], ['--home=/x', 'credential', 'setup'], ['--run', 'r', 'credential', 'remove']]) {
    const r = await callMain(argv, { env: { RIVERWRIGHT_HOME: home, PATH: '' } });
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.stderr, /unknown command/, argv.join(' '));
  }
  assert.equal(fs.existsSync(vaultFile(home)), false);
});

test('R41: setup writes the vault to the account home, not to RIVERWRIGHT_HOME, HOME or USERPROFILE', async () => {
  const home = newHome();
  const elsewhere = tmpDir('rw-elsewhere-');
  const env = { RIVERWRIGHT_HOME: elsewhere, HOME: elsewhere, USERPROFILE: elsewhere, PATH: '' };
  const r = await callMain(['credential', 'setup'], { env, testing: { kdf: FAST_KDF, userInfo: acct(home) }, terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.existsSync(vaultFile(home)), true);
  assert.equal(fs.existsSync(vaultFile(elsewhere)), false);
  assert.equal(fs.existsSync(path.join(elsewhere, 'vault')), false);
});

test('R41: status reads the account home vault and ignores a vault in RIVERWRIGHT_HOME', async () => {
  const home = newHome();
  const decoy = tmpDir('rw-decoy-');
  fs.mkdirSync(path.dirname(vaultFile(decoy)), { recursive: true });
  fs.writeFileSync(vaultFile(decoy), '{"not":"a vault"}');
  const none = await callMain(['credential', 'status'], { env: { RIVERWRIGHT_HOME: decoy, PATH: '' }, testing: { userInfo: acct(home) } });
  assert.equal(none.code, 0, none.stderr);
  assert.match(none.stdout, /No sealed credential/);
  await cred(home, ['setup'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) });
  const r = await callMain(['credential', 'status'], { env: { RIVERWRIGHT_HOME: decoy, PATH: '' }, testing: { userInfo: acct(home) } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(fingerprint(readVault(home).publicKey)));
});

test('R41: remove deletes only the account home vault', async () => {
  const home = newHome();
  const other = tmpDir('rw-other-');
  fs.mkdirSync(path.dirname(vaultFile(other)), { recursive: true });
  fs.writeFileSync(vaultFile(other), '{}');
  await cred(home, ['setup'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) });
  const r = await callMain(['credential', 'remove'], { env: { RIVERWRIGHT_HOME: other, PATH: '' }, testing: { userInfo: acct(home) }, terminal: fakeSecretTerminal(['remove']) });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.existsSync(vaultFile(home)), false);
  assert.equal(fs.existsSync(vaultFile(other)), true);
});

test('R41: --home is refused from real argv for setup, status and remove, and nothing is written', async () => {
  const home = newHome();
  const target = tmpDir('rw-target-');
  for (const sub of ['setup', 'status', 'remove']) {
    const t = fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]);
    const r = await cred(home, [sub, '--home', target], { terminal: t });
    assert.equal(r.code, 1, sub);
    assert.match(r.stderr, /BAD_FLAG|--home/, sub);
    assert.equal(t.written.join('').includes('GitHub token'), false, sub);
    assert.equal(fs.existsSync(vaultFile(target)), false, sub);
    assert.equal(fs.existsSync(vaultFile(home)), false, sub);
  }
});

test('R41: --home is honoured only through the io.testing seam', async () => {
  const home = newHome();
  const target = tmpDir('rw-target-');
  const r = await cred(home, ['setup', '--home', target], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]), testing: { kdf: FAST_KDF, allowHomeOverride: true, userInfo: acct(home) } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.existsSync(vaultFile(target)), true);
  assert.equal(fs.existsSync(vaultFile(home)), false);
});
