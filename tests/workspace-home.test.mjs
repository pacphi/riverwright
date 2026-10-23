import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createState, saveState, setFork } from '../scripts/lib/state.mjs';
import { recordApproval } from '../scripts/lib/approvals.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';
import { runFile, launcherHookCommand } from '../scripts/lib/exec.mjs';
import { renderPrePushHook } from '../scripts/lib/guard.mjs';
import { workspaceHomeFromArg } from '../scripts/lib/paths.mjs';
import { callMain, runRiverwright, tmpDir, ROOT, RIVERWRIGHT } from './helpers.mjs';

// The pre-push guard and the host hook take the workspace home from --home (the generated hook files
// carry it) or the account's home directory; never from RIVERWRIGHT_HOME or HOME in the environment.
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);
const FORK = 'https://github.com/pacphi/ruflo.git';
const BRANCH = 'riverwright/3509-codex';
const line = (sha) => `refs/heads/${BRANCH} ${sha} refs/heads/${BRANCH} ${ZERO}\n`;
const posixOnly = { skip: process.platform === 'win32' };
const git = (cwd, ...a) => runFile('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd });
const approved = (runId = 'ruvnet/ruflo#3509') => recordApproval(setFork(createState({ runId, now: 't' }), FORK), { gate: 'submit-gate', sha: A, mode: 'tty', now: 't', branch: BRANCH });
const runDirOf = (home) => path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509');
const worktreeOf = (home) => path.join(home, 'ruvnet', 'ruflo', 'worktrees', 'issue-3509');

// A real workspace whose clone has no approval, and a forged tree next to it: a linked worktree of the
// real clone at <forged>/ruvnet/ruflo/worktrees/issue-3509 with an approved run record beside it.
async function realAndForged({ forgedHome } = {}) {
  const home = tmpDir('riverwright-home-');
  const clone = path.join(home, 'ruvnet', 'ruflo', 'clone');
  fs.mkdirSync(clone, { recursive: true });
  await git(clone, 'init', '-q');
  await git(clone, 'commit', '-q', '--allow-empty', '-m', 'init');
  saveState(runDirOf(home), setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
  const forged = forgedHome ?? tmpDir('forged-home-');
  const added = await git(clone, 'worktree', 'add', '-q', '-b', BRANCH, worktreeOf(forged));
  assert.equal(added.code, 0, added.stderr);
  saveState(runDirOf(forged), approved());
  return { home, clone, forged, forgedWorktree: worktreeOf(forged) };
}

// An approved run in a workspace home (which may contain spaces).
async function approvedWorkspace(home = tmpDir('riverwright-home-')) {
  fs.mkdirSync(worktreeOf(home), { recursive: true });
  await git(worktreeOf(home), 'init', '-q');
  saveState(runDirOf(home), approved());
  return { home, worktree: worktreeOf(home), dir: runDirOf(home) };
}

test('a forged RIVERWRIGHT_HOME with a linked worktree of the real clone does not make the guard allow', async () => {
  const w = await realAndForged();
  const r = await callMain(['guard', 'pre-push', '--home', w.home, '--', 'fork', FORK], { stdin: line(A), cwd: w.forgedWorktree, env: { RIVERWRIGHT_HOME: w.forged } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /run record is missing/);
  const sub = runRiverwright(['guard', 'pre-push', 'fork', FORK], { stdin: line(A), cwd: w.forgedWorktree, env: { RIVERWRIGHT_HOME: w.forged } });
  assert.notEqual(sub.code, 0, sub.stderr);
  assert.deepEqual(readLedger(runDirOf(w.forged)), []);
});

test('a forged HOME does not move the guard\'s default workspace home', async () => {
  const top = tmpDir('forged-user-');
  const w = await realAndForged({ forgedHome: path.join(top, '.riverwright') });
  const r = runRiverwright(['guard', 'pre-push', 'fork', FORK], { stdin: line(A), cwd: w.forgedWorktree, env: { HOME: top, USERPROFILE: top, RIVERWRIGHT_HOME: '' } });
  assert.notEqual(r.code, 0, r.stderr);
  assert.deepEqual(readLedger(runDirOf(w.forged)), []);
});

test('the guard finds the run under --home, whatever RIVERWRIGHT_HOME says', async () => {
  const w = await approvedWorkspace();
  const r = await callMain(['guard', 'pre-push', '--home', w.home, '--', 'fork', FORK], { stdin: line(A), cwd: w.worktree, env: { RIVERWRIGHT_HOME: tmpDir('decoy-home-') } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readLedger(w.dir).at(-1).decision, 'allow');
});

test('a remote named like an option cannot replace the hook\'s --home', posixOnly, async () => {
  const w = await realAndForged();
  const r = await callMain(['guard', 'pre-push', '--home', w.home, '--', `--home=${w.forged}`, FORK], { stdin: line(A), cwd: w.forgedWorktree });
  assert.notEqual(r.code, 0);
  const hook = path.join(tmpDir(), 'pre-push');
  fs.writeFileSync(hook, renderPrePushHook(RIVERWRIGHT, { home: w.home }));
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` };
  const sh = spawnSync('/bin/sh', [hook, `--home=${w.forged}`, FORK], { input: line(A), cwd: w.forgedWorktree, encoding: 'utf8', env });
  assert.notEqual(sh.status, 0, sh.stderr);
  assert.deepEqual(readLedger(runDirOf(w.forged)), []);
});

test('renderPrePushHook fixes --home in the hook, quotes spaces and refuses unsafe homes', () => {
  const text = renderPrePushHook('/Users/Jane Doe/riverwright/scripts/riverwright.mjs', { home: '/Users/Jane Doe/.riverwright' });
  assert.match(text, /exec node "\/Users\/Jane Doe\/riverwright\/scripts\/riverwright\.mjs" guard pre-push --home "\/Users\/Jane Doe\/\.riverwright" -- "\$@"\n/);
  assert.match(renderPrePushHook('C:\\Users\\Jane Doe\\rw\\scripts\\riverwright.mjs', { home: 'C:\\Users\\Jane Doe\\.riverwright\\' }), /--home "C:\/Users\/Jane Doe\/\.riverwright" -- "\$@"/);
  for (const bad of ['relative/home', '/a$HOME/x', '/a"b', '/a`x`', 'C:\\50%\\x', '/a\nb', '/']) {
    assert.throws(() => renderPrePushHook('/a/riverwright.mjs', { home: bad }), /UNSAFE_PATH|absolute|cannot be quoted/, JSON.stringify(bad));
  }
});

test('a pre-push hook for a workspace whose path has spaces allows only the approved push', posixOnly, async () => {
  const w = await approvedWorkspace(path.join(tmpDir('riverwright-user-'), 'Riverwright Home'));
  const hook = path.join(tmpDir(), 'pre-push');
  fs.writeFileSync(hook, renderPrePushHook(RIVERWRIGHT, { home: w.home }));
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, RIVERWRIGHT_HOME: tmpDir('decoy-home-') };
  const ok = spawnSync('/bin/sh', [hook, 'fork', FORK], { input: line(A), cwd: w.worktree, encoding: 'utf8', env });
  assert.equal(ok.status, 0, ok.stderr);
  const other = spawnSync('/bin/sh', [hook, 'fork', FORK], { input: line(B), cwd: w.worktree, encoding: 'utf8', env });
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /not the approved commit/);
});

test('the hook decides scope from --home, not RIVERWRIGHT_HOME', async () => {
  const w = await approvedWorkspace();
  const stdin = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' }, cwd: w.worktree });
  const r = await callMain(['hook', 'claude-code', '--home', w.home], { stdin, cwd: tmpDir(), env: { RIVERWRIGHT_HOME: tmpDir('decoy-home-') } });
  assert.equal(r.code, 2, r.stdout);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('the guard and the hook refuse a relative --home (fail closed)', async () => {
  const g = await callMain(['guard', 'pre-push', '--home', 'relative/home', '--', 'fork', FORK], { stdin: line(A), cwd: tmpDir() });
  assert.equal(g.code, 2);
  const h = await callMain(['hook', 'claude-code', '--home', 'relative/home'], { stdin: '{}', cwd: tmpDir() });
  assert.equal(h.code, 2);
});

test('launcherHookCommand carries --home for sh, cmd and PowerShell and refuses unsafe homes', () => {
  assert.equal(
    launcherHookCommand('/Users/Jane Doe/rw', 'claude-code', { platform: 'darwin', home: '/Users/Jane Doe/.riverwright' }),
    '/bin/sh "/Users/Jane Doe/rw/bin/riverwright" hook claude-code --home "/Users/Jane Doe/.riverwright"',
  );
  assert.equal(
    launcherHookCommand('C:\\Program Files\\rw', 'cursor', { platform: 'win32', home: 'C:\\Users\\Jane Doe\\.riverwright\\' }),
    '"C:\\Program Files\\rw\\bin\\riverwright.cmd" hook cursor --home "C:\\Users\\Jane Doe\\.riverwright"',
  );
  assert.equal(
    launcherHookCommand('C:\\Program Files\\rw', 'codex', { platform: 'win32', shell: 'powershell', home: 'C:\\Users\\Jane Doe\\.riverwright' }),
    String.raw`$ErrorActionPreference = 'Stop'; try { $global:LASTEXITCODE = $null; & "C:\Program Files\rw\bin\riverwright.cmd" hook codex --home "C:\Users\Jane Doe\.riverwright"; if ($null -eq $LASTEXITCODE) { exit 2 }; exit $LASTEXITCODE } catch { exit 2 }`,
  );
  assert.equal(
    launcherHookCommand('C:\\Program Files\\rw', 'claude-code', { platform: 'win32', shell: 'sh', home: 'C:\\Users\\Jane Doe\\.riverwright' }),
    '/bin/sh "C:/Program Files/rw/bin/riverwright" hook claude-code --home "C:/Users/Jane Doe/.riverwright"',
  );
  for (const bad of ['relative/home', '/a"b', '/a$HOME/x', '/a`x`', 'C:\\50%\\x', '/a\nb', '/a\u201Cb', '/']) {
    assert.throws(() => launcherHookCommand('/a/rw', 'codex', { platform: 'linux', home: bad }), /UNSAFE_PATH|absolute|cannot be quoted/, JSON.stringify(bad));
  }
});

test('the launcher hook command with a spaced --home denies an outward command in that workspace', posixOnly, async () => {
  const w = await approvedWorkspace(path.join(tmpDir('riverwright-user-'), 'Riverwright Home'));
  const cmd = launcherHookCommand(ROOT, 'claude-code', { platform: process.platform, home: w.home });
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' }, cwd: w.worktree });
  const r = spawnSync('/bin/sh', ['-c', cmd], { input: payload, encoding: 'utf8', cwd: tmpDir(), env: { ...process.env, RIVERWRIGHT_HOME: tmpDir('decoy-home-') } });
  assert.equal(r.status, 2, `${cmd}\n${r.stdout}\n${r.stderr}`);
});

test('the default workspace home comes from the account record, not the environment', () => {
  assert.equal(workspaceHomeFromArg(undefined, { userInfo: () => ({ homedir: '/accounts/jane' }) }), path.join('/accounts/jane', '.riverwright'));
  assert.throws(() => workspaceHomeFromArg(undefined, { userInfo: () => { throw new Error('no passwd entry'); } }), /--home/);
  assert.equal(workspaceHomeFromArg('/x/y/'), path.resolve('/x/y'));
});
