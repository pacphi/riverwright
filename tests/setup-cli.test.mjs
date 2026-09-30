import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { callMain, fakeTerminal, tmpDir } from './helpers.mjs';

function repo(files = {}) {
  const root = tmpDir('repo-');
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), text);
  return root;
}

test('--dry-run prints the diff and changes nothing', async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const r = await callMain(['setup', '--project', '--dry-run', '--repo', root], { env: { RIVERWRIGHT_HOME: tmpDir('riverwright-home-') } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\+<!-- BEGIN riverwright -->/);
  assert.match(r.stdout, /Dry run: nothing was changed/);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# A\n');
  assert.equal(fs.existsSync(path.join(root, 'riverwright.json')), false);
});

test('--yes applies and reminds the user nothing was committed', async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const r = await callMain(['setup', '--project', '--yes', '--repo', root], { env: { RIVERWRIGHT_HOME: tmpDir('riverwright-home-'), RIVERWRIGHT_TEST: '1', RIVERWRIGHT_NOW: 't' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /AGENTS\.md: updated/);
  assert.match(r.stdout, /Nothing was committed/);
});

test('interactive mode asks per file', async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const answers = ['y', 'n'];
  const r = await callMain(['setup', '--project', '--repo', root], { env: { RIVERWRIGHT_HOME: tmpDir('riverwright-home-'), RIVERWRIGHT_TEST: '1', RIVERWRIGHT_NOW: 't' }, terminal: () => fakeTerminal(answers.shift()) });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /AGENTS\.md: updated/);
  assert.match(r.stdout, /riverwright\.json: declined/);
});

test('--remove --yes undoes a setup', async () => {
  const root = repo({ 'AGENTS.md': '# A\n' });
  const env = { RIVERWRIGHT_HOME: tmpDir('riverwright-home-'), RIVERWRIGHT_TEST: '1', RIVERWRIGHT_NOW: 't' };
  await callMain(['setup', '--project', '--yes', '--repo', root], { env });
  const r = await callMain(['setup', '--project', '--remove', '--yes', '--repo', root], { env: { ...env, RIVERWRIGHT_NOW: 't2' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# A\n');
  assert.equal(fs.existsSync(path.join(root, 'riverwright.json')), false);
});

test('without --project, setup explains how to use it', async () => {
  const r = await callMain(['setup'], { env: {} });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /riverwright setup --project/);
});
