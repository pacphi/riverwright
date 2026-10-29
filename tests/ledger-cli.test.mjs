import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, ledgerDirFor, ledgerFile, readLedger } from '../scripts/lib/ledger.mjs';
import { readEvents, verifyChain } from '../scripts/lib/events.mjs';
import { callMain, tmpDir } from './helpers.mjs';

// The account home is pinned to an empty directory so these tests never read the machine's real vault.
const noAccount = { testing: { userInfo: () => ({ homedir: tmpDir() }) } };

test('a run directory under runs/ shares the repository ledger; any other directory keeps its own', () => {
  const home = tmpDir();
  const run = path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509');
  assert.equal(ledgerDirFor(run), path.join(home, 'ruvnet', 'ruflo', 'ledger'));
  const other = tmpDir();
  assert.equal(ledgerDirFor(other), other);
  assert.equal(ledgerFile(run), path.join(home, 'ruvnet', 'ruflo', 'ledger', 'events.ndjson'));
});

test('appendEvent writes riverwright-event/1 lines and readLedger returns the flat view', () => {
  const dir = tmpDir();
  appendEvent(dir, { type: 'approval', at: '2026-10-02T14:03:11Z', actor: { type: 'human' }, gate: 'checkpoint-1', mode: 'tty' });
  const [e] = readEvents(dir);
  assert.equal(e.event, 'approval');
  assert.equal(e.actor.type, 'human');
  assert.deepEqual(e.data, { gate: 'checkpoint-1', mode: 'tty' });
  assert.deepEqual(readLedger(dir), [{ type: 'approval', at: '2026-10-02T14:03:11Z', gate: 'checkpoint-1', mode: 'tty' }]);
});

test('two runs of one repository share a single chain', () => {
  const home = tmpDir();
  appendEvent(path.join(home, 'o', 'r', 'runs', 'issue-1'), { type: 'note', at: 't' });
  appendEvent(path.join(home, 'o', 'r', 'runs', 'issue-2'), { type: 'note', at: 't' });
  assert.deepEqual(readEvents(path.join(home, 'o', 'r', 'ledger')).map((e) => e.seq), [1, 2]);
});

test('riverwright ledger verify passes an intact ledger and names the first break', async () => {
  const dir = tmpDir();
  for (const type of ['run-created', 'station-begin', 'note']) appendEvent(dir, { type, at: 't' });
  const ok = await callMain(['ledger', 'verify', '--run', dir], noAccount);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /3 events/);
  const ls = fs.readFileSync(ledgerFile(dir), 'utf8').trim().split('\n');
  ls[0] = ls[0].replace('"event":"run-created"', '"event":"note"');
  fs.writeFileSync(ledgerFile(dir), `${ls.join('\n')}\n`);
  const bad = await callMain(['ledger', 'verify', '--run', dir], noAccount);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /line 2/);
});

test('ledger verify accepts an anchored head and seq, and fails when they no longer match', async () => {
  const dir = tmpDir();
  appendEvent(dir, { type: 'note', at: 't' });
  appendEvent(dir, { type: 'note', at: 't' });
  const { head } = verifyChain(ledgerDirFor(dir));
  assert.equal((await callMain(['ledger', 'verify', '--run', dir, '--head', head, '--seq', '2'], noAccount)).code, 0);
  const cut = await callMain(['ledger', 'verify', '--run', dir, '--seq', '3'], noAccount);
  assert.equal(cut.code, 1);
  assert.match(cut.stderr, /truncated/);
});

// Receipts: verify checks each `approved` event against the vault's public key.
import crypto from 'node:crypto';
import { appendChained } from '../scripts/lib/events.mjs';
import { buildReceipt, signReceipt, markConsumed, consumeReceipt } from '../scripts/lib/receipt.mjs';
import { armRun, runDirIn, makeTestVault, issueReceipt } from './receipt-helpers.mjs';

