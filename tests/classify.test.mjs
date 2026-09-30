import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand } from '../scripts/lib/hooks/classify.mjs';

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

test('upf submit and upf post are the sanctioned publish commands', () => {
  assert.deepEqual(classifyCommand('upf submit ruvnet/ruflo#3509'), { outward: false, upfPublish: true });
  assert.deepEqual(classifyCommand('node "/x y/scripts/upf.mjs" post o/r#1 comment'), { outward: false, upfPublish: true });
  assert.equal(classifyCommand('upf submit o/r#1 && git push').outward, true);
});
