import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { callMain, tmpDir } from './helpers.mjs';
import { createState, saveState } from '../scripts/lib/state.mjs';
import { readLedger, ledgerFile } from '../scripts/lib/ledger.mjs';
import { classifyCommand } from '../scripts/lib/hooks/classify.mjs';

// Sealing, replacing or removing the credential is something the human does in their own terminal.
const DENIED = [
  'riverwright credential setup',
  'rw credential remove',
  '/usr/local/bin/riverwright credential setup --replace',
  './bin/riverwright credential status',
  '../riverwright/bin/rw credential remove',
  'bin/rw credential setup',
  'node /opt/riverwright/scripts/riverwright.mjs credential setup',
  'node scripts/riverwright.mjs credential remove',
  'node --no-warnings ./scripts/riverwright.mjs credential setup',
  'npx riverwright credential setup',
  'npx --yes rw credential setup',
  'pnpm exec riverwright credential setup',
  'pnpm dlx rw credential setup',
  'npm exec riverwright -- credential setup',
  'RIVERWRIGHT_HOME=/tmp/x riverwright credential status',
  'FOO=1 riverwright credential setup',
  'FOO=1 BAR=2 rw credential remove',
  'env FOO=1 riverwright credential setup',
  'env -i rw credential setup',
  'cd /tmp && riverwright credential setup',
  'echo ok; rw credential setup',
  'true || rw credential setup',
  'echo hi | riverwright credential setup',
  'ls & rw credential setup',
  'echo ok\nrw credential setup',
  '(rw credential setup)',
  '{ rw credential setup; }',
  'if true; then rw credential setup; fi',
  'bash -c "riverwright credential setup"',
  "sh -c 'rw credential remove'",
  "sh -c 'echo hi; rw credential remove'",
  'bash -lc "cd /tmp && riverwright credential setup"',
  'zsh -c "node scripts/riverwright.mjs credential setup"',
  "bash -c \"bash -c 'rw credential setup'\"",
  'sudo -u me riverwright credential setup',
  'nohup rw credential setup',
  'time rw credential setup',
  'timeout 5 rw credential setup',
  'xargs -n1 rw credential <<< setup',
  'eval "rw credential setup"',
  'echo "rw credential setup" | sh',
  'sh <<EOF\nrw credential setup\nEOF',
  'riverwright.cmd credential remove',
  'rw.cmd credential remove',
  'RIVERWRIGHT.CMD credential remove',
  'Riverwright Credential Setup',
  'RW CREDENTIAL REMOVE',
  '"riverwright" credential setup',
  "'rw' 'credential' 'remove'",
  'riverwright "credential" setup',
  'riverwright cred""ential setup',
  "riverwright 'cred'ential setup",
  'riverwright cred\\ential setup',
  'r\\iverwright credential setup',
  'riv""erwright credential setup',
  '\\riverwright credential setup',
  'riverwright --home /tmp/h credential setup',
  'riverwright --home=/tmp/h credential setup',
  '"/opt/my tools/riverwright" credential setup',
  '/opt/my\\ tools/riverwright credential setup',
  'command riverwright credential setup',
  'exec rw credential setup',
  'echo $(rw credential status)',
  'echo `rw credential status`',
  'find . -exec rw credential remove ;',
  'node -e "require(\'child_process\').execFileSync(\'riverwright\', [\'credential\', \'setup\'])"',
  'node -e "require(\'child_process\').execSync(\'riverwright credential setup\')"',
  'python3 -c "import subprocess; subprocess.run([\'rw\', \'credential\', \'setup\'])"',
  'cmd /c "riverwright.cmd credential remove"',
  'pwsh -Command "& riverwright credential setup"',
  'riverwright $SUB',
  'rw ${ACTION} setup',
  'CMD=credential; riverwright $CMD setup',
];
const ALLOWED = [
  'riverwright ledger verify --run /tmp/x',
  'riverwright state get --run /tmp/x',
  'rw version',
  'git commit -m "rotate credential handling"',
  'echo credential',
  'grep -r credential src',
  'npm test',
  'node --test tests/hook-credential.test.mjs',
  'cat docs/specs/credential.md',
  'ls riverwright',
  'riverwright ledger verify --run "$RUN"',
  'riverwright --home "$H" state get',
];

