import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { riverwrightHome, parseIssueRef, runId, runDir, isInside, realish, runDirForPath } from '../scripts/lib/paths.mjs';
import { tmpDir } from './helpers.mjs';

test('riverwrightHome prefers RIVERWRIGHT_HOME and defaults to ~/.riverwright', () => {
  assert.equal(riverwrightHome({ RIVERWRIGHT_HOME: path.join(os.tmpdir(), 'x') }), path.resolve(path.join(os.tmpdir(), 'x')));
  assert.equal(riverwrightHome({}), path.join(os.homedir(), '.riverwright'));
});

test('parseIssueRef accepts issue URLs and owner/repo#n', () => {
  assert.deepEqual(parseIssueRef('https://github.com/ruvnet/ruflo/issues/3509'), { owner: 'ruvnet', repo: 'ruflo', number: 3509 });
  assert.deepEqual(parseIssueRef('proffesor-for-testing/agentic-qe#753'), { owner: 'proffesor-for-testing', repo: 'agentic-qe', number: 753 });
  assert.equal(runId({ owner: 'o', repo: 'r', number: 1 }), 'o/r#1');
});

test('parseIssueRef rejects traversal and malformed input', () => {
  for (const bad of ['../x/y#1', 'o/..#1', 'o/r#0', 'o/r#abc', 'https://github.com/o/r/pull/3', '']) {
    assert.throws(() => parseIssueRef(bad), /not|valid/, bad);
  }
});

test('runDir nests under the home', () => {
  const home = tmpDir();
  assert.equal(runDir(home, { owner: 'o', repo: 'r', number: 7 }), path.join(home, 'o', 'r', 'runs', 'issue-7'));
});

test('isInside resolves symlinked temp dirs (macOS /tmp → /private/tmp)', () => {
  const home = tmpDir();
  const unresolved = path.join(os.tmpdir(), path.basename(home));
  assert.equal(isInside(path.join(unresolved, 'o', 'r'), home), true);
  assert.equal(isInside(home, home), true);
  assert.equal(isInside(path.dirname(home), home), false);
  fs.mkdirSync(path.join(path.dirname(home), `..${path.basename(home)}`), { recursive: true });
  assert.equal(isInside(path.join(path.dirname(home), `..${path.basename(home)}`), home), false);
  assert.equal(realish(path.join(home, 'missing', 'leaf')), path.join(home, 'missing', 'leaf'));
});

test('runDirForPath maps a worktree path to its run directory', () => {
  const home = tmpDir();
  const wt = path.join(home, 'o', 'r', 'worktrees', 'issue-9', 'src');
  assert.equal(runDirForPath(home, wt), path.join(home, 'o', 'r', 'runs', 'issue-9'));
  assert.equal(runDirForPath(home, path.join(home, 'o', 'r', 'clone')), null);
  assert.equal(runDirForPath(home, os.homedir()), null);
});
