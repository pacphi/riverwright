import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { callMain, fakeSecretTerminal, tmpDir } from './helpers.mjs';
import { readVault, openVault, vaultFile, fingerprint } from '../scripts/lib/vault.mjs';
import { RiverwrightError } from '../scripts/lib/errors.mjs';
import { FAST_KDF, PASSPHRASE, TOKEN } from './receipt-helpers.mjs';

const cred = (home, args, opts = {}) => callMain(['credential', ...args], { env: { RIVERWRIGHT_HOME: home, PATH: '' }, testing: { now: '2026-10-02T14:03:11.000Z', kdf: FAST_KDF }, ...opts });
const noTerminal = () => { throw new RiverwrightError('NO_TTY', 'Terminal approval needs a real terminal.'); };
const leaks = (r, t) => [TOKEN, PASSPHRASE].some((s) => r.stdout.includes(s) || r.stderr.includes(s) || (t?.written ?? []).join('').includes(s));

test('credential setup seals the token and prints only the public-key fingerprint', async () => {
  const home = tmpDir();
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
  const home = tmpDir();
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
  const home = tmpDir();
  const bad = 'has a space in it';
  const t = fakeSecretTerminal([bad, PASSPHRASE, PASSPHRASE]);
  const r = await cred(home, ['setup'], { terminal: t });
  assert.equal(r.code, 1);
  assert.equal(r.stderr.includes(bad) || r.stdout.includes(bad) || t.written.join('').includes(bad), false);
  assert.equal(fs.existsSync(vaultFile(home)), false);
});

test('setup needs a real terminal and takes no secret from arguments or the environment', async () => {
  const home = tmpDir();
  const none = await cred(home, ['setup'], { terminal: noTerminal });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /real terminal/);
  const viaArg = await cred(home, ['setup', '--token', TOKEN], { terminal: fakeSecretTerminal([]) });
  assert.equal(viaArg.code, 1);
  assert.equal(leaks(viaArg), false);
  const viaPositional = await cred(home, ['setup', TOKEN], { terminal: fakeSecretTerminal([]) });
  assert.equal(viaPositional.code, 1);
  assert.equal(leaks(viaPositional), false);
  const viaEnv = await callMain(['credential', 'setup'], { env: { RIVERWRIGHT_HOME: home, GH_TOKEN: TOKEN, RIVERWRIGHT_PASSPHRASE: PASSPHRASE }, testing: { kdf: FAST_KDF }, terminal: noTerminal });
  assert.equal(viaEnv.code, 1);
  assert.equal(leaks(viaEnv), false);
  assert.equal(fs.existsSync(vaultFile(home)), false);
});

test('setup refuses a terminal that cannot hide typing', async () => {
  const home = tmpDir();
  const t = fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]);
  t.noEcho = false;
  const r = await cred(home, ['setup'], { terminal: t });
  assert.equal(r.code, 1);
  assert.equal(leaks(r, t), false);
  assert.equal(fs.existsSync(vaultFile(home)), false);
});

test('without the test seam, setup seals with the production key-derivation floor', async () => {
  const home = tmpDir();
  const r = await callMain(['credential', 'setup'], { env: { RIVERWRIGHT_HOME: home, PATH: '' }, terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) });
  assert.equal(r.code, 0, r.stderr);
  const { kdf } = readVault(home);
  if (kdf.name === 'argon2id') assert.ok(kdf.memory >= 47104);
  else assert.ok(kdf.N >= 2 ** 17);
});

test('an existing vault is not replaced without --replace, and the refusal comes before any prompt', async () => {
  const home = tmpDir();
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
  const home = tmpDir();
  await cred(home, ['setup'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) });
  const before = fs.readFileSync(vaultFile(home), 'utf8');
  const r = await cred(home, ['setup', '--replace'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, 'different passphrase']) });
  assert.equal(r.code, 1);
  assert.equal(fs.readFileSync(vaultFile(home), 'utf8'), before);
});

test('credential status shows the fingerprint and no secret, and says so when there is no vault', async () => {
  const home = tmpDir();
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
  const home = tmpDir();
  const r = await callMain(['credential', 'status'], { env: { RIVERWRIGHT_HOME: home, GH_TOKEN: TOKEN, PATH: '' }, testing: { kdf: FAST_KDF } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /GH_TOKEN/);
  assert.match(r.stdout, /without Riverwright/);
  assert.equal(r.stdout.includes(TOKEN), false);
});

test('credential remove deletes the vault only after "remove" is typed at the terminal', async () => {
  const home = tmpDir();
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
  const home = tmpDir();
  assert.equal((await cred(home, ['remove'], { terminal: fakeSecretTerminal(['remove']) })).code, 1);
  assert.equal((await cred(home, ['bogus'])).code, 1);
  assert.equal((await cred(home, [])).code, 1);
});
