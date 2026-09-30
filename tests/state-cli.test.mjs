import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMain, fakeTerminal, tmpDir } from './helpers.mjs';
import { loadState } from '../scripts/lib/state.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';

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
  const wrong = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x', '--mode', 'tty'], { terminal: fakeTerminal('yes') });
  assert.equal(wrong.code, 1);
  assert.equal(loadState(dir).approvals.length, 0);
  const right = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x', '--mode', 'tty'], { terminal: fakeTerminal('aaaaaaa') });
  assert.equal(right.code, 0, right.stderr);
  assert.equal(loadState(dir).approvals[0].binding.value, A);
  assert.equal(readLedger(dir).at(-1).type, 'approval');
});

test('the submit gate defaults to terminal approval', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  const terminal = fakeTerminal('aaaaaaa');
  const r = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x'], { terminal });
  assert.equal(r.code, 0, r.stderr);
  assert.match(terminal.written.join(''), /Approve submit-gate/);
  assert.equal(loadState(dir).approvals[0].mode, 'tty');
});

test('host-ask is refused for the submit gate unless explicitly allowed', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  for (const [args, extra] of [[['--mode', 'host-ask'], {}], [[], { RIVERWRIGHT_APPROVAL_MODE: 'host-ask' }]]) {
    const r = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x', ...args], { env: { ...extra } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /RIVERWRIGHT_ALLOW_HOST_ASK_SUBMIT/);
  }
  assert.equal(loadState(dir).approvals.length, 0);
  const ok = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x', '--mode', 'host-ask'], { env: { RIVERWRIGHT_ALLOW_HOST_ASK_SUBMIT: '1' } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(loadState(dir).approvals[0].mode, 'host-ask');
});

test('host-ask stays the default for checkpoint-1 and posts', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  const r = await rw(dir, ['approve', 'checkpoint-1', '--sha', A]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(loadState(dir).approvals[0].mode, 'host-ask');
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

test('approving the submit gate needs the run branch, and records it', async () => {
  const dir = tmpDir();
  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
  const missing = await rw(dir, ['approve', 'submit-gate', '--sha', A], { terminal: fakeTerminal('aaaaaaa') });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--branch/);
  const terminal = fakeTerminal('aaaaaaa');
  const ok = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-fix'], { terminal });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(terminal.written.join(''), /riverwright\/1-fix/);
  assert.equal(loadState(dir).approvals[0].branch, 'riverwright/1-fix');
});
