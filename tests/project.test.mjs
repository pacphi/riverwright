import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inspectRepo, planIntegration, applyPlan, changedFiles, REGISTRY } from '../scripts/lib/project.mjs';
import { runFile } from '../scripts/lib/exec.mjs';
import { tmpDir } from './helpers.mjs';

const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function repo(files = {}) {
  const root = tmpDir('repo-');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const home = () => tmpDir('riverwright-home-');
const plan = (root, h, opts = {}) => planIntegration(inspectRepo(root, { home: h }), { version: '0.1.0', ...opts });
const actions = (p) => Object.fromEntries(p.steps.map((s) => [s.file, s.action]));

test('an empty repository gets AGENTS.md and riverwright.json, and a second run changes nothing', async () => {
  const root = repo();
  const h = home();
  const p = plan(root, h);
  assert.deepEqual(actions(p), { 'AGENTS.md': 'create', 'riverwright.json': 'create' });
  await applyPlan(p, { home: h, now: '2026-09-29T00:00:00Z' });
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /<!-- BEGIN riverwright -->/);
  assert.deepEqual(plan(root, h).steps, []);
});

test('an agentic-kit-style repo: only AGENTS.md changes, other blocks and CLAUDE.md untouched, registry linked', async () => {
  const agents = '# Agents\n\n<!-- BEGIN AGENTIC-QE CODEX -->\naqe\n<!-- END AGENTIC-QE CODEX -->\n';
  const root = repo({ 'AGENTS.md': agents, 'CLAUDE.md': '# Claude\n@AGENTS.md\n', [REGISTRY]: '{}' });
  const h = home();
  const claudeBefore = hash(path.join(root, 'CLAUDE.md'));
  const p = plan(root, h);
  assert.deepEqual(actions(p), { 'AGENTS.md': 'update', 'riverwright.json': 'create' });
  await applyPlan(p, { home: h, now: 't1' });
  assert.ok(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8').startsWith(agents));
  assert.equal(hash(path.join(root, 'CLAUDE.md')), claudeBefore);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'riverwright.json'), 'utf8')).registry, REGISTRY);
});

test('CLAUDE.md as a symlink to AGENTS.md is written once and stays a symlink', { skip: process.platform === 'win32' }, async () => {
  const root = repo({ 'AGENTS.md': '# Agents\n' });
  fs.symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'));
  const h = home();
  const p = plan(root, h);
  assert.deepEqual(Object.keys(actions(p)).sort(), ['AGENTS.md', 'riverwright.json']);
  await applyPlan(p, { home: h, now: 't' });
  assert.equal(fs.lstatSync(path.join(root, 'CLAUDE.md')).isSymbolicLink(), true);
});

test('a repo with only CLAUDE.md gets the block there and no new AGENTS.md', () => {
  const root = repo({ 'CLAUDE.md': '# Claude\n' });
  assert.deepEqual(actions(plan(root, home())), { 'CLAUDE.md': 'update', 'riverwright.json': 'create' });
});

test('GEMINI.md is skipped when Gemini already reads AGENTS.md', () => {
  const root = repo({ 'AGENTS.md': '# A\n', 'GEMINI.md': '# G\n', '.gemini/settings.json': '{"context":{"fileName":["AGENTS.md","GEMINI.md"]}}' });
  assert.equal(actions(plan(root, home()))['GEMINI.md'], undefined);
});

test('a Cursor rule is created only when the repo already uses Cursor', () => {
  assert.equal(actions(plan(repo(), home()))['.cursor/rules/riverwright.mdc'], undefined);
  assert.equal(actions(plan(repo({ '.cursor/rules/x.mdc': 'x' }), home()))['.cursor/rules/riverwright.mdc'], 'create');
});

test('team settings: comments mean a snippet instead of an edit', async () => {
  const text = '{\n  // mine\n  "model": "x"\n}\n';
  const root = repo({ 'AGENTS.md': '# A\n', '.claude/settings.json': text });
  const h = home();
  const p = plan(root, h, { team: true });
  assert.equal(actions(p)['.claude/settings.json'], 'print-snippet');
  await applyPlan(p, { home: h, now: 't' });
  assert.equal(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'), text);
});

test('team settings: only absent keys are added, indent and existing values kept', () => {
  const text = '{\n    "enabledPlugins": {\n        "other@x": true\n    }\n}\n';
  const root = repo({ 'AGENTS.md': '# A\n', '.claude/settings.json': text });
  const step = plan(root, home(), { team: true }).steps.find((s) => s.file === '.claude/settings.json');
  const after = JSON.parse(step.after);
  assert.equal(after.enabledPlugins['other@x'], true);
  assert.equal(after.enabledPlugins['riverwright@riverwright'], true);
  assert.match(step.after, /\n {8}"other@x"/);
});

test('read-only files get a snippet, not an edit', { skip: process.platform === 'win32' }, () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  fs.chmodSync(path.join(root, 'AGENTS.md'), 0o444);
  assert.equal(actions(plan(root, home()))['AGENTS.md'], 'print-snippet');
});

