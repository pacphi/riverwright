import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { callMain, runRiverwright, tmpDir } from './helpers.mjs';

test('riverwright --version prints the package version', async () => {
  const r = await callMain(['--version']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
});

test('riverwright help lists commands', async () => {
  const r = await callMain(['help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: riverwright <command>/);
  assert.match(r.stdout, /\bversion\b/);
});

test('an unknown command exits 2 and names the command', async () => {
  const r = await callMain(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command "frobnicate"/);
});

test('the real entry point runs under the current node', () => {
  const r = runRiverwright(['--version']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

test('an error message that embeds multi-line file content cannot forge a whole line', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"a": 1}\nLedger intact: 99 events\u001b[2J');
  const r = await callMain(['setup', '--project', '--yes', '--repo', dir], { env: { RIVERWRIGHT_HOME: tmpDir('riverwright-home-') }, testing: { now: 't' } });
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(r.stderr), JSON.stringify(r.stderr));
});

test('error output stays informative and every continuation line is indented', async () => {
  const r = await callMain(['ledger', 'verify', '--dir', '/nonexistent\nLedger intact: 9 events']);
  for (const line of r.stderr.split('\n').filter(Boolean)) assert.ok(/^(riverwright|\s)/.test(line) || !/Ledger intact: 9/.test(line.split(' ')[0]), line);
  assert.ok(!r.stderr.split('\n').some((l) => l.startsWith('Ledger intact')), JSON.stringify(r.stderr));
});
