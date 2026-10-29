// Task 17 (independent security review of Plan 2a): one regression test group per finding. Each test reproduces
// the finding exactly as the review described it. The record of findings and outcomes is in
// docs/research/credential-separation.md ("Review findings for Plan 2a").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { classifyCommand } from '../scripts/lib/hooks/classify.mjs';
import { lex } from '../scripts/lib/hooks/shell.mjs';
import { GENESIS, eventsFile, verifyChain } from '../scripts/lib/events.mjs';
import { appendEvent } from '../scripts/lib/ledger.mjs';
import { createState, hasActiveRun, saveState, stateFile } from '../scripts/lib/state.mjs';
import { RIVERWRIGHT, ROOT, callMain, tmpDir } from './helpers.mjs';

const posixOnly = { skip: process.platform === 'win32' };

const hermeticDir = tmpDir('rw-t17-');
const HERMETIC_ENV = { HOME: hermeticDir, GIT_CONFIG_NOSYSTEM: '1' };
const classify = (c, o = {}) => classifyCommand(c, { cwd: hermeticDir, env: HERMETIC_ENV, ...o });
const hookPayload = (command, cwd) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

// Runs the real hook entry (a child process) for one command; the workspace is a scratch folder.
function realHook(command, { home = tmpDir('riverwright-home-'), cwd = hermeticDir, env = HERMETIC_ENV } = {}) {
  const r = spawnSync(process.execPath, [RIVERWRIGHT, 'hook', 'claude-code', '--home', home], {
    input: hookPayload(command, cwd), env: { PATH: process.env.PATH, ...env }, cwd: hermeticDir, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(r.error?.code, undefined, `${JSON.stringify(command)}: the hook did not return`);
  return r;
}

// C1 (Codex): bash cuts an ANSI-C $'...' segment at a NUL, and execve cuts every argument at its first NUL (zsh keeps
// the NUL in the word, so the program sees only the text before it). The classifier must read the words the program
// receives, under both readings.
test('C1: the lexer cuts an ANSI-C segment at a decoded NUL, as bash does', () => {
  for (const [src, want] of [
    ["$'ab\\0cd'ef", 'abef'], ["$'ab\\x00cd'", 'ab'], ["$'q\\c@r's", 'qs'], ["$'a\\u0000b'", 'a'], ["$'a\\000b'", 'a'], ["$'a\\U00000000b'", 'a'],
  ]) {
    assert.equal(lex(src).commands[0].words[0].value, want, src);
  }
  // The other reading (zsh, or any program receiving the word through execve): the whole word ends at the NUL.
  assert.equal(lex("$'ab\\0cd'ef", { nul: 'word' }).commands[0].words[0].value, 'ab');
});

const C1_CREDENTIAL = [
  "rw $'credential\\0ignored' setup --replace",
  "rw $'credential\\0x' setup",
  "rw $'credential\\x00x' setup",
  "rw $'credential\\c@x' setup",
  "rw $'credential\\u0000x' setup",
  "$'rw\\0x' credential setup",
  "rw $'credential\\0'x setup",
];
const C1_OUTWARD = [
  ["gh pr $'create\\0ignored' --fill", 'gh-pr-create'],
  ["gh pr $'create\\0x' --fill", 'gh-pr-create'],
  ["gh pr $'create\\0'x --fill", 'gh-pr-create'],
  ["gh pr $'cre\\0x'ate --fill", 'gh-pr-create'],
  ["git $'push\\0ignored' --no-verify fork HEAD", 'git-push'],
  ["git $'push\\0x' fork HEAD", 'git-push'],
  ["git $'push\\x00x' fork HEAD", 'git-push'],
];

test('C1: a NUL escape cannot hide credential, gh pr create or git push from their rules', () => {
  for (const c of C1_CREDENTIAL) assert.equal(classify(c).rule, 'riverwright-credential', c);
  for (const [c, rule] of C1_OUTWARD) assert.equal(classify(c).rule, rule, c);
  // A raw NUL in the command text is read with and without it.
  assert.equal(classify('rw cre\0dential setup').rule, 'riverwright-credential');
  assert.equal(classify('gh pr create\0x --fill').rule, 'gh-pr-create');
  // Controls: a NUL elsewhere changes nothing.
  assert.equal(classify("rw $'version\\0x'").outward, false);
  assert.equal(classify("echo $'a\\0b'").outward, false);
});

test('C1: the real hook denies the NUL spellings (exit 2)', () => {
  const home = tmpDir('riverwright-home-');
  const worktree = path.join(home, 'o', 'r', 'worktrees', 'issue-1');
  fs.mkdirSync(worktree, { recursive: true });
  for (const c of ["rw $'credential\\0x' setup", "rw $'credential\\0ignored' setup --replace"]) {
    const r = realHook(c, { home });
    assert.equal(r.status, 2, c);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /riverwright-credential/, c);
  }
  // The publication rules hold inside the workspace.
  for (const c of ["gh pr $'create\\0x' --fill", "git $'push\\0x' fork HEAD"]) {
    const r = realHook(c, { home, cwd: worktree });
    assert.equal(r.status, 2, c);
  }
});

// C2 (Codex): an empty or missing ledger ignored a supplied head anchor, so emptying events.ndjson hid the whole
// consent history from `ledger verify --head H`.
const SAVED_HEAD = `sha256:${'a'.repeat(64)}`;
const noAccount = { testing: { userInfo: () => ({ homedir: tmpDir('rw-account-') }) } };

test('C2: verifyChain fails an empty or missing ledger when a non-genesis head is anchored', () => {
  const missing = tmpDir('rw-ledger-');
  const empty = tmpDir('rw-ledger-');
  fs.writeFileSync(eventsFile(empty), '');
  for (const dir of [missing, empty]) {
    const r = verifyChain(dir, { expectHead: SAVED_HEAD });
    assert.equal(r.ok, false, dir);
    assert.match(r.problems[0].reason, /empty.*anchored head|anchored head.*empty/i);
    // The genesis head is what an empty ledger really has.
    assert.equal(verifyChain(dir, { expectHead: GENESIS }).ok, true);
    assert.equal(verifyChain(dir).ok, true);
  }
});

test('C2: ledger verify --head on an emptied or missing ledger exits 1 and says why', async () => {
  const kept = tmpDir('rw-ledger-');
  for (const type of ['run-created', 'note']) appendEvent(kept, { type, at: 't' });
  const head = verifyChain(kept).head;
  fs.writeFileSync(eventsFile(kept), '');
  const gone = tmpDir('rw-ledger-');
  for (const dir of [kept, gone]) {
    const r = await callMain(['ledger', 'verify', '--run', dir, '--head', dir === kept ? head : SAVED_HEAD], noAccount);
    assert.equal(r.code, 1, dir);
    assert.match(r.stderr, /Ledger check failed.*empty.*anchored head/);
    assert.doesNotMatch(r.stdout, /Ledger intact/);
  }
  const genesis = await callMain(['ledger', 'verify', '--run', gone, '--head', GENESIS], noAccount);
  assert.equal(genesis.code, 0);
});

// C3 (Codex) / F4 (Claude): active-run detection read state.json with an unbounded, blocking readFileSync, so a FIFO
// planted there hung the hook (and a host that allows a command after a hook timeout would let it run).
const runHome = () => {
  const home = tmpDir('riverwright-home-');
  const run = path.join(home, 'o', 'r', 'runs', 'issue-9');
  fs.mkdirSync(run, { recursive: true });
  fs.mkdirSync(path.join(home, 'o', 'r', 'worktrees'), { recursive: true });
  return { home, run };
};
const stoppedState = () => ({ ...createState({ runId: 'o/r#9', kind: 'fixture', now: 't' }), status: 'stopped' });

// Runs a state.mjs call in a child process, so a read that blocks fails the test instead of hanging the suite.
function inChild(code) {
  const url = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'state.mjs')).href;
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import * as m from ${JSON.stringify(url)};\n${code}`], { encoding: 'utf8', timeout: 5000 });
}

test('C3/F4: a directory, oversized or unreadable state.json counts as an active run', () => {
  const dir = runHome();
  fs.mkdirSync(stateFile(dir.run));
  assert.equal(hasActiveRun(dir.home), true, 'directory');
  const big = runHome();
  fs.writeFileSync(stateFile(big.run), JSON.stringify({ ...stoppedState(), pad: 'x'.repeat(2 * 1024 * 1024) }));
  assert.equal(hasActiveRun(big.home), true, 'oversized');
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = runHome();
    saveState(locked.run, stoppedState());
    fs.chmodSync(stateFile(locked.run), 0o000);
    assert.equal(hasActiveRun(locked.home), true, 'unreadable');
    fs.chmodSync(stateFile(locked.run), 0o600);
  }
  const stopped = runHome();
  saveState(stopped.run, stoppedState());
  assert.equal(hasActiveRun(stopped.home), false, 'a stopped run is not active');
});

test('C3/F4: a FIFO at state.json counts as an active run and never blocks', posixOnly, () => {
  const { home, run } = runHome();
  assert.equal(spawnSync('mkfifo', [stateFile(run)]).status, 0);
  const active = inChild(`console.log(m.hasActiveRun(${JSON.stringify(home)}))`);
  assert.equal(active.error?.code, undefined, 'hasActiveRun blocked on the FIFO');
  assert.equal(active.stdout.trim(), 'true');
  const load = inChild(`try { m.loadState(${JSON.stringify(run)}); console.log('loaded'); } catch (e) { console.log(e.code); }`);
  assert.equal(load.error?.code, undefined, 'loadState blocked on the FIFO');
  assert.equal(load.stdout.trim(), 'BAD_STATE');
});

test('C3/F4: the real hook returns promptly with a FIFO at state.json, and denies (an active run)', posixOnly, () => {
  const { home, run } = runHome();
  assert.equal(spawnSync('mkfifo', [stateFile(run)]).status, 0);
  const outside = tmpDir('user-project-');
  const t0 = Date.now();
  const r = realHook('gh pr create -R "$UP" --fill', { home, cwd: outside });
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /unresolvable-with-active-run/);
  // An unreadable payload reaches the same check.
  const u = spawnSync(process.execPath, [RIVERWRIGHT, 'hook', 'claude-code', '--home', home], { input: 'not json', env: { PATH: process.env.PATH, ...HERMETIC_ENV }, cwd: hermeticDir, encoding: 'utf8', timeout: 5000 });
  assert.equal(u.error?.code, undefined, 'the hook blocked on the FIFO');
  assert.equal(u.status, 2);
});
