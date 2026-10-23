import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inspectRepo, planIntegration, applyPlan, backupRoot } from '../scripts/lib/project.mjs';
import { callMain, tmpDir } from './helpers.mjs';

function repo(files = {}) {
  const root = tmpDir('repo-');
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), text);
  return root;
}
const home = () => tmpDir('riverwright-home-');
const plan = (root, h) => planIntegration(inspectRepo(root, { home: h }), { version: '0.1.0' });
const manifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const posixOnly = { skip: process.platform === 'win32' };

test('two setups in the same millisecond keep separate backup folders and manifests', async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const h = home();
  const now = '2026-09-29T00:00:00.000Z';
  const first = await applyPlan(plan(root, h), { home: h, now, confirm: async (s) => s.file === 'AGENTS.md' });
  const second = await applyPlan(plan(root, h), { home: h, now });
  assert.notEqual(first.backup, second.backup);
  for (const b of [first.backup, second.backup]) assert.match(path.basename(b), /^2026-09-29T00-00-00-000Z-[0-9a-f]{8}$/);
  assert.deepEqual(manifest(first.backup).steps.map((s) => s.file), ['AGENTS.md']);
  assert.deepEqual(manifest(second.backup).steps.map((s) => s.file), ['riverwright.json']);
});

test('a backups folder that is a link is refused before anything is written', posixOnly, async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const h = home();
  const out = tmpDir('outside-');
  fs.symlinkSync(out, path.join(h, 'backups'));
  const asked = [];
  await assert.rejects(applyPlan(plan(root, h), { home: h, now: 't', confirm: async (s) => { asked.push(s.file); return true; } }), /link/);
  assert.deepEqual(asked, []);
  assert.deepEqual(fs.readdirSync(out), []);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# A\n');
  assert.equal(fs.existsSync(path.join(root, 'riverwright.json')), false);
});

test('a per-repository backup folder that is a link is refused', posixOnly, async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const h = home();
  const out = tmpDir('outside-');
  fs.mkdirSync(path.join(h, 'backups'));
  fs.symlinkSync(out, backupRoot(h, root));
  await assert.rejects(applyPlan(plan(root, h), { home: h, now: 't' }), /link/);
  assert.deepEqual(fs.readdirSync(out), []);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# A\n');
});

test('setup reports a linked backups folder and changes nothing', posixOnly, async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const h = home();
  const out = tmpDir('outside-');
  fs.symlinkSync(out, path.join(h, 'backups'));
  const r = await callMain(['setup', '--project', '--yes', '--repo', root], { env: { RIVERWRIGHT_HOME: h } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /backups/);
  assert.deepEqual(fs.readdirSync(out), []);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# A\n');
});