test('the hook denies an agent shell command that runs riverwright credential in any spelling', () => {
  const missed = DENIED.filter((c) => classifyCommand(c).outward !== true);
  assert.deepEqual(missed, []);
  for (const c of DENIED) {
    const v = classifyCommand(c);
    // Setting RIVERWRIGHT_HOME is refused first by the stricter riverwright-env rule, and a variable stands in for
    // the subcommand is refused as unresolvable; either way it is denied.
    if (!/^RIVERWRIGHT_HOME=/.test(c) && !/\$/.test(c) && !/^eval|\| sh$|^xargs|^sh <</.test(c)) {
      assert.equal(v.rule, 'riverwright-credential', JSON.stringify(c));
    }
  }
});

test('other riverwright commands and unrelated uses of the word are not blocked by that rule', () => {
  for (const c of ALLOWED) assert.equal(classifyCommand(c).outward, false, c);
});

test('on Windows a backslash path to the launcher is read as a path', () => {
  for (const c of ['C:\\tools\\riverwright\\bin\\riverwright.cmd credential setup', '"C:\\Program Files\\rw\\bin\\rw.cmd" credential remove', 'node C:\\rw\\scripts\\riverwright.mjs credential setup']) {
    assert.equal(classifyCommand(c, { platform: 'win32' }).rule, 'riverwright-credential', c);
  }
  assert.equal(classifyCommand('C:\\rw\\bin\\riverwright.cmd ledger verify', { platform: 'win32' }).outward, false);
});

// The rule works through the host hook, like every other Lock 2 rule: inside the workspace it denies.
const home = tmpDir('riverwright-home-');
const worktree = path.join(home, 'o', 'r', 'worktrees', 'issue-1');
const runDir = path.join(home, 'o', 'r', 'runs', 'issue-1');
fs.mkdirSync(worktree, { recursive: true });
saveState(runDir, createState({ runId: 'o/r#1', kind: 'fixture', now: 't' }));
const outside = tmpDir('user-project-');
const hookPayload = (command, cwd) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

test('the hook denies riverwright credential inside the workspace, names the rule, and records the denial', async () => {
  const r = await callMain(['hook', 'claude-code', '--home', home], { stdin: hookPayload('FOO=1 rw credential remove', worktree), env: {}, cwd: outside });
  assert.equal(r.code, 2);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /riverwright-credential/);
  assert.ok(readLedger(runDir).some((e) => e.type === 'guard' && e.decision === 'deny'));
});

test('the hook leaves riverwright credential alone outside the workspace (the human types it in their own terminal)', async () => {
  const r = await callMain(['hook', 'claude-code', '--home', home], { stdin: hookPayload('rw credential status', outside), env: {}, cwd: outside });
  assert.equal(r.code, 0);
});

test('a ledger that cannot be written does not change the denial, and the failure is shown on stderr (one clean line)', async () => {
  const h2 = tmpDir('riverwright-home-');
  const wt = path.join(h2, 'o', 'r', 'worktrees', 'issue-1');
  const rd = path.join(h2, 'o', 'r', 'runs', 'issue-1');
  fs.mkdirSync(wt, { recursive: true });
  saveState(rd, createState({ runId: 'o/r#1', kind: 'fixture', now: 't' }));
  // A directory where the ledger file belongs makes every append fail.
  fs.mkdirSync(ledgerFile(rd), { recursive: true });
  const r = await callMain(['hook', 'claude-code', '--home', h2], { stdin: hookPayload('rw credential setup', wt), env: {}, cwd: outside });
  assert.equal(r.code, 2);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.stderr, /^riverwright hook: could not record this denial in the ledger: .+\n$/);
  assert.doesNotMatch(r.stderr, /[\x00-\x08\x0b-\x1f\x7f]/);
});
