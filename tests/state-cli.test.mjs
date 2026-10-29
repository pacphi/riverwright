import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMain, fakeTerminal, tmpDir } from './helpers.mjs';
import { loadState } from '../scripts/lib/state.mjs';
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
  for (const gate of ['submit-gate', 'post-issue', 'post-comment']) {
    for (const extra of [[], ['--mode', 'tty'], ['--mode', 'host-ask']]) {
      const r = await rw(dir, ['approve', gate, '--sha', A, ...extra], { terminal: fakeTerminal('aaaaaaa') });
      assert.equal(r.code, 1, gate);
      assert.match(r.stderr, /riverwright submit|riverwright post/, gate);
      assert.match(r.stderr, /unlock/, gate);
    }
  }
  assert.equal(loadState(dir).approvals.length, 0);
});

test('the retired flags --branch and --allow-host-ask-submit are no longer accepted', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  for (const flag of [['--branch', 'riverwright/1-x'], ['--allow-host-ask-submit']]) {
    const r = await rw(dir, ['approve', 'checkpoint-1', '--sha', A, ...flag]);
    assert.equal(r.code, 1, flag.join(' '));
  }
  assert.equal(loadState(dir).approvals.length, 0);
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

test('host-ask is the default for checkpoint-1, recorded as a human approval', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  const r = await rw(dir, ['approve', 'checkpoint-1', '--sha', A]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(loadState(dir).approvals[0].mode, 'host-ask');
  assert.equal(readEvents(ledgerDirFor(dir)).at(-1).actor.type, 'human');
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
