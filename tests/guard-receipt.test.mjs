import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createState, saveState, setFork } from '../scripts/lib/state.mjs';
import { recordApproval } from '../scripts/lib/approvals.mjs';
import { appendChained, readEvents } from '../scripts/lib/events.mjs';
import { buildReceipt, consumeReceipt, markConsumed, signReceipt } from '../scripts/lib/receipt.mjs';
import { runPublicAction } from '../scripts/lib/gate.mjs';
import { vaultFile } from '../scripts/lib/vault.mjs';
import { ledgerDirFor } from '../scripts/lib/ledger.mjs';
import { runFile } from '../scripts/lib/exec.mjs';
import { callMain, fakeSecretTerminal, tmpDir } from './helpers.mjs';
import { NOW, PASSPHRASE, armRun, issueReceipt, makeTestVault, runDirIn } from './receipt-helpers.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);
const FORK = 'https://github.com/pacphi/ruflo.git';
const BRANCH = 'riverwright/3509-codex';
const line = (sha, ref = `refs/heads/${BRANCH}`) => `refs/heads/${BRANCH} ${sha} ${ref} ${ZERO}\n`;

async function workspace() {
  const home = tmpDir('riverwright-home-');
  const worktree = path.join(home, 'ruvnet', 'ruflo', 'worktrees', 'issue-3509');
  fs.mkdirSync(worktree, { recursive: true });
  await runFile('git', ['init', '-q'], { cwd: worktree });
  const runDir = runDirIn(home);
  saveState(runDir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
  return { home, worktree, runDir };
}
const push = (w, sha = A, ref) => callMain(['guard', 'pre-push', '--home', w.home, '--', 'fork', FORK], { stdin: line(sha, ref), cwd: w.worktree });

test('a fresh receipt for the exact commit and branch lets the push through', async () => {
  const w = await workspace();
  armRun({ home: w.home, runDir: w.runDir, sha: A });
  const r = await push(w);
  assert.equal(r.code, 0, r.stderr);
});

test('an approval written into state.json is not consent: it never lets a push through', async () => {
  const w = await workspace();
  makeTestVault(w.home);
  saveState(w.runDir, recordApproval(setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK), { gate: 'submit-gate', sha: A, mode: 'unlock', now: 't', branch: BRANCH }));
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Nothing has been unlocked/);
});

test('without a vault nothing is allowed, and the reason says so', async () => {
  const w = await workspace();
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no sealed credential/);
});

test('a receipt signed by any other key is refused, even with a well-formed ledger', async () => {
  const w = await workspace();
  makeTestVault(w.home);
  const attacker = crypto.generateKeyPairSync('ed25519');
  appendChained(ledgerDirFor(w.runDir), ({ prev, seq }) => ({
    event: 'approved', at: new Date().toISOString(), actor: { type: 'human' }, run: 'ruvnet/ruflo#3509',
    data: { receipt: signReceipt(buildReceipt({ gate: 'submit-gate', run: 'ruvnet/ruflo#3509', binding: { kind: 'sha', value: A }, branch: BRANCH, ledgerHead: prev, seq, at: new Date().toISOString() }), attacker.privateKey) },
  }));
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /signature/);
});

test('a used receipt cannot be reused for a second push', async () => {
  const w = await workspace();
  const keys = armRun({ home: w.home, runDir: w.runDir, sha: A });
  const first = await push(w);
  assert.equal(first.code, 0, first.stderr);
  const nonce = JSON.parse(fs.readFileSync(path.join(ledgerDirFor(w.runDir), 'events.ndjson'), 'utf8').split('\n')[0]).data.receipt.nonce;
  markConsumed({ ledgerDir: ledgerDirFor(w.runDir), nonce, outcome: 'succeeded', at: new Date().toISOString() });
  const second = await push(w);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already used/);
  assert.ok(keys);
});

test('an old receipt is refused', async () => {
  const w = await workspace();
  armRun({ home: w.home, runDir: w.runDir, sha: A, at: new Date(Date.now() - 11 * 60_000).toISOString() });
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /expired/);
});

test('a receipt for another commit, another branch or another run is refused', async () => {
  const w = await workspace();
  armRun({ home: w.home, runDir: w.runDir, sha: A });
  assert.notEqual((await push(w, B)).code, 0);
  assert.match((await push(w, A, 'refs/heads/riverwright/3509-other')).stderr, /approved branch/);
  const other = await workspace();
  makeTestVault(other.home);
  issueReceipt({ runDir: other.runDir, keys: makeTestVault(other.home), run: 'ruvnet/ruflo#1', sha: A, at: new Date().toISOString() });
  const r = await push(other);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no receipt for this gate and run/);
});

