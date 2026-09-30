import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMain, fakeTerminal, tmpDir } from './helpers.mjs';
import { loadState } from '../scripts/lib/state.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';

const A = 'a'.repeat(40);
const env = (dir) => ({ UPF_RUN_DIR: dir, UPF_NOW: '2026-09-29T00:00:00Z' });

test('upf state create, begin and complete write state and ledger', async () => {
  const dir = tmpDir();
  assert.equal((await callMain(['state', 'create', '--id', 'o/r#1', '--kind', 'fixture'], { env: env(dir) })).code, 0);
  const begun = await callMain(['state', 'begin', 'start', '--host', 'claude-code', '--model', 'm'], { env: env(dir) });
  assert.equal(begun.code, 0, begun.stderr);
  assert.equal(JSON.parse(begun.stdout).current, 'start');
  assert.equal((await callMain(['state', 'complete', 'start', 'passed'], { env: env(dir) })).code, 0);
  assert.equal(loadState(dir).stations.start.status, 'passed');
  assert.deepEqual(readLedger(dir).map((e) => e.type), ['run-created', 'station-begin', 'station-complete']);
});

test('upf state refuses an illegal transition with a clear message', async () => {
  const dir = tmpDir();
  await callMain(['state', 'create', '--id', 'o/r#1'], { env: env(dir) });
  const r = await callMain(['state', 'begin', 'fix'], { env: env(dir) });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot begin fix; the next station is start/);
});

test('upf approve in tty mode records only after the human types the short SHA', async () => {
  const dir = tmpDir();
  await callMain(['state', 'create', '--id', 'o/r#1'], { env: env(dir) });
  const wrong = await callMain(['approve', 'submit-gate', '--sha', A, '--mode', 'tty'], { env: env(dir), terminal: fakeTerminal('yes') });
  assert.equal(wrong.code, 1);
  assert.equal(loadState(dir).approvals.length, 0);
  const right = await callMain(['approve', 'submit-gate', '--sha', A, '--mode', 'tty'], { env: env(dir), terminal: fakeTerminal('aaaaaaa') });
  assert.equal(right.code, 0, right.stderr);
  assert.equal(loadState(dir).approvals[0].binding.value, A);
  assert.equal(readLedger(dir).at(-1).type, 'approval');
});
