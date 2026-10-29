// Task 14: a leased re-submit after an amend (ADR-0012), and the fork bound into the signed receipt (R16(b)).
// Every git process here reads no global or system config (an insteadOf there could redirect a push), and every
// push goes to a local bare repository: nothing reaches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import { createState, saveState, setFork } from '../scripts/lib/state.mjs';
import { runRiverwright, tmpDir } from './helpers.mjs';
import { armRun, runDirIn } from './receipt-helpers.mjs';

const FORK = 'https://github.com/pacphi/ruflo.git';
const BRANCH = 'riverwright/3509-codex';

function isolatedGitEnv() {
  const dir = tmpDir('riverwright-gitenv-');
  const empty = path.join(dir, 'gitconfig');
  fs.writeFileSync(empty, '');
  return {
    GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir, GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    RIVERWRIGHT_TEST: '', RIVERWRIGHT_RUN_DIR: '',
  };
}

// A worktree where A was pushed first, then the owner amended it to B (A is no longer an ancestor of B), and C
// sits on top of A.
function amended() {
  const env = isolatedGitEnv();
  const home = tmpDir('riverwright-home-');
  const worktree = path.join(home, 'ruvnet', 'ruflo', 'worktrees', 'issue-3509');
  fs.mkdirSync(worktree, { recursive: true });
  const git = (...a) => {
    const r = spawnSync('git', a, { cwd: worktree, encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const sha = (rev = 'HEAD') => git('rev-parse', rev).stdout.trim();
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'fix');
  const A = sha();
  git('commit', '-q', '--allow-empty', '-m', 'more');
  const C = sha();
  git('reset', '-q', '--hard', A);
  git('commit', '-q', '--amend', '--allow-empty', '-m', 'fix (signed off)');
  const B = sha();
  const runDir = runDirIn(home);
  saveState(runDir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
  return { home, worktree, runDir, env, git, A, B, C };
}

// The guard as git runs it: a separate process, from the worktree, with git's config isolated.
const guard = (w, stdin, url = FORK) => runRiverwright(['guard', 'pre-push', '--home', w.home, '--', 'fork', url], { stdin, cwd: w.worktree, env: w.env });
const push = (w, local, remote, url = FORK) => guard(w, `refs/heads/${BRANCH} ${local} refs/heads/${BRANCH} ${remote}\n`, url);

test('an amended commit replaces the old tip only when the receipt leased exactly that tip', () => {
  const w = amended();
  armRun({ home: w.home, runDir: w.runDir, sha: w.B, lease: w.A });
  const r = push(w, w.B, w.A);
  assert.equal(r.code, 0, r.stderr);
});

test('without a lease, or with the wrong lease, the replacement is refused', () => {
  const w = amended();
  armRun({ home: w.home, runDir: w.runDir, sha: w.B });
  const none = push(w, w.B, w.A);
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /replace/);
  const other = amended();
  armRun({ home: other.home, runDir: other.runDir, sha: other.B, lease: other.C });
  const wrong = push(other, other.B, other.A);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr, /not the commit you approved replacing/);
});

test('an ordinary fast-forward needs no lease, and a remote tip we do not have is treated as a replacement', () => {
  const w = amended();
  armRun({ home: w.home, runDir: w.runDir, sha: w.C });
  const ff = push(w, w.C, w.A);
  assert.equal(ff.code, 0, ff.stderr);
  const unknown = amended();
  armRun({ home: unknown.home, runDir: unknown.runDir, sha: unknown.B });
  const r = push(unknown, unknown.B, 'd'.repeat(40));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /replace/);
});

