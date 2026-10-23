import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createState, saveState, setFork, loadState } from '../scripts/lib/state.mjs';
import { recordApproval } from '../scripts/lib/approvals.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';
import { runFile } from '../scripts/lib/exec.mjs';
import { callMain, runRiverwright, tmpDir, ROOT, RIVERWRIGHT } from './helpers.mjs';

// Test seams live in io.testing, which only the in-process helper (callMain) supplies. These tests run
// the real entry point with every variable the old seams read, set the way an agent would set them.
const A = 'a'.repeat(40);
const ZERO = '0'.repeat(40);
const FORK = 'https://github.com/pacphi/ruflo.git';
const PAST = '1999-01-01T00:00:00.000Z';
const LINE = `refs/heads/riverwright/3509-codex ${A} refs/heads/riverwright/3509-codex ${ZERO}\n`;
const recent = (iso) => Math.abs(Date.parse(iso) - Date.now()) < 60_000;
const seamEnv = (runDir) => ({ RIVERWRIGHT_TEST: '1', RIVERWRIGHT_NOW: PAST, RIVERWRIGHT_RUN_DIR: runDir });

function forgedRun() {
  const dir = tmpDir('forged-run-');
  const s = setFork(createState({ runId: 'ruvnet/ruflo#3509', now: PAST }), FORK);
  saveState(dir, recordApproval(s, { gate: 'submit-gate', sha: A, mode: 'host-ask', now: PAST, branch: 'riverwright/3509-codex' }));
  return dir;
}

async function plainRepo() {
  const repo = tmpDir();
  await runFile('git', ['init', '-q'], { cwd: repo });
  return repo;
}

test('in a real process, RIVERWRIGHT_TEST=1 with RIVERWRIGHT_RUN_DIR does not point the guard at a forged run', async () => {
  const repo = await plainRepo();
  const forged = forgedRun();
  const r = runRiverwright(['guard', 'pre-push', '--home', tmpDir('riverwright-home-'), '--', 'fork', FORK], {
    stdin: LINE, cwd: repo, env: seamEnv(forged),
  });
  assert.notEqual(r.code, 0, r.stderr);
  assert.match(r.stderr, /run record is missing/);
  assert.deepEqual(readLedger(forged), []);
});

test('in a real process, RIVERWRIGHT_TEST=1 does not reopen the git config riverwright.run lookup', async () => {
  const repo = await plainRepo();
  const forged = forgedRun();
  await runFile('git', ['config', 'riverwright.run', forged], { cwd: repo });
  const r = runRiverwright(['guard', 'pre-push', '--home', tmpDir('riverwright-home-'), '--', 'fork', FORK], {
    stdin: LINE, cwd: repo, env: seamEnv(''),
  });
  assert.notEqual(r.code, 0, r.stderr);
  assert.deepEqual(readLedger(forged), []);
});

test('in a real process, RIVERWRIGHT_TEST=1 with RIVERWRIGHT_NOW does not pin the clock', () => {
  const dir = tmpDir();
  const env = seamEnv(tmpDir());
  const created = runRiverwright(['state', 'create', '--run', dir, '--id', 'o/r#1'], { env });
  assert.equal(created.code, 0, created.stderr);
  const approved = runRiverwright(['approve', 'checkpoint-1', '--run', dir, '--sha', A], { env });
  assert.equal(approved.code, 0, approved.stderr);
  const s = loadState(dir);
  assert.ok(recent(s.createdAt), s.createdAt);
  assert.ok(recent(s.approvals[0].approvedAt), s.approvals[0].approvedAt);
  for (const e of readLedger(dir)) assert.ok(recent(e.at), e.at);
});

test('in a real process, the guard records the real time even with RIVERWRIGHT_TEST=1 and RIVERWRIGHT_NOW', async () => {
  const home = tmpDir('riverwright-home-');
  const worktree = path.join(home, 'ruvnet', 'ruflo', 'worktrees', 'issue-3509');
  fs.mkdirSync(worktree, { recursive: true });
  await runFile('git', ['init', '-q'], { cwd: worktree });
  const dir = path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509');
  saveState(dir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
  const r = runRiverwright(['guard', 'pre-push', '--home', home, '--', 'fork', FORK], {
    stdin: LINE, cwd: worktree, env: seamEnv(forgedRun()),
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Nothing has been approved/);
  const last = readLedger(dir).at(-1);
  assert.equal(last.decision, 'deny');
  assert.ok(recent(last.at), last.at);
});

test('in a real process, RIVERWRIGHT_RUN_DIR does not choose the run for state or approve', () => {
  const dir = tmpDir();
  assert.equal(runRiverwright(['state', 'create', '--run', dir, '--id', 'o/r#1']).code, 0);
  const got = runRiverwright(['state', 'get'], { env: seamEnv(dir) });
  assert.notEqual(got.code, 0);
  assert.match(got.stderr, /--run/);
  const approved = runRiverwright(['approve', 'checkpoint-1', '--sha', A], { env: seamEnv(dir) });
  assert.notEqual(approved.code, 0);
  assert.equal(loadState(dir).approvals.length, 0);
});

test('io.testing is honored in process: now pins the clock and runDir is used only with allowRunDirOverride', async () => {
  const dir = tmpDir();
  const created = await callMain(['state', 'create', '--run', dir, '--id', 'o/r#1'], { testing: { now: PAST } });
  assert.equal(created.code, 0, created.stderr);
  assert.equal(loadState(dir).createdAt, PAST);
  const repo = await plainRepo();
  const forged = forgedRun();
  const home = tmpDir('riverwright-home-');
  const without = await callMain(['guard', 'pre-push', '--home', home, '--', 'fork', FORK], { stdin: LINE, cwd: repo, testing: { runDir: forged } });
  assert.notEqual(without.code, 0);
  const withOverride = await callMain(['guard', 'pre-push', '--home', home, '--', 'fork', FORK], { stdin: LINE, cwd: repo, testing: { runDir: forged, allowRunDirOverride: true } });
  assert.equal(withOverride.code, 0, withOverride.stderr);
});

test('no production code reads the retired seam variables, and the entry point never supplies io.testing', () => {
  const dir = path.join(ROOT, 'scripts');
  for (const f of fs.readdirSync(dir, { recursive: true }).filter((n) => n.endsWith('.mjs'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /RIVERWRIGHT_(TEST|NOW|RUN_DIR|APPROVAL_MODE|ALLOW_HOST_ASK_SUBMIT)\b/, f);
  }
  assert.doesNotMatch(fs.readFileSync(RIVERWRIGHT, 'utf8'), /\btesting\b/);
});
