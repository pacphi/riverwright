import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadState } from '../scripts/lib/state.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';
import { callMain, tmpDir } from './helpers.mjs';

const PAST = '1999-01-01T00:00:00.000Z';
const recent = (iso) => Math.abs(Date.parse(iso) - Date.now()) < 60_000;

test('UPF_NOW is ignored outside the test suite: state, approvals and the ledger use the real clock', async () => {
  const dir = tmpDir();
  const env = { UPF_RUN_DIR: dir, UPF_NOW: PAST };
  assert.equal((await callMain(['state', 'create', '--id', 'o/r#1'], { env })).code, 0);
  const r = await callMain(['approve', 'checkpoint-1', '--sha', 'a'.repeat(40)], { env });
  assert.equal(r.code, 0, r.stderr);
  const s = loadState(dir);
  assert.ok(recent(s.createdAt), s.createdAt);
  assert.ok(recent(s.approvals[0].approvedAt), s.approvals[0].approvedAt);
  for (const e of readLedger(dir)) assert.ok(recent(e.at), e.at);
});

test('UPF_NOW is ignored by evidence, fingerprint and setup outside the test suite', async () => {
  const out = path.join(tmpDir(), 'e.json');
  assert.equal((await callMain(['evidence', 'export', '--home', tmpDir(), '--out', out], { env: { UPF_NOW: PAST } })).code, 0);
  assert.ok(recent(JSON.parse(fs.readFileSync(out, 'utf8')).generatedAt));
  const fp = path.join(tmpDir(), 'f.json');
  assert.equal((await callMain(['fingerprint', '--repo', tmpDir(), '--out', fp], { env: { UPF_NOW: PAST } })).code, 0);
  assert.ok(recent(JSON.parse(fs.readFileSync(fp, 'utf8')).collectedAt));
  const home = tmpDir('upf-home-');
  const repo = tmpDir('repo-');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# A\n');
  assert.equal((await callMain(['setup', '--project', '--yes', '--repo', repo], { env: { UPF_HOME: home, UPF_NOW: PAST } })).code, 0);
  const [backup] = fs.readdirSync(fs.readdirSync(path.join(home, 'backups')).map((d) => path.join(home, 'backups', d))[0]);
  assert.doesNotMatch(backup, /^1999/);
});

test('UPF_NOW pins the clock when UPF_TEST=1', async () => {
  const dir = tmpDir();
  const env = { UPF_RUN_DIR: dir, UPF_NOW: PAST, UPF_TEST: '1' };
  await callMain(['state', 'create', '--id', 'o/r#1'], { env });
  const r = await callMain(['approve', 'checkpoint-1', '--sha', 'a'.repeat(40)], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(loadState(dir).createdAt, PAST);
  assert.equal(loadState(dir).approvals[0].approvedAt, PAST);
});
