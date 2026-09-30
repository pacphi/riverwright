import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createState, saveState, stopRun, hasActiveRun } from '../scripts/lib/state.mjs';
import { callMain, tmpDir } from './helpers.mjs';

// A fake user home: <top>/.riverwright is the workspace, <top>/project is the user's own repo.
function world({ active = true } = {}) {
  const top = tmpDir('riverwright-user-');
  const home = path.join(top, '.riverwright');
  const worktree = path.join(home, 'o', 'r', 'worktrees', 'issue-1');
  const project = path.join(top, 'project');
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  let s = createState({ runId: 'o/r#1', kind: 'fixture', now: 't' });
  if (!active) s = stopRun(s, 'user-stopped', { now: 't' });
  saveState(path.join(home, 'o', 'r', 'runs', 'issue-1'), s);
  return { top, home, worktree, project, env: { HOME: top, USERPROFILE: top, RIVERWRIGHT_HOME: home } };
}

const hook = (w, command, cwd, stdin) => callMain(['hook', 'claude-code'], {
  stdin: stdin ?? JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd }),
  env: w.env,
  cwd,
});

test('$HOME and ~ in a -C path are expanded before deciding scope', async () => {
  const w = world();
  for (const cmd of [
    'git -C "$HOME/.riverwright/o/r/worktrees/issue-1" push --no-verify origin HEAD',
    'git -C "${HOME}/.riverwright/o/r/worktrees/issue-1" push origin HEAD',
    'git -C ~/.riverwright/o/r/worktrees/issue-1 push origin HEAD',
    'git -C %USERPROFILE%/.riverwright/o/r/worktrees/issue-1 push origin HEAD',
    'cd ~/.riverwright/o/r/worktrees/issue-1 && git push origin HEAD',
    'git --git-dir="$HOME/.riverwright/o/r/worktrees/issue-1/.git" push origin HEAD',
  ]) {
    const r = await hook(w, cmd, w.top);
    assert.equal(r.code, 2, cmd);
  }
});

test('a relative path into the workspace is resolved against the payload cwd', async () => {
  const w = world();
  const r = await hook(w, 'git -C ../.riverwright/o/r/worktrees/issue-1 push origin HEAD', w.project);
  assert.equal(r.code, 2);
  const r2 = await hook(w, 'cd ../.riverwright/o/r/worktrees/issue-1; git push origin HEAD', w.project);
  assert.equal(r2.code, 2);
});

test('a symlink that resolves into the workspace is in scope', { skip: process.platform === 'win32' }, async () => {
  const w = world();
  const link = path.join(w.top, 'innocent');
  fs.symlinkSync(w.worktree, link);
  assert.equal((await hook(w, `git -C ${link} push origin HEAD`, w.project)).code, 2);
  assert.equal((await hook(w, 'git -C ../innocent push origin HEAD', w.project)).code, 2);
  assert.equal((await hook(w, `cd "${link}" && git push`, w.project)).code, 2);
});

test('an outward command with an unresolved variable is denied while a run is active', async () => {
  const w = world();
  const r = await hook(w, 'git -C "$WORK" push origin HEAD', w.project);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /unresolvable-with-active-run/);
  const idle = world({ active: false });
  assert.equal((await hook(idle, 'git -C "$WORK" push origin HEAD', idle.project)).code, 0);
});

test('a plain git push in the user\'s own project is still allowed', async () => {
  const idle = world({ active: false });
  assert.equal((await hook(idle, 'git push origin main', idle.project)).code, 0);
  const busy = world();
  assert.equal((await hook(busy, 'git push origin main', busy.project)).code, 0);
});

test('an unreadable payload is denied while a run is active, even outside the workspace', async () => {
  const w = world();
  assert.equal((await hook(w, null, w.project, 'not json')).code, 2);
  assert.equal((await hook(w, null, w.project, '{}')).code, 2);
  const idle = world({ active: false });
  assert.equal((await hook(idle, null, idle.project, 'not json')).code, 0);
});

test('hasActiveRun reads every run and fails closed on a broken record', () => {
  assert.equal(hasActiveRun(path.join(tmpDir(), 'missing')), false);
  assert.equal(hasActiveRun(world({ active: false }).home), false);
  assert.equal(hasActiveRun(world().home), true);
  const broken = world({ active: false });
  const dir = path.join(broken.home, 'x', 'y', 'runs', 'issue-2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), '{nope');
  assert.equal(hasActiveRun(broken.home), true);
});