test('rewriting the ledger before the receipt makes the guard refuse', async () => {
  const w = await workspace();
  appendChained(ledgerDirFor(w.runDir), () => ({ event: 'note', at: new Date().toISOString(), actor: { type: 'agent' }, data: { n: 1 } }));
  armRun({ home: w.home, runDir: w.runDir, sha: A });
  const file = path.join(ledgerDirFor(w.runDir), 'events.ndjson');
  const ls = fs.readFileSync(file, 'utf8').trim().split('\n');
  const first = JSON.parse(ls[0]);
  first.data = { n: 2 };
  ls[0] = JSON.stringify(first);
  const second = JSON.parse(ls[1]);
  second.prev = `sha256:${crypto.createHash('sha256').update(ls[0]).digest('hex')}`;
  ls[1] = JSON.stringify(second);
  fs.writeFileSync(file, `${ls.join('\n')}\n`);
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /ledger head/);
});

// ---- Beyond the brief: the edges of "a verified receipt, not state.json" ----

const RUN = 'ruvnet/ruflo#3509';
const C = 'c'.repeat(40);
const nonceOf = (w) => readEvents(ledgerDirFor(w.runDir)).find((e) => e.event === 'approved').data.receipt.nonce;

test('a wrong commit is refused and the message names the commit that was unlocked', async () => {
  const w = await workspace();
  armRun({ home: w.home, runDir: w.runDir, sha: A });
  const r = await push(w, B);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Commit bbbbbbbbbbbb is not the approved commit aaaaaaaaaaaa/);
});

test('a newer approval for another commit in state.json changes nothing: only the receipt counts', async () => {
  const w = await workspace();
  armRun({ home: w.home, runDir: w.runDir, sha: A });
  saveState(w.runDir, recordApproval(setFork(createState({ runId: RUN, now: 't' }), FORK), { gate: 'submit-gate', sha: B, mode: 'unlock', now: 't', branch: BRANCH }));
  assert.notEqual((await push(w, B)).code, 0);
  const r = await push(w, A);
  assert.equal(r.code, 0, r.stderr);
});

test('a claimed receipt and a failed receipt count as used, like a succeeded one', async () => {
  for (const record of [
    (w, keys) => consumeReceipt({ ledgerDir: ledgerDirFor(w.runDir), publicKey: keys.publicKey, gate: 'submit-gate', run: RUN, nowMs: Date.now(), binding: { kind: 'sha', value: A }, at: new Date().toISOString() }),
    (w) => markConsumed({ ledgerDir: ledgerDirFor(w.runDir), nonce: nonceOf(w), outcome: 'failed', at: new Date().toISOString() }),
  ]) {
    const w = await workspace();
    const keys = armRun({ home: w.home, runDir: w.runDir, sha: A });
    record(w, keys);
    const r = await push(w);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /already used/);
  }
});

test('a receipt dated more than a minute ahead is refused', async () => {
  const w = await workspace();
  armRun({ home: w.home, runDir: w.runDir, sha: A, at: new Date(Date.now() + 5 * 60_000).toISOString() });
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /future/);
});

test('a submit-gate receipt bound to content, or a receipt for another gate, never authorizes a push', async () => {
  const w = await workspace();
  const keys = makeTestVault(w.home);
  issueReceipt({ runDir: w.runDir, keys, content: `sha256:${A.slice(0, 32)}${A.slice(0, 32)}`, at: new Date().toISOString() });
  issueReceipt({ runDir: w.runDir, keys, gate: 'post-comment', content: `sha256:${'d'.repeat(64)}`, at: new Date().toISOString() });
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Nothing has been unlocked/);
});

test('an earlier line edited (its successor left alone) makes the guard refuse', async () => {
  const w = await workspace();
  appendChained(ledgerDirFor(w.runDir), () => ({ event: 'note', at: new Date().toISOString(), actor: { type: 'agent' }, data: { n: 1 } }));
  armRun({ home: w.home, runDir: w.runDir, sha: A });
  const file = path.join(ledgerDirFor(w.runDir), 'events.ndjson');
  const ls = fs.readFileSync(file, 'utf8').trim().split('\n');
  ls[0] = ls[0].replace('"n":1', '"n":2');
  fs.writeFileSync(file, `${ls.join('\n')}\n`);
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /ledger head/);
});

