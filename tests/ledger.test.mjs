import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendEvent, readLedger, ledgerFile } from '../scripts/lib/ledger.mjs';
import { tmpDir } from './helpers.mjs';

test('events append one JSON line each and read back in order', () => {
  const dir = tmpDir();
  appendEvent(dir, { type: 'run-created', at: 't0', runId: 'o/r#1' });
  appendEvent(dir, { type: 'station-begin', at: 't1', station: 'start', host: 'claude-code', model: 'm' });
  assert.deepEqual(readLedger(dir).map((e) => e.type), ['run-created', 'station-begin']);
  assert.equal(fs.readFileSync(ledgerFile(dir), 'utf8').split('\n').length, 3);
});

test('unknown event types and missing timestamps are rejected', () => {
  const dir = tmpDir();
  assert.throws(() => appendEvent(dir, { type: 'party', at: 't' }), /unknown ledger event/);
  assert.throws(() => appendEvent(dir, { type: 'note' }), /needs "at"/);
});

test('a corrupt line is reported with its line number', () => {
  const dir = tmpDir();
  appendEvent(dir, { type: 'note', at: 't' });
  fs.appendFileSync(ledgerFile(dir), '{not json\n');
  assert.throws(() => readLedger(dir), /line 2/);
});
