import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRemoteUrl } from '../scripts/lib/giturl.mjs';
import { parsePrePushLines, decidePrePush, renderPrePushHook } from '../scripts/lib/guard.mjs';
import { createState, saveState, setFork } from '../scripts/lib/state.mjs';
import { recordApproval } from '../scripts/lib/approvals.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';
import { runFile } from '../scripts/lib/exec.mjs';
import { callMain, runRiverwright, tmpDir } from './helpers.mjs';
import { NOW, armRun } from './receipt-helpers.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);
const FORK = 'https://github.com/pacphi/ruflo.git';
const UPSTREAM = 'https://github.com/ruvnet/ruflo.git';
const line = (sha, remoteRef = 'refs/heads/riverwright/3509-codex') => `refs/heads/riverwright/3509-codex ${sha} ${remoteRef} ${ZERO}\n`;

test('remote URLs normalize across https, ssh, scp and credentials', () => {
  const want = 'github.com/pacphi/ruflo';
  for (const u of [FORK, 'https://github.com/PacPhi/Ruflo', 'git@github.com:pacphi/ruflo.git', 'ssh://git@github.com/pacphi/ruflo.git', 'https://x:tok@github.com/pacphi/ruflo.git/']) {
    assert.equal(normalizeRemoteUrl(u), want, u);
  }
  assert.equal(normalizeRemoteUrl('/tmp/bare.git'), null);
  assert.equal(normalizeRemoteUrl('C:\\repos\\x'), null);
});

test('the approved commit may go to the fork on a riverwright/ branch', () => {
  const d = decidePrePush({ remoteUrl: 'git@github.com:pacphi/ruflo.git', updates: parsePrePushLines(line(A)), forkUrl: FORK, approvedSha: A, approvedBranch: 'riverwright/3509-codex' });
  assert.equal(d.allow, true, d.reason);
});

test('pushing to upstream is refused, even by literal URL', () => {
  const d = decidePrePush({ remoteUrl: UPSTREAM, updates: parsePrePushLines(line(A)), forkUrl: FORK, approvedSha: A });
  assert.equal(d.allow, false);
  assert.match(d.reason, /not your fork/);
});

test('everything else is refused with a reason', () => {
  const cases = [
    [{ forkUrl: null, approvedSha: A, updates: line(A) }, /no fork yet/],
    [{ forkUrl: FORK, approvedSha: null, updates: line(A) }, /Nothing has been unlocked/],
    [{ forkUrl: FORK, approvedSha: A, updates: line(B) }, /not the approved commit/],
    [{ forkUrl: FORK, approvedSha: A, updates: line(A, 'refs/heads/main') }, /Only branches named riverwright/],
    [{ forkUrl: FORK, approvedSha: A, updates: line(A, 'refs/tags/v1') }, /Only branches named riverwright/],
    [{ forkUrl: FORK, approvedSha: A, updates: `refs/heads/riverwright/x ${ZERO} refs/heads/riverwright/x ${A}\n` }, /Deleting/],
  ];
  for (const [input, reason] of cases) {
    const d = decidePrePush({ remoteUrl: FORK, updates: parsePrePushLines(input.updates), forkUrl: input.forkUrl, approvedSha: input.approvedSha, approvedBranch: 'riverwright/3509-codex' });
    assert.equal(d.allow, false);
    assert.match(d.reason, reason);
  }
});

test('renderPrePushHook quotes install paths with spaces and refuses unsafe ones', () => {
  const text = renderPrePushHook('/Users/Jane Doe/Library/Application Support/riverwright/scripts/riverwright.mjs');
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.match(text, /exec node "\/Users\/Jane Doe\/Library\/Application Support\/riverwright\/scripts\/riverwright\.mjs" guard pre-push -- "\$@"/);
  assert.throws(() => renderPrePushHook('/a$b/riverwright.mjs'), /cannot be quoted/);
});

