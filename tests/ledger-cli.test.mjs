import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, ledgerDirFor, ledgerFile, readLedger } from '../scripts/lib/ledger.mjs';
import { readEvents, verifyChain } from '../scripts/lib/events.mjs';
import { callMain, tmpDir } from './helpers.mjs';

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
  const ok = await callMain(['ledger', 'verify', '--run', dir]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /3 events/);
  const ls = fs.readFileSync(ledgerFile(dir), 'utf8').trim().split('\n');
  ls[0] = ls[0].replace('"event":"run-created"', '"event":"note"');
  fs.writeFileSync(ledgerFile(dir), `${ls.join('\n')}\n`);
  const bad = await callMain(['ledger', 'verify', '--run', dir]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /line 2/);
});

test('ledger verify accepts an anchored head and seq, and fails when they no longer match', async () => {
  const dir = tmpDir();
  appendEvent(dir, { type: 'note', at: 't' });
  appendEvent(dir, { type: 'note', at: 't' });
  const { head } = verifyChain(ledgerDirFor(dir));
  assert.equal((await callMain(['ledger', 'verify', '--run', dir, '--head', head, '--seq', '2'])).code, 0);
  const cut = await callMain(['ledger', 'verify', '--run', dir, '--seq', '3']);
  assert.equal(cut.code, 1);
  assert.match(cut.stderr, /truncated/);
});
