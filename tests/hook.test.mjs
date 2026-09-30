import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HOSTS } from '../scripts/lib/hosts.mjs';
import { createState, saveState } from '../scripts/lib/state.mjs';
import { readLedger } from '../scripts/lib/ledger.mjs';
import { callMain, runRiverwright, tmpDir, ROOT } from './helpers.mjs';

const home = tmpDir('riverwright-home-');
const worktree = path.join(home, 'o', 'r', 'worktrees', 'issue-1');
const runDir = path.join(home, 'o', 'r', 'runs', 'issue-1');
fs.mkdirSync(worktree, { recursive: true });
saveState(runDir, createState({ runId: 'o/r#1', kind: 'fixture', now: 't' }));
const outside = tmpDir('user-project-');

function payload(host, command, cwd) {
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'hooks', `${host}.json`), 'utf8')).payload;
  const fill = (v) => (typeof v === 'string'
    ? v.replace('{{command}}', () => command).replace('{{cwd}}', () => cwd)
    : Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v);
  return JSON.stringify(fill(tpl));
}

const DENY_SHAPE = {
  'claude-code': (o) => o.hookSpecificOutput.permissionDecision === 'deny',
  codex: (o) => o.hookSpecificOutput.permissionDecision === 'deny',
  'grok-build': (o) => o.hookSpecificOutput.permissionDecision === 'deny',
  'gemini-cli': (o) => o.decision === 'deny',
  cursor: (o) => o.permission === 'deny',
  'hermes-agent': (o) => o.decision === 'block',
};

const env = { RIVERWRIGHT_HOME: home };

for (const host of HOSTS) {
  test(`${host}: an outward command inside the workspace is denied in the host's dialect`, async () => {
    const r = await callMain(['hook', host], { stdin: payload(host, 'pytest -q && git push origin riverwright/1-x', worktree), env, cwd: outside });
    assert.equal(r.code, 2);
    assert.ok(DENY_SHAPE[host](JSON.parse(r.stdout)), r.stdout);
  });

  test(`${host}: a safe command inside the workspace is allowed silently`, async () => {
    const r = await callMain(['hook', host], { stdin: payload(host, 'pytest -q', worktree), env, cwd: outside });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });

  test(`${host}: the user's own projects are out of scope`, async () => {
    const r = await callMain(['hook', host], { stdin: payload(host, 'git push origin main', outside), env, cwd: outside });
    assert.equal(r.code, 0);
  });
}

test('a command aimed at the workspace from outside it is in scope', async () => {
  const r = await callMain(['hook', 'claude-code'], { stdin: payload('claude-code', `git -C "${worktree}" push`, outside), env, cwd: outside });
  assert.equal(r.code, 2);
});

test('an unreadable payload inside the workspace is denied', async () => {
  const r = await callMain(['hook', 'cursor'], { stdin: 'not json', env, cwd: worktree });
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).permission, 'deny');
});

test('an unknown host is denied (exit 2)', async () => {
  const r = runRiverwright(['hook', 'notahost'], { stdin: '{}', env });
  assert.equal(r.code, 2);
});

test('a denial is recorded in the run ledger', async () => {
  await callMain(['hook', 'hermes-agent'], { stdin: payload('hermes-agent', 'gh pr create --fill', worktree), env, cwd: outside });
  const last = readLedger(runDir).at(-1);
  assert.equal(last.type, 'guard');
  assert.equal(last.decision, 'deny');
  assert.equal(last.host, 'hermes-agent');
});

test('a fake riverwright inside the workspace does not get the publish exemption', async () => {
  const r = await callMain(['hook', 'claude-code'], { stdin: payload('claude-code', '/tmp/riverwright submit git push origin HEAD', worktree), env, cwd: outside });
  assert.equal(r.code, 2, r.stdout);
});

test('the installed launcher itself may run riverwright submit inside the workspace', async () => {
  const r = await callMain(['hook', 'claude-code'], { stdin: payload('claude-code', `"${path.join(ROOT, 'bin', 'riverwright')}" submit o/r#1`, worktree), env, cwd: outside });
  assert.equal(r.code, 0, r.stdout);
});