async function runWithApproval(sha) {
  const dir = tmpDir();
  const home = tmpDir('riverwright-home-');
  saveState(dir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
  armRun({ home, runDir: dir, sha: A, at: NOW });
  const r = await callMain(['guard', 'pre-push', '--home', home, '--', 'fork', FORK], { stdin: line(sha), testing: { allowRunDirOverride: true, runDir: dir, now: NOW } });
  return { r, dir };
}

test('riverwright guard pre-push allows the approved push and records it', async () => {
  const { r, dir } = await runWithApproval(A);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readLedger(dir).at(-1).decision, 'allow');
});

test('riverwright guard pre-push blocks an unapproved commit and records why', async () => {
  const { r, dir } = await runWithApproval(B);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /blocked this push/);
  assert.equal(readLedger(dir).at(-1).decision, 'deny');
});

test('riverwright guard finds the run through git config riverwright.run', async () => {
  const repo = tmpDir();
  const dir = tmpDir();
  const home = tmpDir('riverwright-home-');
  saveState(dir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
  armRun({ home, runDir: dir, sha: A, at: NOW });
  await runFile('git', ['init', '-q'], { cwd: repo });
  await runFile('git', ['config', 'riverwright.run', dir], { cwd: repo });
  const r = await callMain(['guard', 'pre-push', '--home', home, '--', 'fork', FORK], { stdin: line(A), cwd: repo, testing: { allowRunDirOverride: true, now: NOW } });
  assert.equal(r.code, 0, r.stderr);
});

test('riverwright guard blocks when the run record is missing', async () => {
  const repo = tmpDir();
  await runFile('git', ['init', '-q'], { cwd: repo });
  const r = await callMain(['guard', 'pre-push', 'fork', FORK], { stdin: line(A), cwd: repo, env: {} });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /run record is missing/);
});

test('setFork refuses a URL that is not a GitHub-style remote', () => {
  assert.throws(() => setFork(createState({ runId: 'o/r#1', now: 't' }), path.join('tmp', 'x')), /not a fork URL/);
});

// The guard finds the run from the repository being pushed: <home>/<o>/<r>/worktrees/issue-<n>.
async function workspace({ runId = 'ruvnet/ruflo#3509', approve = true } = {}) {
  const home = tmpDir('riverwright-home-');
  const worktree = path.join(home, 'ruvnet', 'ruflo', 'worktrees', 'issue-3509');
  fs.mkdirSync(worktree, { recursive: true });
  await runFile('git', ['init', '-q'], { cwd: worktree });
  const dir = path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509');
  saveState(dir, setFork(createState({ runId, now: 't' }), FORK));
  if (approve) armRun({ home, runDir: dir, sha: A, run: 'ruvnet/ruflo#3509' });
  return { home, worktree, dir };
}

async function forgedRun() {
  const dir = tmpDir('forged-run-');
  saveState(dir, recordApproval(setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK), { gate: 'submit-gate', sha: A, mode: 'host-ask', now: 't', branch: 'riverwright/3509-codex' }));
  return dir;
}

test('the guard finds the run from the worktree it is pushing from', async () => {
  const w = await workspace();
  const r = await callMain(['guard', 'pre-push', '--home', w.home, '--', 'fork', FORK], { stdin: line(A), cwd: w.worktree });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readLedger(w.dir).at(-1).decision, 'allow');
});

test('a forged RIVERWRIGHT_RUN_DIR does not make the guard allow', async () => {
  const repo = tmpDir();
  await runFile('git', ['init', '-q'], { cwd: repo });
  const r = await callMain(['guard', 'pre-push', '--home', tmpDir('riverwright-home-'), '--', 'fork', FORK], { stdin: line(A), cwd: repo, env: { RIVERWRIGHT_RUN_DIR: await forgedRun() } });
  assert.notEqual(r.code, 0);
  const w = await workspace({ approve: false });
  const r2 = await callMain(['guard', 'pre-push', '--home', w.home, '--', 'fork', FORK], { stdin: line(A), cwd: w.worktree, env: { RIVERWRIGHT_RUN_DIR: await forgedRun() } });
  assert.notEqual(r2.code, 0);
  assert.match(r2.stderr, /Nothing has been unlocked/);
});