test('files with uncommitted changes get a snippet, not an edit', async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  await runFile('git', ['init', '-q'], { cwd: root });
  await runFile('git', ['add', '.'], { cwd: root });
  await runFile('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  fs.appendFileSync(path.join(root, 'AGENTS.md'), 'work in progress\n');
  const p = planIntegration(inspectRepo(root, { home: home() }), { version: '0.1.0', changed: await changedFiles(root) });
  assert.equal(actions(p)['AGENTS.md'], 'print-snippet');
});

test('an instruction file linked to somewhere outside the repo is not written through', { skip: process.platform === 'win32' }, () => {
  const shared = repo({ 'AGENTS.md': '# Shared\n' });
  const root = repo();
  fs.symlinkSync(path.join(shared, 'AGENTS.md'), path.join(root, 'AGENTS.md'));
  assert.equal(actions(plan(root, home()))['AGENTS.md'], 'print-snippet');
});

test('the upstream clone inside the workspace is refused', () => {
  const h = home();
  const clone = path.join(h, 'o', 'r', 'clone');
  fs.mkdirSync(clone, { recursive: true });
  assert.throws(() => inspectRepo(clone, { home: h }), /inside the Riverwright workspace/);
});

test('backups and the manifest live outside the repository', async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const h = home();
  const { backup } = await applyPlan(plan(root, h), { home: h, now: '2026-09-29T00:00:00Z' });
  assert.ok(backup.startsWith(h));
  assert.equal(fs.readFileSync(path.join(backup, 'files', 'AGENTS.md'), 'utf8'), '# A\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8')).mode, 'install');
});

test('declined steps are not written', async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const h = home();
  const { results } = await applyPlan(plan(root, h), { home: h, now: 't', confirm: async (s) => s.file !== 'AGENTS.md' });
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# A\n');
  assert.equal(results.find((r) => r.file === 'AGENTS.md').result, 'declined');
});

const posixOnly = { skip: process.platform === 'win32' };
const outsideDir = () => tmpDir('outside-');

test('a dangling symlink in place of a new file is not written through', posixOnly, async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const out = outsideDir();
  fs.symlinkSync(path.join(out, 'planted.json'), path.join(root, 'riverwright.json'));
  const h = home();
  const p = plan(root, h);
  assert.equal(actions(p)['riverwright.json'], 'print-snippet');
  await applyPlan(p, { home: h, now: 't' });
  assert.equal(fs.existsSync(path.join(out, 'planted.json')), false);
});

test('a dangling AGENTS.md symlink is not written through', posixOnly, async () => {
  const root = repo();
  const out = outsideDir();
  fs.symlinkSync(path.join(out, 'AGENTS.md'), path.join(root, 'AGENTS.md'));
  const h = home();
  const p = plan(root, h);
  assert.equal(actions(p)['AGENTS.md'], 'print-snippet');
  await applyPlan(p, { home: h, now: 't' });
  assert.deepEqual(fs.readdirSync(out), []);
});

test('a folder on the way that links outside the repository is not written through', posixOnly, async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const out = outsideDir();
  fs.mkdirSync(path.join(out, 'rules'));
  fs.symlinkSync(out, path.join(root, '.cursor'));
  const claudeOut = outsideDir();
  fs.symlinkSync(claudeOut, path.join(root, '.claude'));
  const h = home();
  const p = plan(root, h, { team: true });
  assert.equal(actions(p)['.cursor/rules/riverwright.mdc'], 'print-snippet');
  assert.equal(actions(p)['.claude/settings.json'], 'print-snippet');
  await applyPlan(p, { home: h, now: 't' });
  assert.deepEqual(fs.readdirSync(path.join(out, 'rules')), []);
  assert.deepEqual(fs.readdirSync(claudeOut), []);
});

test('applyPlan refuses a create through a broken folder link even if the plan says create', posixOnly, async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const out = outsideDir();
  fs.symlinkSync(path.join(out, 'gone'), path.join(root, '.cursor'));
  const h = home();
  const forged = { root, mode: 'install', steps: [{ file: '.cursor/rules/riverwright.mdc', kind: 'owned-file', action: 'create', before: null, after: 'x' }] };
  const { results } = await applyPlan(forged, { home: h, now: 't' });
  assert.equal(results[0].result, 'refused');
  assert.equal(fs.existsSync(path.join(out, 'gone')), false);
});

test('a symlink between files inside the repository is still followed for instruction files', posixOnly, async () => {
  const root = repo({ 'docs/AGENTS.md': '# Shared\n' });
  fs.symlinkSync(path.join('docs', 'AGENTS.md'), path.join(root, 'AGENTS.md'));
  const h = home();
  const p = plan(root, h);
  assert.equal(actions(p)['AGENTS.md'], 'update');
  await applyPlan(p, { home: h, now: 't' });
  assert.match(fs.readFileSync(path.join(root, 'docs', 'AGENTS.md'), 'utf8'), /BEGIN riverwright/);
  assert.equal(fs.lstatSync(path.join(root, 'AGENTS.md')).isSymbolicLink(), true);
});