// The question "is this a fast-forward?" is asked of the clone the agent can write. A replace ref, a graft or a
// commit-graph file there could make A look like an ancestor of B; the guard asks git with all three turned off.
test('a replace ref or a graft in the clone cannot make a replacement look like a fast-forward', () => {
  const w = amended();
  armRun({ home: w.home, runDir: w.runDir, sha: w.B });
  // B with A grafted in as its parent, through a replace ref.
  const replaced = w.git('replace', '--graft', w.B, w.A);
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.equal(w.git('merge-base', '--is-ancestor', w.A, w.B).code, 0, 'the replace ref fools a plain merge-base');
  const r = push(w, w.B, w.A);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /replace/);

  const g = amended();
  armRun({ home: g.home, runDir: g.runDir, sha: g.B });
  const gitDir = g.git('rev-parse', '--absolute-git-dir').stdout.trim();
  fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'info', 'grafts'), `${g.B} ${g.A}\n`);
  const graft = push(g, g.B, g.A);
  assert.notEqual(graft.code, 0);
  assert.match(graft.stderr, /replace/);
});

// R16(b): state.json's fork.url is agent-writable. A forged one that names a third-party repository no longer sends
// the approved commit there, because the receipt signed the real fork.
test('a forged fork.url naming a third-party repository cannot send the approved commit there', () => {
  for (const url of ['https://github.com/attacker/ruflo.git', 'git@github.com:attacker/ruflo.git', 'ssh://git@github.com/attacker/ruflo']) {
    const w = amended();
    const forged = setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK);
    forged.fork = { ...forged.fork, url };
    saveState(w.runDir, forged);
    armRun({ home: w.home, runDir: w.runDir, sha: w.B });
    const r = guard(w, `refs/heads/${BRANCH} ${w.B} refs/heads/${BRANCH} ${'0'.repeat(40)}\n`, url);
    assert.notEqual(r.code, 0, url);
    assert.match(r.stderr, /not the fork you approved \(github\.com\/pacphi\/ruflo\)/, url);
  }
});

test('a receipt that signed another fork does not let the push go to the fork in state.json', () => {
  const w = amended();
  armRun({ home: w.home, runDir: w.runDir, sha: w.B, fork: 'github.com/someone-else/ruflo' });
  const r = guard(w, `refs/heads/${BRANCH} ${w.B} refs/heads/${BRANCH} ${'0'.repeat(40)}\n`);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not the fork you approved/);
});