const seam = { allowHomeOverride: true };
const verifyWith = (runDir, home, extra = []) => callMain(['ledger', 'verify', '--run', runDir, '--home', home, ...extra], { testing: seam });
const consumed = (dir, nonce, outcome) => appendChained(dir, () => ({ event: 'receipt-consumed', at: 't', actor: { type: 'human' }, data: { nonce, outcome } }));
const nonceOf = (runDir) => readEvents(ledgerDirFor(runDir)).find((e) => e.event === 'approved').data.receipt.nonce;

test('ledger verify checks receipt signatures against the vault and reports how many it checked', async () => {
  const home = tmpDir();
  const runDir = runDirIn(home);
  armRun({ home, runDir });
  const r = await verifyWith(runDir, home);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 receipt signature checked/);
  assert.match(r.stdout, /cannot tell a cleanly cut tail/);
});

test('ledger verify fails on a receipt signed by another key', async () => {
  const home = tmpDir();
  const runDir = runDirIn(home);
  armRun({ home, runDir });
  const attacker = crypto.generateKeyPairSync('ed25519');
  appendChained(ledgerDirFor(runDir), ({ prev, seq }) => ({
    event: 'approved', at: 't', actor: { type: 'human' },
    data: { receipt: signReceipt(buildReceipt({ gate: 'post-comment', run: 'ruvnet/ruflo#3509', binding: { kind: 'content', value: `sha256:${'c'.repeat(64)}` }, ledgerHead: prev, seq, at: '2026-10-02T14:03:11.000Z' }), attacker.privateKey) },
  }));
  const r = await verifyWith(runDir, home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /signature/);
});

test('without a vault, verify still checks the chain and says signatures were not checked', async () => {
  const dir = tmpDir();
  appendEvent(dir, { type: 'note', at: 't' });
  const r = await verifyWith(dir, tmpDir());
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /signatures were not checked/);
});

test('--home is refused from real argv: only the test seam may choose the vault (R20)', async () => {
  const dir = tmpDir();
  appendEvent(dir, { type: 'note', at: 't' });
  const r = await callMain(['ledger', 'verify', '--run', dir, '--home', tmpDir()]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--home/);
});

test('RIVERWRIGHT_HOME and a run directory layout do not choose the vault', async () => {
  const forged = tmpDir();
  const runDir = runDirIn(forged);
  armRun({ home: forged, runDir });
  // Forged tree names itself by layout and by env; the vault is read from the account home, not from either.
  const accountHome = tmpDir();
  const r = await callMain(['ledger', 'verify', '--run', runDir], { env: { RIVERWRIGHT_HOME: forged }, testing: { userInfo: () => ({ homedir: accountHome }) } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /signatures were not checked/);
});

test('a malformed vault is an error, not a silent skip', async () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'vault'), { recursive: true });
  fs.writeFileSync(path.join(home, 'vault', 'vault.json'), '{nope');
  const dir = tmpDir();
  appendEvent(dir, { type: 'note', at: 't' });
  const r = await verifyWith(dir, home);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not valid JSON/);
});

test('verify prints ledger-sourced text without control characters (R11)', async () => {
  const home = tmpDir();
  const dir = tmpDir();
  appendEvent(dir, { type: 'note', at: 't' });
  const ls = fs.readFileSync(ledgerFile(dir), 'utf8').trim().split('\n');
  ls[0] = ls[0].replace('"riverwright-event/1"', '"\\u001b[2Jx"');
  fs.writeFileSync(ledgerFile(dir), `${ls.join('\n')}\n`);
  const r = await verifyWith(dir, home);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stderr, /\x1b/);
});

// Consumption lines: the state machine is unused -> [claimed] -> final, or unused -> final.
test('a normal claim then final outcome verifies', async () => {
  const home = tmpDir();
  const runDir = runDirIn(home);
  armRun({ home, runDir });
  const n = nonceOf(runDir);
  consumed(ledgerDirFor(runDir), n, 'claimed');
  consumed(ledgerDirFor(runDir), n, 'succeeded');
  const r = await verifyWith(runDir, home);
  assert.equal(r.code, 0, r.stderr);
});