test('a ledger that cannot be read blocks the push', async () => {
  const w = await workspace();
  armRun({ home: w.home, runDir: w.runDir, sha: A });
  fs.appendFileSync(path.join(ledgerDirFor(w.runDir), 'events.ndjson'), 'not json\n');
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /ledger/);
});

test('a vault that is not a vault blocks the push', async () => {
  const w = await workspace();
  armRun({ home: w.home, runDir: w.runDir, sha: A });
  fs.writeFileSync(vaultFile(w.home), '{"schema":"something else"}');
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not a Riverwright vault/);
});

// Git runs the hook with no lines when everything is up to date (a retried push whose first attempt landed).
// Nothing is published then, so it is allowed while a receipt for this run is unlocked, and refused otherwise.
test('a push with nothing to update is allowed only while a receipt is unlocked', async () => {
  const w = await workspace();
  const empty = () => callMain(['guard', 'pre-push', '--home', w.home, '--', 'fork', FORK], { stdin: '', cwd: w.worktree });
  const before = await empty();
  assert.notEqual(before.code, 0);
  assert.match(before.stderr, /Nothing has been unlocked/);
  armRun({ home: w.home, runDir: w.runDir, sha: A });
  const during = await empty();
  assert.equal(during.code, 0, during.stderr);
  markConsumed({ ledgerDir: ledgerDirFor(w.runDir), nonce: nonceOf(w), outcome: 'succeeded', at: new Date().toISOString() });
  const after = await empty();
  assert.notEqual(after.code, 0);
  assert.match(after.stderr, /already used/);
});

test('reasons read from files are printed without control characters', { skip: process.platform === 'win32' }, async () => {
  const home = path.join(tmpDir('riverwright-user-'), 'home\u001b[2J‮');
  const worktree = path.join(home, 'ruvnet', 'ruflo', 'worktrees', 'issue-3509');
  fs.mkdirSync(worktree, { recursive: true });
  await runFile('git', ['init', '-q'], { cwd: worktree });
  saveState(runDirIn(home), setFork(createState({ runId: RUN, now: 't' }), FORK));
  fs.mkdirSync(path.dirname(vaultFile(home)), { recursive: true });
  fs.writeFileSync(vaultFile(home), 'not json');
  const r = await callMain(['guard', 'pre-push', '--home', home, '--', 'fork', FORK], { stdin: line(A), cwd: worktree });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /is not valid JSON/);
  assert.doesNotMatch(r.stderr, /[\u001b‮]/);
});

// Ruling R12: the gate writes the receipt, runs the push while the receipt is unused, then records the outcome
// once. The guard that git runs during that push must allow it; once the outcome is recorded it must not.
test('during the gate\'s push the guard allows; once the outcome is recorded it refuses', async () => {
  for (const fails of [false, true]) {
    const w = await workspace();
    makeTestVault(w.home);
    const guard = () => callMain(['guard', 'pre-push', '--home', w.home, '--', 'fork', FORK], { stdin: line(A), cwd: w.worktree, testing: { now: NOW } });
    let during;
    const run = runPublicAction({
      home: w.home, runDir: w.runDir, gate: 'submit-gate', run: RUN, binding: { kind: 'sha', value: A }, branch: BRANCH,
      terminal: fakeSecretTerminal([PASSPHRASE]), summary: [`Push ${A} to pacphi/ruflo:${BRANCH}`], now: () => NOW,
      sleep: async () => {}, recompute: async () => ({ kind: 'sha', value: A }),
      action: async () => {
        during = await guard();
        if (fails) throw new Error('the push was rejected');
        return 'pushed';
      },
    });
    if (fails) await assert.rejects(run);
    else await run;
    assert.equal(during.code, 0, during.stderr);
    const after = await guard();
    assert.notEqual(after.code, 0);
    assert.match(after.stderr, /already used/);
  }
});

test('a newer unlock for a new commit authorizes that commit, and the older receipt still only its own', async () => {
  const w = await workspace();
  const keys = armRun({ home: w.home, runDir: w.runDir, sha: A });
  issueReceipt({ runDir: w.runDir, keys, sha: C, at: new Date().toISOString() });
  const r = await push(w, C);
  assert.equal(r.code, 0, r.stderr);
  assert.notEqual((await push(w, B)).code, 0);
});