test('a forged git config riverwright.run does not make the guard allow', async () => {
  const repo = tmpDir();
  await runFile('git', ['init', '-q'], { cwd: repo });
  await runFile('git', ['config', 'riverwright.run', await forgedRun()], { cwd: repo });
  const r = await callMain(['guard', 'pre-push', '--home', tmpDir('riverwright-home-'), '--', 'fork', FORK], { stdin: line(A), cwd: repo });
  assert.notEqual(r.code, 0);
});

test('config injected through GIT_CONFIG_COUNT does not make the guard allow', async () => {
  const repo = tmpDir();
  await runFile('git', ['init', '-q'], { cwd: repo });
  const r = runRiverwright(['guard', 'pre-push', '--home', tmpDir('riverwright-home-'), '--', 'fork', FORK], {
    stdin: line(A), cwd: repo,
    env: { RIVERWRIGHT_TEST: '', RIVERWRIGHT_RUN_DIR: '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'riverwright.run', GIT_CONFIG_VALUE_0: await forgedRun() },
  });
  assert.notEqual(r.code, 0, r.stderr);
});

test('a run record that belongs to another issue is refused', async () => {
  const w = await workspace({ runId: 'ruvnet/ruflo#1' });
  const r = await callMain(['guard', 'pre-push', '--home', w.home, '--', 'fork', FORK], { stdin: line(A), cwd: w.worktree });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /belongs to ruvnet\/ruflo#1/);
});

test('pushing from the plain clone (not a run worktree) is refused', async () => {
  const w = await workspace();
  const clone = path.join(w.home, 'ruvnet', 'ruflo', 'clone');
  fs.mkdirSync(clone, { recursive: true });
  await runFile('git', ['init', '-q'], { cwd: clone });
  const r = await callMain(['guard', 'pre-push', '--home', w.home, '--', 'fork', FORK], { stdin: line(A), cwd: clone });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /run record is missing/);
});

