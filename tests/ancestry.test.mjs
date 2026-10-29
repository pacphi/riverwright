// Ruling R33: the pre-push guard's own ancestry walk over hash-checked objects, and the allowlisted environment of
// every git process the guard starts. All git here reads no global or system config; nothing reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardGitEnv, isVerifiedAncestor } from '../scripts/lib/ancestry.mjs';
import { tmpDir } from './helpers.mjs';

function chain(n, { format } = {}) {
  const dir = tmpDir('riverwright-ancestry-');
  const cfg = path.join(dir, 'gitconfig');
  fs.writeFileSync(cfg, '');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', env });
  git('init', '-q', ...(format ? [`--object-format=${format}`] : []));
  const shas = [];
  for (let i = 0; i < n; i += 1) {
    git('commit', '-q', '--allow-empty', '-m', `c${i}`);
    shas.push(git('rev-parse', 'HEAD').stdout.trim());
  }
  return { repo, git, shas };
}

test('the guard\'s git environment is built from an allowlist, never from the pushing shell', () => {
  const shell = {
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C', HOME: '/home/agent', USERPROFILE: 'C:\\x', XDG_CONFIG_HOME: '/x',
    GIT_TEST_COMMIT_GRAPH: '1', GIT_TEST_ANYTHING: '1', GIT_OBJECT_DIRECTORY: '/x', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/y',
    GIT_SSH_COMMAND: 'evil', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.commitGraph', GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_PARAMETERS: "'core.commitgraph'='true'", GIT_DIR: '/elsewhere', GIT_REPLACE_REF_BASE: 'refs/x/', FOO: 'bar',
    SYSTEMROOT: 'C:\\Windows', TEMP: '/t',
  };
  const env = guardGitEnv({ env: shell, platform: 'linux' });
  assert.deepEqual(Object.keys(env).sort(), [
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_GRAFT_FILE', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'GIT_OPTIONAL_LOCKS',
    'GIT_TERMINAL_PROMPT', 'LANG', 'LC_ALL', 'PATH',
  ]);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_NO_REPLACE_OBJECTS, '1');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_GRAFT_FILE, '/dev/null');
  // Windows keeps what a process there needs to start, whatever the case of the names.
  const win = guardGitEnv({ env: { Path: 'C:\\git\\cmd', SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', TMP: 'C:\\t', PATHEXT: '.EXE', ComSpec: 'C:\\cmd.exe', GIT_TEST_X: '1', USERPROFILE: 'C:\\u' }, platform: 'win32' });
  assert.deepEqual(Object.keys(win).filter((k) => !k.startsWith('GIT_')).sort(), ['ComSpec', 'PATHEXT', 'Path', 'SystemRoot', 'TEMP', 'TMP']);
  assert.equal(win.GIT_TEST_X, undefined);
});

test('a real ancestor is found; a non-ancestor, an unknown tip and an equal tip are answered correctly', async () => {
  const { repo, shas } = chain(5);
  const env = guardGitEnv();
  assert.equal(await isVerifiedAncestor({ cwd: repo, env, ancestor: shas[0], descendant: shas[4] }), true);
  assert.equal(await isVerifiedAncestor({ cwd: repo, env, ancestor: shas[4], descendant: shas[0] }), false);
  assert.equal(await isVerifiedAncestor({ cwd: repo, env, ancestor: 'd'.repeat(40), descendant: shas[4] }), false);
  assert.equal(await isVerifiedAncestor({ cwd: repo, env, ancestor: shas[2], descendant: shas[2] }), true);
});

test('the walk stops at its caps and fails closed', async () => {
  const { repo, shas } = chain(6);
  const env = guardGitEnv();
  assert.equal(await isVerifiedAncestor({ cwd: repo, env, ancestor: shas[0], descendant: shas[5], maxCommits: 5 }), true);
  assert.equal(await isVerifiedAncestor({ cwd: repo, env, ancestor: shas[0], descendant: shas[5], maxCommits: 4 }), false);
  assert.equal(await isVerifiedAncestor({ cwd: repo, env, ancestor: shas[0], descendant: shas[5], maxBytes: 300 }), false);
});

test('a tip that is not a commit, a SHA of the wrong length for the repository, or no repository at all fails closed', async () => {
  const { repo, git, shas } = chain(2);
  const env = guardGitEnv();
  const tree = git('rev-parse', 'HEAD^{tree}').stdout.trim();
  assert.equal(await isVerifiedAncestor({ cwd: repo, env, ancestor: shas[0], descendant: tree }), false);
  assert.equal(await isVerifiedAncestor({ cwd: repo, env, ancestor: 'a'.repeat(64), descendant: 'b'.repeat(64) }), false);
  assert.equal(await isVerifiedAncestor({ cwd: repo, env, ancestor: shas[0], descendant: 'not a sha' }), false);
  assert.equal(await isVerifiedAncestor({ cwd: tmpDir('riverwright-norepo-'), env, ancestor: shas[0], descendant: shas[1] }), false);
});

test('a sha256 repository is walked with sha256', async () => {
  const { repo, shas } = chain(3, { format: 'sha256' });
  assert.equal(shas[0].length, 64);
  assert.equal(await isVerifiedAncestor({ cwd: repo, env: guardGitEnv(), ancestor: shas[0], descendant: shas[2] }), true);
  assert.equal(await isVerifiedAncestor({ cwd: repo, env: guardGitEnv(), ancestor: shas[2], descendant: shas[0] }), false);
});