test('a direct final outcome with no claim is allowed by the state machine', async () => {
  const home = tmpDir();
  const runDir = runDirIn(home);
  armRun({ home, runDir });
  consumed(ledgerDirFor(runDir), nonceOf(runDir), 'failed');
  assert.equal((await verifyWith(runDir, home)).code, 0);
});

for (const [name, outcomes, re] of [
  ['an unknown outcome', ['sideways'], /unknown outcome/],
  ['two final outcomes for one receipt', ['claimed', 'succeeded', 'failed'], /already recorded|more than one final/],
  ['a second claim', ['claimed', 'claimed'], /claimed more than once/],
  ['a claim after a final outcome', ['failed', 'claimed'], /after its final outcome/],
]) {
  test(`verify flags ${name}`, async () => {
    const home = tmpDir();
    const runDir = runDirIn(home);
    armRun({ home, runDir });
    for (const o of outcomes) consumed(ledgerDirFor(runDir), nonceOf(runDir), o);
    const r = await verifyWith(runDir, home);
    assert.equal(r.code, 1);
    assert.match(r.stderr, re);
  });
}

test('verify flags a consumption that names no receipt', async () => {
  const home = tmpDir();
  const runDir = runDirIn(home);
  armRun({ home, runDir });
  consumed(ledgerDirFor(runDir), 'f'.repeat(31) + 'e', 'succeeded');
  const r = await verifyWith(runDir, home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no receipt/);
});

test('verify flags a consumption line with no readable nonce', async () => {
  const home = tmpDir();
  const runDir = runDirIn(home);
  armRun({ home, runDir });
  appendChained(ledgerDirFor(runDir), () => ({ event: 'receipt-consumed', at: 't', actor: { type: 'human' }, data: { outcome: 'succeeded' } }));
  assert.equal((await verifyWith(runDir, home)).code, 1);
});

test('consumption checks run even without a vault', async () => {
  const dir = tmpDir();
  consumed(dir, 'a'.repeat(32), 'succeeded');
  const r = await verifyWith(dir, tmpDir());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no receipt/);
});

test('verify flags a consumption recorded before its receipt', async () => {
  const home = tmpDir();
  const runDir = runDirIn(home);
  const keys = makeTestVault(home);
  const nonce = 'ab'.repeat(16);
  consumed(ledgerDirFor(runDir), nonce, 'claimed');
  appendChained(ledgerDirFor(runDir), ({ prev, seq }) => ({
    event: 'approved', at: 't', actor: { type: 'human' },
    data: { receipt: signReceipt(buildReceipt({ gate: 'post-comment', run: 'ruvnet/ruflo#3509', binding: { kind: 'content', value: `sha256:${'c'.repeat(64)}` }, ledgerHead: prev, seq, at: '2026-10-02T14:03:11.000Z', nonce }), keys.privateKey) },
  }));
  const r = await verifyWith(runDir, home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /before/);
});

test('the real claim and final-outcome functions produce a ledger that verifies', async () => {
  const home = tmpDir();
  const runDir = runDirIn(home);
  const keys = armRun({ home, runDir });
  const nonce = nonceOf(runDir);
  consumeReceipt({ ledgerDir: ledgerDirFor(runDir), publicKey: keys.publicKey, gate: 'submit-gate', run: 'ruvnet/ruflo#3509', nowMs: Date.now(), binding: { kind: 'sha', value: 'a'.repeat(40) }, at: 't' });
  markConsumed({ ledgerDir: ledgerDirFor(runDir), nonce, outcome: 'succeeded', at: 't' });
  const r = await verifyWith(runDir, home);
  assert.equal(r.code, 0, r.stderr);
  void issueReceipt;
});