test('the guard finds the run from a linked worktree of the clone (git worktree add)', async () => {
  const home = tmpDir('riverwright-home-');
  const clone = path.join(home, 'ruvnet', 'ruflo', 'clone');
  fs.mkdirSync(clone, { recursive: true });
  const git = (cwd, ...a) => runFile('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd });
  await git(clone, 'init', '-q');
  await git(clone, 'commit', '-q', '--allow-empty', '-m', 'init');
  const worktree = path.join(home, 'ruvnet', 'ruflo', 'worktrees', 'issue-3509');
  const added = await git(clone, 'worktree', 'add', '-q', '-b', 'riverwright/3509-codex', worktree);
  assert.equal(added.code, 0, added.stderr);
  const dir = path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509');
  saveState(dir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
  armRun({ home, runDir: dir, sha: A });
  const r = await callMain(['guard', 'pre-push', '--home', home, '--', 'fork', FORK], { stdin: line(A), cwd: path.join(worktree) });
  assert.equal(r.code, 0, r.stderr);
});

test('remote URLs on other schemes, ports or look-alike hosts do not normalize', () => {
  for (const u of [
    'http://github.com/pacphi/ruflo.git',
    'git://github.com/pacphi/ruflo.git',
    'file:///tmp/pacphi/ruflo.git',
    'https://github.com:8443/pacphi/ruflo.git',
    'ssh://git@github.com:2222/pacphi/ruflo.git',
    'ssh://evil@github.com/pacphi/ruflo.git',
    'https://g\u0456thub.com/pacphi/ruflo',
    'https://G\u0130THUB.com/pacphi/ruflo',
    'https://github.com./pacphi/ruflo',
    'https://github.com/pacph%69/ruflo',
    'https://github.com/pacphi/ruflo?ref=x',
    'https://github.com/pacphi/ruflo#x',
    'git@github.com:pacphi/../ruflo',
    'C:/repos/x',
  ]) {
    assert.equal(normalizeRemoteUrl(u), null, u);
  }
});

test('explicit default ports are the same remote', () => {
  assert.equal(normalizeRemoteUrl('https://github.com:443/pacphi/ruflo.git'), 'github.com/pacphi/ruflo');
  assert.equal(normalizeRemoteUrl('ssh://git@github.com:22/pacphi/ruflo.git'), 'github.com/pacphi/ruflo');
  assert.equal(normalizeRemoteUrl('HTTPS://GitHub.COM/PacPhi/Ruflo'), 'github.com/pacphi/ruflo');
  assert.equal(normalizeRemoteUrl('github.com:pacphi/ruflo'), 'github.com/pacphi/ruflo');
});

test('a push over plain http or a non-default port is not a push to the fork', () => {
  for (const remoteUrl of ['http://github.com/pacphi/ruflo.git', 'https://github.com:8443/pacphi/ruflo.git', 'git://github.com/pacphi/ruflo.git']) {
    const d = decidePrePush({ remoteUrl, updates: parsePrePushLines(line(A)), forkUrl: FORK, approvedSha: A });
    assert.equal(d.allow, false, remoteUrl);
  }
});

test('the approval is bound to one branch: another riverwright/ branch is refused', () => {
  const other = decidePrePush({ remoteUrl: FORK, updates: parsePrePushLines(line(A, 'refs/heads/riverwright/9999-elsewhere')), forkUrl: FORK, approvedSha: A, approvedBranch: 'riverwright/3509-codex' });
  assert.equal(other.allow, false);
  assert.match(other.reason, /approved branch riverwright\/3509-codex/);
  const none = decidePrePush({ remoteUrl: FORK, updates: parsePrePushLines(line(A)), forkUrl: FORK, approvedSha: A, approvedBranch: null });
  assert.equal(none.allow, false);
  assert.match(none.reason, /does not name a branch/);
});

test('riverwright guard refuses the approved commit on a branch other than the approved one', async () => {
  const w = await workspace();
  const r = await callMain(['guard', 'pre-push', '--home', w.home, '--', 'fork', FORK], { stdin: line(A, 'refs/heads/riverwright/3509-other'), cwd: w.worktree });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /approved branch/);
});

test('the guard finds the run with the environment git gives a pre-push hook in a linked worktree', async () => {
  const home = tmpDir('riverwright-home-');
  const clone = path.join(home, 'ruvnet', 'ruflo', 'clone');
  fs.mkdirSync(clone, { recursive: true });
  const git = (cwd, ...a) => runFile('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd });
  await git(clone, 'init', '-q');
  await git(clone, 'commit', '-q', '--allow-empty', '-m', 'init');
  const worktree = path.join(home, 'ruvnet', 'ruflo', 'worktrees', 'issue-3509');
  await git(clone, 'worktree', 'add', '-q', '-b', 'riverwright/3509-codex', worktree);
  const gitDir = (await git(worktree, 'rev-parse', '--absolute-git-dir')).stdout.trim();
  const dir = path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509');
  saveState(dir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
  armRun({ home, runDir: dir, sha: A });
  // Git runs hooks from the worktree root with GIT_DIR (and GIT_INDEX_FILE) exported, and no GIT_WORK_TREE.
  const hookEnv = { RIVERWRIGHT_TEST: '', RIVERWRIGHT_RUN_DIR: '', GIT_DIR: gitDir, GIT_INDEX_FILE: path.join(gitDir, 'index'), GIT_PREFIX: '' };
  const hookArgs = ['guard', 'pre-push', '--home', home, '--', 'fork', FORK];
  const r = runRiverwright(hookArgs, { stdin: line(A), cwd: worktree, env: hookEnv });
  assert.equal(r.code, 0, r.stderr);
  const other = runRiverwright(hookArgs, { stdin: line(B), cwd: worktree, env: hookEnv });
  assert.notEqual(other.code, 0);
  assert.match(other.stderr, /not the approved commit/);
});

// R16(a): until Task 14 binds the fork into the signed receipt (R16(b)), the guard refuses the upstream
// repository named by the receipt's signed run, in every URL form git can hand the hook.
test('the upstream repository named by the signed run is refused in every URL form, even when state.json names it as the fork', () => {
  const forms = [
    'https://github.com/ruvnet/ruflo', 'https://github.com/ruvnet/ruflo.git', 'https://github.com/ruvnet/ruflo/', 'https://github.com/ruvnet/ruflo.git/',
    'HTTPS://GitHub.com/RuvNet/RuFlo.GIT', 'https://user:tok@github.com/ruvnet/ruflo.git', 'https://tok@github.com:443/ruvnet/ruflo',
    'http://github.com/ruvnet/ruflo.git', 'git://github.com/ruvnet/ruflo.git', 'git@github.com:ruvnet/ruflo.git', 'git@github.com:ruvnet/ruflo',
    'github.com:ruvnet/ruflo.git', 'ssh://git@github.com/ruvnet/ruflo.git', 'ssh://git@github.com:22/ruvnet/ruflo', 'ssh://github.com/ruvnet/ruflo.git',
    'ssh://git@github.com:2222/ruvnet/ruflo.git', 'ssh://other@github.com/ruvnet/ruflo.git', 'git@ghe.example.com:ruvnet/ruflo.git',
    'git@github.com:/ruvnet/ruflo.git', 'https://github.com//ruvnet/ruflo.git', 'https://github.com/ruvnet/./ruflo.git', 'https://github.com/%72uvnet/ru%66lo.git',
  ];
  for (const remoteUrl of forms) {
    const d = decidePrePush({ remoteUrl, updates: parsePrePushLines(line(A)), forkUrl: remoteUrl, approvedSha: A, approvedBranch: 'riverwright/3509-codex', upstream: 'ruvnet/ruflo#3509' });
    assert.equal(d.allow, false, remoteUrl);
    assert.match(d.reason, /upstream repository/, remoteUrl);
  }
  const fork = decidePrePush({ remoteUrl: FORK, updates: parsePrePushLines(line(A)), forkUrl: FORK, approvedSha: A, approvedBranch: 'riverwright/3509-codex', upstream: 'ruvnet/ruflo#3509' });
  assert.equal(fork.allow, true);
  const sibling = decidePrePush({ remoteUrl: 'https://github.com/ruvnet/ruflo-extras.git', updates: parsePrePushLines(line(A)), forkUrl: 'https://github.com/ruvnet/ruflo-extras.git', approvedSha: A, approvedBranch: 'riverwright/3509-codex', upstream: 'ruvnet/ruflo#3509' });
  assert.equal(sibling.allow, true);
});

test('parsePrePushLines wants exactly four fields, tolerates CRLF and normalises SHAs', () => {
  const ok = parsePrePushLines(`refs/heads/x ${A.toUpperCase()} refs/heads/y ${ZERO}\r\nrefs/heads/x ${B} refs/heads/y ${B}\r\n\r\n`);
  assert.deepEqual(ok.map((u) => [u.localSha, u.remoteSha]), [[A, ZERO], [B, B]]);
  for (const bad of [`refs/heads/x ${A} refs/heads/y\n`, `refs/heads/x\n`, `refs/heads/x ${A} refs/heads/y ${ZERO} extra\n`, `refs/heads/x ${A} refs/heads/y\n`,
    `refs/heads/x abc123 refs/heads/y ${ZERO}\n`, `refs/heads/x ${A} refs/heads/y zz\n`, `refs/heads/x ${'g'.repeat(40)} refs/heads/y ${ZERO}\n`]) {
    assert.throws(() => parsePrePushLines(bad), /push line/, JSON.stringify(bad));
  }
  assert.deepEqual(parsePrePushLines(''), []);
});

test('a refusal for nothing unlocked carries a code, not just text', () => {
  const d = decidePrePush({ remoteUrl: FORK, updates: parsePrePushLines(line(A)), forkUrl: FORK, approvedSha: null });
  assert.equal(d.code, 'NOTHING_UNLOCKED');
});
