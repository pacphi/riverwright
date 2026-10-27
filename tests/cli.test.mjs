import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMain, runRiverwright } from './helpers.mjs';

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
