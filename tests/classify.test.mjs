import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyCommand } from '../scripts/lib/hooks/classify.mjs';
import { ROOT, tmpDir } from './helpers.mjs';

const OUTWARD = [
  'git push',
  'pytest -q && git push origin upf/1-x',
  'bash -c "git push origin x"',
  'git -C ../w push',
  '/usr/bin/git push --force',
  'git.exe push',
  'GIT_DIR=x git push',
  'echo ok; git push',
  'git -c core.hooksPath=/dev/null commit -m x',
  'git config core.hooksPath /tmp/h',
  'git remote set-url origin https://github.com/x/y',
  'git config remote.origin.pushurl https://github.com/x/y',
  'gh pr create --fill',
  'gh -R o/r pr create',
  'gh issue comment 1 -b hi',
  'gh repo fork o/r',
  'gh api repos/o/r/pulls -f title=x',
  'gh api -X POST repos/o/r/issues',
  'gh api --method=PATCH repos/o/r',
  'gh auth token',
];

const SAFE = [
  'git status',
  'git log --grep push',
  'git commit -m "fix: push button label"',
  'git config user.name Jane',
  'gh issue view 12 --json body',
  'gh pr list',
  'gh api repos/o/r/issues/12',
  'gh api -X GET search/issues -f q=x',
  'npm test',
];

for (const cmd of OUTWARD) {
  test(`outward: ${cmd}`, () => assert.equal(classifyCommand(cmd).outward, true));
}
for (const cmd of SAFE) {
  test(`safe: ${cmd}`, () => assert.equal(classifyCommand(cmd).outward, false));
}

// The exemption is found by the installed launcher's real path, not by the program's name.
const trustedLauncher = [path.join(ROOT, 'bin', 'upf'), path.join(ROOT, 'bin', 'upf.cmd'), path.join(ROOT, 'scripts', 'upf.mjs')];
const launcher = path.join(ROOT, 'bin', 'upf');
const script = path.join(ROOT, 'scripts', 'upf.mjs');

test('upf submit and upf post are the sanctioned publish commands', () => {
  assert.deepEqual(classifyCommand(`"${launcher}" submit ruvnet/ruflo#3509`, { trustedLauncher }), { outward: false, upfPublish: true });
  assert.deepEqual(classifyCommand(`node "${script}" post o/r#1 comment`, { trustedLauncher }), { outward: false, upfPublish: true });
  assert.equal(classifyCommand(`"${launcher}" submit o/r#1 && git push`, { trustedLauncher }).outward, true);
});

test('a program merely named upf or upf.mjs is not the sanctioned launcher', () => {
  for (const cmd of ['/tmp/upf submit git push origin HEAD', 'node /tmp/upf.mjs post gh pr create', 'upf submit git push origin HEAD', './upf post gh pr create']) {
    for (const v of [classifyCommand(cmd, { trustedLauncher }), classifyCommand(cmd)]) {
      assert.equal(v.outward, true, cmd);
      assert.notEqual(v.upfPublish, true, cmd);
    }
  }
});

test('the real launcher is exempt only as one plain command', () => {
  assert.equal(classifyCommand(`${launcher} submit o/r#1 && git push`, { trustedLauncher }).outward, true);
  assert.equal(classifyCommand(`${launcher} submit git push; git push`, { trustedLauncher }).outward, true);
  assert.equal(classifyCommand(`${launcher} submit $(git push)`, { trustedLauncher }).outward, true);
  assert.equal(classifyCommand(`${launcher} post gh pr create > /tmp/x`, { trustedLauncher }).upfPublish, undefined);
  assert.equal(classifyCommand(`/tmp/node ${script} submit git push`, { trustedLauncher }).outward, true);
});

test('a symlink to the real launcher resolves to it', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir();
  const link = path.join(dir, 'upf');
  fs.symlinkSync(launcher, link);
  assert.deepEqual(classifyCommand(`${link} submit o/r#1`, { trustedLauncher }), { outward: false, upfPublish: true });
});
