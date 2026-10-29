import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMain, fakeTerminal, tmpDir } from './helpers.mjs';
import { loadState, saveState, createState, STATIONS } from '../scripts/lib/state.mjs';
import { recordApproval } from '../scripts/lib/approvals.mjs';
import { makeTestVault, issueReceipt } from './receipt-helpers.mjs';
import { ledgerDirFor, readLedger } from '../scripts/lib/ledger.mjs';
import { readEvents } from '../scripts/lib/events.mjs';

const A = 'a'.repeat(40);
// The run is named with --run, as a human would; the clock is pinned through the in-process test seam.
const rw = (dir, args, opts = {}) => callMain([...args, '--run', dir], { testing: { now: '2026-09-29T00:00:00Z' }, ...opts });

test('riverwright state create, begin and complete write state and ledger', async () => {
  const dir = tmpDir();
  assert.equal((await rw(dir, ['state', 'create', '--id', 'o/r#1', '--kind', 'fixture'])).code, 0);
  const begun = await rw(dir, ['state', 'begin', 'start', '--host', 'claude-code', '--model', 'm']);
  assert.equal(begun.code, 0, begun.stderr);
  assert.equal(JSON.parse(begun.stdout).current, 'start');
  assert.equal((await rw(dir, ['state', 'complete', 'start', 'passed'])).code, 0);
  assert.equal(loadState(dir).stations.start.status, 'passed');
  assert.deepEqual(readLedger(dir).map((e) => e.type), ['run-created', 'station-begin', 'station-complete']);
});

test('riverwright state refuses an illegal transition with a clear message', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  const r = await rw(dir, ['state', 'begin', 'fix']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot begin fix; the next station is start/);
});

test('riverwright approve in tty mode records only after the human types the short SHA', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  const wrong = await rw(dir, ['approve', 'checkpoint-1', '--sha', A, '--mode', 'tty'], { terminal: fakeTerminal('yes') });
  assert.equal(wrong.code, 1);
  assert.equal(loadState(dir).approvals.length, 0);
  const right = await rw(dir, ['approve', 'checkpoint-1', '--sha', A, '--mode', 'tty'], { terminal: fakeTerminal('aaaaaaa') });
  assert.equal(right.code, 0, right.stderr);
  assert.equal(loadState(dir).approvals[0].binding.value, A);
  assert.equal(readLedger(dir).at(-1).type, 'approval');
});

// The public gates are approved by the unlock inside submit and post (ADR-0010), so approve refuses them and
// tells the human where to go. Nothing is recorded, whatever flags or terminal are supplied.
test('approve refuses every public gate and points at submit and post', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  const before = readEvents(ledgerDirFor(dir)).length;
  for (const gate of ['submit-gate', 'post-issue', 'post-comment']) {
    for (const extra of [[], ['--mode', 'tty'], ['--mode', 'host-ask'], ['--mode', 'unlock']]) {
      const r = await rw(dir, ['approve', gate, '--sha', A, ...extra], { terminal: fakeTerminal('aaaaaaa') });
      assert.equal(r.code, 1, gate);
      assert.match(r.stderr, /riverwright submit|riverwright post/, gate);
      assert.match(r.stderr, /unlock/, gate);
    }
  }
  assert.equal(loadState(dir).approvals.length, 0);
  assert.equal(readEvents(ledgerDirFor(dir)).length, before, 'a refusal leaves the ledger unchanged');
});

test('approve refuses case variants of the public gates, and the environment cannot change that', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  const before = readEvents(ledgerDirFor(dir)).length;
  for (const gate of ['SUBMIT-GATE', 'Submit-Gate', 'Post-Issue', 'POST-COMMENT', 'CHECKPOINT-1']) {
    const r = await rw(dir, ['approve', gate, '--sha', A], { env: { RIVERWRIGHT_APPROVAL_MODE: 'host-ask' } });
    assert.equal(r.code, 1, gate);
    assert.match(r.stderr, /unknown gate/, gate);
  }
  assert.equal(loadState(dir).approvals.length, 0);
  assert.equal(readEvents(ledgerDirFor(dir)).length, before);
});

test('the retired flags and any unknown flag give one clean line, record nothing and show no stack', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  const before = readEvents(ledgerDirFor(dir)).length;
  for (const flag of [['--branch', 'riverwright/1-x'], ['--allow-host-ask-submit'], ['--bogus'], ['--sha\u001b[2J']]) {
    const r = await rw(dir, ['approve', 'checkpoint-1', '--sha', A, ...flag]);
    assert.equal(r.code, 1, flag.join(' '));
    assert.match(r.stderr, /^riverwright approve: /, flag.join(' '));
    assert.doesNotMatch(r.stderr, /unexpected error|TypeError|\n\s+at /, flag.join(' '));
    assert.doesNotMatch(r.stderr, /\u001b/);
    assert.equal(r.stderr.trimEnd().split('\n').length, 1, flag.join(' '));
  }
  const retired = await rw(dir, ['approve', 'checkpoint-1', '--sha', A, '--branch', 'riverwright/1-x']);
  assert.match(retired.stderr, /BAD_FLAG|"--branch" is retired/);
  assert.match(retired.stderr, /riverwright submit/);
  assert.equal(loadState(dir).approvals.length, 0);
  assert.equal(readEvents(ledgerDirFor(dir)).length, before);
});

test('riverwright approve refuses the unlock mode: only submit and post record it, after a passphrase', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  for (const args of [['submit-gate', '--sha', A], ['post-comment', '--sha', A], ['checkpoint-1', '--sha', A]]) {
    const r = await rw(dir, ['approve', ...args, '--mode', 'unlock']);
    assert.equal(r.code, 1, args[0]);
    assert.match(r.stderr, /unlock/);
  }
  assert.equal(loadState(dir).approvals.length, 0);
});

