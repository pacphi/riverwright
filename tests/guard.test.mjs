import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeRemoteUrl } from '../scripts/lib/giturl.mjs';
import { parsePrePushLines, decidePrePush, renderPrePushHook } from '../scripts/lib/guard.mjs';
import { createState, saveState, setFork } from '../scripts/lib/state.mjs';
import { recordApproval } from '../scripts/lib/approvals.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';
import { runFile } from '../scripts/lib/exec.mjs';
import { callMain, tmpDir } from './helpers.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);
const FORK = 'https://github.com/pacphi/ruflo.git';
const UPSTREAM = 'https://github.com/ruvnet/ruflo.git';
const line = (sha, remoteRef = 'refs/heads/upf/3509-codex') => `refs/heads/upf/3509-codex ${sha} ${remoteRef} ${ZERO}\n`;

test('remote URLs normalize across https, ssh, scp and credentials', () => {
  const want = 'github.com/pacphi/ruflo';
  for (const u of [FORK, 'https://github.com/PacPhi/Ruflo', 'git@github.com:pacphi/ruflo.git', 'ssh://git@github.com/pacphi/ruflo.git', 'https://x:tok@github.com/pacphi/ruflo.git/']) {
    assert.equal(normalizeRemoteUrl(u), want, u);
  }
  assert.equal(normalizeRemoteUrl('/tmp/bare.git'), null);
  assert.equal(normalizeRemoteUrl('C:\\repos\\x'), null);
});

test('the approved commit may go to the fork on an upf/ branch', () => {
  const d = decidePrePush({ remoteUrl: 'git@github.com:pacphi/ruflo.git', updates: parsePrePushLines(line(A)), forkUrl: FORK, approvedSha: A });
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
    [{ forkUrl: FORK, approvedSha: null, updates: line(A) }, /Nothing has been approved/],
    [{ forkUrl: FORK, approvedSha: A, updates: line(B) }, /not the approved commit/],
    [{ forkUrl: FORK, approvedSha: A, updates: line(A, 'refs/heads/main') }, /Only branches named upf/],
    [{ forkUrl: FORK, approvedSha: A, updates: line(A, 'refs/tags/v1') }, /Only branches named upf/],
    [{ forkUrl: FORK, approvedSha: A, updates: `refs/heads/upf/x ${ZERO} refs/heads/upf/x ${A}\n` }, /Deleting/],
  ];
  for (const [input, reason] of cases) {
    const d = decidePrePush({ remoteUrl: FORK, updates: parsePrePushLines(input.updates), forkUrl: input.forkUrl, approvedSha: input.approvedSha });
    assert.equal(d.allow, false);
    assert.match(d.reason, reason);
  }
});

test('renderPrePushHook quotes install paths with spaces and refuses unsafe ones', () => {
  const text = renderPrePushHook('/Users/Jane Doe/Library/Application Support/upf/scripts/upf.mjs');
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.match(text, /exec node "\/Users\/Jane Doe\/Library\/Application Support\/upf\/scripts\/upf\.mjs" guard pre-push "\$@"/);
  assert.throws(() => renderPrePushHook('/a$b/upf.mjs'), /cannot be quoted/);
});

async function runWithApproval(sha) {
  const dir = tmpDir();
  let s = setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK);
  s = recordApproval(s, { gate: 'submit-gate', sha: A, mode: 'host-ask', now: 't' });
  saveState(dir, s);
  const r = await callMain(['guard', 'pre-push', 'fork', FORK], { stdin: line(sha), env: { UPF_RUN_DIR: dir, UPF_NOW: 't' } });
  return { r, dir };
}

test('upf guard pre-push allows the approved push and records it', async () => {
  const { r, dir } = await runWithApproval(A);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readLedger(dir).at(-1).decision, 'allow');
});

test('upf guard pre-push blocks an unapproved commit and records why', async () => {
  const { r, dir } = await runWithApproval(B);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /blocked this push/);
  assert.equal(readLedger(dir).at(-1).decision, 'deny');
});

test('upf guard finds the run through git config upf.run', async () => {
  const repo = tmpDir();
  const dir = tmpDir();
  let s = setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK);
  saveState(dir, recordApproval(s, { gate: 'submit-gate', sha: A, mode: 'host-ask', now: 't' }));
  await runFile('git', ['init', '-q'], { cwd: repo });
  await runFile('git', ['config', 'upf.run', dir], { cwd: repo });
  const r = await callMain(['guard', 'pre-push', 'fork', FORK], { stdin: line(A), cwd: repo, env: { UPF_NOW: 't' } });
  assert.equal(r.code, 0, r.stderr);
});

test('upf guard blocks when the run record is missing', async () => {
  const repo = tmpDir();
  await runFile('git', ['init', '-q'], { cwd: repo });
  const r = await callMain(['guard', 'pre-push', 'fork', FORK], { stdin: line(A), cwd: repo, env: {} });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /run record is missing/);
});

test('setFork refuses a URL that is not a GitHub-style remote', () => {
  assert.throws(() => setFork(createState({ runId: 'o/r#1', now: 't' }), path.join('tmp', 'x')), /not a fork URL/);
});
