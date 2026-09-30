import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildEvidence, collectRunStates } from '../scripts/lib/evidence.mjs';
import { createState, beginStation, completeStation, saveState } from '../scripts/lib/state.mjs';
import { callMain, tmpDir } from './helpers.mjs';

function passedIntake() {
  let s = createState({ runId: 'ruvnet/ruflo#3509', kind: 'fixture', now: 't0' });
  for (const st of ['start', 'intake']) s = completeStation(beginStation(s, st, { now: 't1', host: 'claude-code', model: 'm' }), st, 'passed', { now: 't2' });
  return s;
}

test('buildEvidence reports each station status per run', () => {
  const ev = buildEvidence({ states: [passedIntake()], hosts: { 'grok-build': { level: 2, version: '1.0.44' } }, now: 'now' });
  assert.equal(ev.schema, 'riverwright-evidence/1');
  assert.equal(ev.runs[0].id, 'ruvnet/ruflo#3509');
  assert.equal(ev.runs[0].kind, 'fixture');
  assert.equal(ev.runs[0].stations.intake.status, 'passed');
  assert.equal(ev.runs[0].stations.intake.host, 'claude-code');
  assert.equal(ev.runs[0].stations.recon.status, 'pending');
  assert.deepEqual(ev.runs[0].pr, { url: null, state: null });
});

test('buildEvidence rejects unknown hosts and levels outside 1–3', () => {
  assert.throws(() => buildEvidence({ states: [], hosts: { vim: { level: 2 } }, now: 't' }), /unknown host/);
  assert.throws(() => buildEvidence({ states: [], hosts: { codex: { level: 4 } }, now: 't' }), /level/);
});

test('collectRunStates finds runs and skips broken ones with a reason', () => {
  const home = tmpDir('riverwright-home-');
  saveState(path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509'), passedIntake());
  const broken = path.join(home, 'o', 'r', 'runs', 'issue-1');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'state.json'), '{nope');
  fs.mkdirSync(path.join(home, 'backups', 'x-12345678'), { recursive: true });
  const { states, skipped } = collectRunStates(home);
  assert.deepEqual(states.map((s) => s.runId), ['ruvnet/ruflo#3509']);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /not valid JSON/);
});

test('riverwright evidence export writes evidence.json with host levels', async () => {
  const home = tmpDir('riverwright-home-');
  saveState(path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509'), passedIntake());
  const hostsFile = path.join(tmpDir(), 'hosts.json');
  fs.writeFileSync(hostsFile, JSON.stringify({ 'claude-code': { level: 2, version: '2.1.284' } }));
  const out = path.join(tmpDir(), 'evidence.json');
  const r = await callMain(['evidence', 'export', '--home', home, '--hosts', hostsFile, '--out', out], { env: { RIVERWRIGHT_TEST: '1', RIVERWRIGHT_NOW: 'now' } });
  assert.equal(r.code, 0, r.stderr);
  const ev = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(ev.hosts['claude-code'].level, 2);
  assert.equal(ev.runs.length, 1);
});
