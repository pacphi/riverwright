import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inspectRepo, planIntegration, planRemoval, applyPlan, backupRoot } from '../scripts/lib/project.mjs';
import { tmpDir } from './helpers.mjs';

function repo(files = {}) {
  const root = tmpDir('repo-');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const snapshot = (root) => Object.fromEntries(
  fs.readdirSync(root, { recursive: true }).filter((f) => fs.statSync(path.join(root, f)).isFile()).sort().map((f) => [f.split(path.sep).join('/'), fs.readFileSync(path.join(root, f), 'utf8')]),
);
async function install(root, h, opts = {}) {
  return applyPlan(planIntegration(inspectRepo(root, { home: h }), { version: '0.1.0', ...opts }), { home: h, now: '2026-09-29T00:00:00Z' });
}
async function remove(root, h) {
  return applyPlan(planRemoval(inspectRepo(root, { home: h }), { home: h }), { home: h, now: '2026-09-29T01:00:00Z' });
}

test('install then remove leaves an existing repo byte-identical (CRLF, no final newline)', async () => {
  const root = repo({ 'AGENTS.md': '# Agents\r\nText', 'README.md': 'hi\n' });
  const h = tmpDir('upf-home-');
  const before = snapshot(root);
  await install(root, h);
  await remove(root, h);
  assert.deepEqual(snapshot(root), before);
});

test('files upstream-pr-filer created are deleted on removal', async () => {
  const root = repo();
  const h = tmpDir('upf-home-');
  await install(root, h);
  await remove(root, h);
  assert.deepEqual(snapshot(root), {});
});

test('a created file the user has since edited is kept, with a reason', async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const h = tmpDir('upf-home-');
  await install(root, h);
  fs.writeFileSync(path.join(root, '.upstream-pr.json'), '{"preset":"thorough","upstreams":[]}\n');
  const { results } = await remove(root, h);
  assert.equal(results.find((r) => r.file === '.upstream-pr.json').result, 'kept');
  assert.ok(fs.existsSync(path.join(root, '.upstream-pr.json')));
});

test('merged team settings are restored byte-for-byte', async () => {
  const settings = '{\n  "enabledPlugins": { "other@x": true },\n  "list": [1, 2]\n}\n';
  const root = repo({ 'AGENTS.md': '# A\n', '.claude/settings.json': settings });
  const h = tmpDir('upf-home-');
  await install(root, h, { team: true });
  assert.notEqual(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'), settings);
  await remove(root, h);
  assert.equal(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'), settings);
});

test('without backups, our blocks are still removed and other files are left alone', async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const h = tmpDir('upf-home-');
  await install(root, h);
  fs.rmSync(backupRoot(h, root), { recursive: true, force: true });
  await remove(root, h);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# A\n');
  assert.ok(fs.existsSync(path.join(root, '.upstream-pr.json')));
});