test('host-ask is the default for checkpoint-1, recorded as an agent action confirmed through the host prompt', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  const r = await rw(dir, ['approve', 'checkpoint-1', '--sha', A, '--host', 'claude-code']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(loadState(dir).approvals[0].mode, 'host-ask');
  const ev = readEvents(ledgerDirFor(dir)).at(-1);
  assert.deepEqual([ev.actor.type, ev.actor.host], ['agent', 'claude-code']);
  assert.equal(ev.data.confirmedVia, 'host-prompt');
  assert.equal(ev.data.mode, 'host-ask');
  const noHost = await rw(dir, ['approve', 'checkpoint-1', '--sha', 'b'.repeat(40)]);
  assert.equal(noHost.code, 0, noHost.stderr);
  const anon = readEvents(ledgerDirFor(dir)).at(-1).actor;
  assert.deepEqual([anon.type, anon.host], ['agent', null]);
});

test('a typed tty approval is recorded as a human action', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  const r = await rw(dir, ['approve', 'checkpoint-1', '--sha', A, '--mode', 'tty'], { terminal: fakeTerminal('aaaaaaa') });
  assert.equal(r.code, 0, r.stderr);
  const ev = readEvents(ledgerDirFor(dir)).at(-1);
  assert.equal(ev.actor.type, 'human');
  assert.equal(ev.actor.host, undefined);
  assert.equal(ev.data.confirmedVia, undefined);
});

// A run that has reached the submit station: every earlier station passed.
function atSubmit(dir) {
  const s = createState({ runId: 'o/r#1', kind: 'fixture', now: 't' });
  for (const st of STATIONS) if (st !== 'submit') s.stations[st].status = 'passed';
  saveState(dir, s);
  return s;
}

test('state begin submit is not satisfied by a hand-written state.json entry, in any mode', async () => {
  const home = tmpDir();
  for (const mode of ['host-ask', 'tty', 'unlock']) {
    const dir = tmpDir();
    makeTestVault(home);
    saveState(dir, recordApproval(atSubmit(dir), { gate: 'submit-gate', sha: A, mode, now: 't' }));
    const before = readEvents(ledgerDirFor(dir)).length;
    const r = await rw(dir, ['state', 'begin', 'submit', '--head', A, '--home', home]);
    assert.equal(r.code, 1, mode);
    assert.match(r.stderr, /submit-gate has no approval/, mode);
    assert.equal(loadState(dir).current, null, mode);
    assert.equal(readEvents(ledgerDirFor(dir)).length, before, mode);
  }
});

test('state begin submit passes with the newest signed, unused receipt for the commit', async () => {
  const home = tmpDir();
  const dir = tmpDir();
  atSubmit(dir);
  const keys = makeTestVault(home);
  issueReceipt({ runDir: dir, keys, run: 'o/r#1', sha: A, at: '2026-09-29T00:00:00.000Z' });
  const wrongCommit = await rw(dir, ['state', 'begin', 'submit', '--head', 'b'.repeat(40), '--home', home]);
  assert.equal(wrongCommit.code, 1);
  assert.equal(loadState(dir).current, null);
  const r = await rw(dir, ['state', 'begin', 'submit', '--head', A, '--home', home]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(loadState(dir).current, 'submit');
});

test('state begin submit: a newer receipt for another commit supersedes the older one, and no vault means no proof', async () => {
  const home = tmpDir();
  const dir = tmpDir();
  atSubmit(dir);
  const noVault = await rw(dir, ['state', 'begin', 'submit', '--head', A, '--home', home]);
  assert.equal(noVault.code, 1);
  assert.match(noVault.stderr, /submit-gate has no approval/);
  const keys = makeTestVault(home);
  issueReceipt({ runDir: dir, keys, run: 'o/r#1', sha: A, at: '2026-09-29T00:00:00.000Z' });
  issueReceipt({ runDir: dir, keys, run: 'o/r#1', sha: 'b'.repeat(40), at: '2026-09-29T00:00:01.000Z' });
  const older = await rw(dir, ['state', 'begin', 'submit', '--head', A, '--home', home]);
  assert.equal(older.code, 1);
  const newer = await rw(dir, ['state', 'begin', 'submit', '--head', 'b'.repeat(40), '--home', home]);
  assert.equal(newer.code, 0, newer.stderr);
});

test('--host must be a known host id', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  const begun = await rw(dir, ['state', 'begin', 'start', '--host', 'totally-claude']);
  assert.equal(begun.code, 1);
  assert.match(begun.stderr, /unknown host/);
  assert.equal(loadState(dir).current, null);
  const approved = await rw(dir, ['approve', 'checkpoint-1', '--sha', A, '--host', 'notahost']);
  assert.equal(approved.code, 1);
  assert.match(approved.stderr, /unknown host/);
  assert.equal(loadState(dir).approvals.length, 0);
  const ok = await rw(dir, ['state', 'begin', 'start', '--host', 'codex']);
  assert.equal(ok.code, 0, ok.stderr);
});

// Environment variables never change the mode: checkpoint-1 stays host-ask, and a tty prompt is opened only
// by --mode tty on the command line.
test('RIVERWRIGHT_APPROVAL_MODE in the environment does not change approval', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  const terminal = fakeTerminal('no');
  const r = await rw(dir, ['approve', 'checkpoint-1', '--sha', A], { env: { RIVERWRIGHT_APPROVAL_MODE: 'tty' }, terminal });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(terminal.written.join(''), '');
  assert.equal(loadState(dir).approvals[0].mode, 'host-ask');
});