// What git itself hands the hook for the push Plan 2b will run: `--force-with-lease=refs/heads/<branch>:<lease>`
// (always the explicit expected value) to a local bare repository. A recording hook captures the lines; the guard
// then judges exactly those lines. Git refuses a stale lease itself and leaves that ref out of the hook's lines.
test('git\'s explicit --force-with-lease push hands the guard the leased tip, and a stale lease never reaches it', { skip: process.platform === 'win32' }, () => {
  const w = amended();
  const bare = path.join(w.home, 'fork.git');
  assert.equal(w.git('init', '-q', '--bare', bare).code, 0);
  assert.equal(w.git('push', '-q', bare, `${w.A}:refs/heads/${BRANCH}`).code, 0);
  const record = path.join(w.home, 'pre-push-lines');
  const hook = path.join(w.git('rev-parse', '--absolute-git-dir').stdout.trim(), 'hooks', 'pre-push');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\ncat > '${record}'\nexit 0\n`, { mode: 0o755 });

  const stale = w.git('push', `--force-with-lease=refs/heads/${BRANCH}:${w.C}`, bare, `${w.B}:refs/heads/${BRANCH}`);
  assert.notEqual(stale.code, 0, 'git refuses a lease that is not the remote tip');
  assert.match(stale.stderr, /stale info/);
  // Git still runs the hook, but the rejected ref is not among its lines.
  assert.equal(fs.readFileSync(record, 'utf8'), '', 'the stale update never reaches the hook');

  const leased = w.git('push', `--force-with-lease=refs/heads/${BRANCH}:${w.A}`, bare, `${w.B}:refs/heads/${BRANCH}`);
  assert.equal(leased.code, 0, leased.stderr);
  assert.equal(w.git('--git-dir', bare, 'rev-parse', `refs/heads/${BRANCH}`).stdout.trim(), w.B, 'the bare repository now holds the amended commit');
  const lines = fs.readFileSync(record, 'utf8');
  const [, localSha, remoteRef, remoteSha, ...more] = lines.trim().split(/\s+/);
  assert.deepEqual([localSha, remoteRef, remoteSha, more.length], [w.B, `refs/heads/${BRANCH}`, w.A, 0], lines);

  // Judged by the guard: refused under a receipt with no lease, allowed once the newest receipt leases that tip.
  armRun({ home: w.home, runDir: w.runDir, sha: w.B });
  const refused = guard(w, lines);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /replace/);
  armRun({ home: w.home, runDir: w.runDir, sha: w.B, lease: w.A });
  const allowed = guard(w, lines);
  assert.equal(allowed.code, 0, allowed.stderr);
});

// Ruling R33-1. The clone is agent-writable, and git does not check an object's hash while it walks history. A
// loose object rewritten in place (same name, new content) can therefore add a parent git believes. The guard walks
// the ancestry itself and recomputes every object's hash, so the forged parent is not believed.
function forgeLooseCommit(w, sha, extraParent) {
  const body = Buffer.from(w.git('cat-file', 'commit', sha).stdout, 'utf8');
  const text = body.toString('utf8');
  const nl = text.indexOf('\n');
  const forged = Buffer.from(`${text.slice(0, nl + 1)}parent ${extraParent}\n${text.slice(nl + 1)}`, 'utf8');
  const gitDir = w.git('rev-parse', '--absolute-git-dir').stdout.trim();
  const obj = path.join(gitDir, 'objects', sha.slice(0, 2), sha.slice(2));
  fs.chmodSync(obj, 0o644);
  fs.writeFileSync(obj, zlib.deflateSync(Buffer.concat([Buffer.from(`commit ${forged.length}\0`), forged])));
  return gitDir;
}

// The reviewer's probe: the fork branch holds R (someone else's work on P); the agent's approved L also sits on P.
function divergedFork() {
  const w = amended();
  w.git('reset', '-q', '--hard', w.A);
  w.git('commit', '-q', '--allow-empty', '-m', 'maintainer work on the fork branch');
  const R = w.git('rev-parse', 'HEAD').stdout.trim();
  w.git('checkout', '-q', '--detach', w.A);
  w.git('commit', '-q', '--allow-empty', '-m', 'agent L');
  const L = w.git('rev-parse', 'HEAD').stdout.trim();
  return { ...w, P: w.A, R, L };
}

test('a forged ancestor object in the clone does not make a replacement look like a fast-forward (R33-1)', { skip: process.platform === 'win32' }, () => {
  const w = divergedFork();
  armRun({ home: w.home, runDir: w.runDir, sha: w.L });
  const before = push(w, w.L, w.R);
  assert.notEqual(before.code, 0);
  assert.match(before.stderr, /replace/);
  forgeLooseCommit(w, w.P, w.R);
  assert.equal(w.git('merge-base', '--is-ancestor', w.R, w.L).code, 0, 'the forged object fools git itself');
  const after = push(w, w.L, w.R);
  assert.notEqual(after.code, 0, 'the guard must not believe the forged parent');
  assert.match(after.stderr, /replace/);
});

// Ruling R33-2. GIT_TEST_COMMIT_GRAPH=1 in the pushing shell makes git read the commit-graph whatever
// core.commitGraph says. A graph written from a forged object, copied into an intact clone, then claims A is B's parent.
test('GIT_TEST_COMMIT_GRAPH from the pushing shell and a forged commit-graph cannot fake a fast-forward (R33-2)', { skip: process.platform === 'win32' }, () => {
  const w = amended();
  armRun({ home: w.home, runDir: w.runDir, sha: w.B });
  const gitDir = w.git('rev-parse', '--absolute-git-dir').stdout.trim();
  const copy = path.join(tmpDir('riverwright-forge-'), 'repo');
  fs.cpSync(path.dirname(gitDir), copy, { recursive: true });
  const c = { ...w, worktree: copy, git: (...a) => {
    const r = spawnSync('git', a, { cwd: copy, encoding: 'utf8', env: { ...process.env, ...w.env } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  } };
  forgeLooseCommit(c, w.B, w.A);
  assert.equal(c.git('commit-graph', 'write', '--reachable').code, 0);
  fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
  fs.copyFileSync(path.join(copy, '.git', 'objects', 'info', 'commit-graph'), path.join(gitDir, 'objects', 'info', 'commit-graph'));
  const env = { ...w.env, GIT_TEST_COMMIT_GRAPH: '1' };
  const live = spawnSync('git', ['-c', 'core.commitGraph=false', 'merge-base', '--is-ancestor', w.A, w.B], { cwd: w.worktree, env: { ...process.env, ...env } });
  assert.equal(live.status, 0, 'the forged graph fools git when GIT_TEST_COMMIT_GRAPH is set');
  const r = guard({ ...w, env }, `refs/heads/${BRANCH} ${w.B} refs/heads/${BRANCH} ${w.A}\n`);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /replace/);
});

test('a missing ancestor object or a shallow boundary on the way counts as a replacement', () => {
  const w = amended();
  // A -> M -> D: a real fast-forward from A to D.
  w.git('reset', '-q', '--hard', w.A);
  w.git('commit', '-q', '--allow-empty', '-m', 'middle');
  const M = w.git('rev-parse', 'HEAD').stdout.trim();
  w.git('commit', '-q', '--allow-empty', '-m', 'top');
  const D = w.git('rev-parse', 'HEAD').stdout.trim();
  armRun({ home: w.home, runDir: w.runDir, sha: D });
  const ok = push(w, D, w.A);
  assert.equal(ok.code, 0, ok.stderr);
  const gitDir = w.git('rev-parse', '--absolute-git-dir').stdout.trim();
  fs.writeFileSync(path.join(gitDir, 'shallow'), `${M}\n`);
  const shallow = push(w, D, w.A);
  assert.notEqual(shallow.code, 0);
  assert.match(shallow.stderr, /replace/);
  fs.rmSync(path.join(gitDir, 'shallow'));
  const obj = path.join(gitDir, 'objects', M.slice(0, 2), M.slice(2));
  fs.rmSync(obj, { force: true });
  const missing = push(w, D, w.A);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /replace/);
});

test('a sha256 repository: a fast-forward is allowed and a replacement refused', () => {
  const env = isolatedGitEnv();
  const home = tmpDir('riverwright-home-');
  const worktree = path.join(home, 'ruvnet', 'ruflo', 'worktrees', 'issue-3509');
  fs.mkdirSync(worktree, { recursive: true });
  const git = (...a) => spawnSync('git', a, { cwd: worktree, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(git('init', '-q', '--object-format=sha256').status, 0);
  git('commit', '-q', '--allow-empty', '-m', 'a');
  const A = git('rev-parse', 'HEAD').stdout.trim();
  git('commit', '-q', '--allow-empty', '-m', 'c');
  const C = git('rev-parse', 'HEAD').stdout.trim();
  git('reset', '-q', '--hard', A);
  git('commit', '-q', '--amend', '--allow-empty', '-m', 'b');
  const B = git('rev-parse', 'HEAD').stdout.trim();
  assert.equal(A.length, 64);
  const runDir = runDirIn(home);
  saveState(runDir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
  const w = { home, worktree, runDir, env };
  armRun({ home, runDir, sha: C });
  const ff = push(w, C, A);
  assert.equal(ff.code, 0, ff.stderr);
  armRun({ home, runDir, sha: B });
  const replace = push(w, B, A);
  assert.notEqual(replace.code, 0);
  assert.match(replace.stderr, /replace/);
});
