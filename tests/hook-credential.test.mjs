import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { callMain, tmpDir, ROOT } from './helpers.mjs';
import { createState, saveState } from '../scripts/lib/state.mjs';
import { readLedger, ledgerFile } from '../scripts/lib/ledger.mjs';
import { classifyCommand } from '../scripts/lib/hooks/classify.mjs';

const posixOnly = { skip: process.platform === 'win32' };

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
// Fix round 1 (R24): brace and glob spellings, xargs/parallel/find feeding riverwright, versioned package
// runners, an unresolvable program word with a credential argument, inline code that loads the CLI.
const DENIED_R24 = [
  'rw {,credential} remove',
  '{rw,credential} remove',
  'rw cred{,}ential remove',
  'touch credential; rw credentia? remove',
  'rw c[r]edential remove',
  'rw cred*l remove',
  'rw cre{d..d}ential remove',
  '/usr/local/bin/riverw?ight credential remove',
  './bin/riverw*t credential setup',
  'ri[v]erwright credential setup',
  '/opt/rw/bin/{riverwright,x} credential setup',
  'sudo /usr/local/bin/riverw?ight credential remove',
  'echo credential remove | xargs rw',
  'xargs -a /tmp/args rw',
  'xargs rw < /tmp/args',
  'xargs -0 riverwright < /tmp/args',
  'echo rw | xargs -I{} {} credential setup',
  'echo credential | parallel rw',
  'parallel rw :::: /tmp/args',
  'parallel "rw {}" ::: credential',
  'find credential -prune -exec rw {} remove \\;',
  'find . -name credential -execdir riverwright {} setup +',
  'npx riverwright@latest credential setup',
  'npx @pacphi/riverwright@1.2.3 credential setup',
  'npx -y rw@next credential remove',
  'pnpm dlx riverwright@1.0.0 credential setup',
  'pnpm exec rw@1 credential setup',
  'npm exec riverwright@latest -- credential setup',
  'npm exec --package=riverwright@1 -- rw credential setup',
  'bunx riverwright@latest credential setup',
  'npx $PKG credential setup',
  'npx riverwright@latest $SUB',
  '$(echo riverwright) credential setup',
  '`echo rw` credential setup',
  '$RW credential setup',
  '"$RW" credential remove',
  '* credential setup',
  'sudo -u me $X credential setup',
  'env RIVERWRIGHT_HOME=/x $X credential setup',
  'nice -n 5 $X cred* setup',
  'RIVERWRIGHT_HOME=/x rw credential setup',
  'Start-Process rw -ArgumentList \'credential\',\'setup\'',
  'node -e "import(\'/opt/rw/scripts/lib/cli.mjs\').then((m) => m.main([\'cred\' + \'ential\', \'setup\']))"',
  'node --input-type=module -e "await import(\'./scripts/lib/commands/credential.mjs\')"',
  'node -p "require(\'child_process\').execFileSync(\'riverwright\', [\'--home\', h, \'credential\', \'remove\'])"',
  'node --eval="require(\'child_process\').spawnSync(\'rw\', [\'--home\', \'/x\', \'credential\'])"',
  'python3 -c "import subprocess; subprocess.run([\'riverwright\', \'--home\', h, \'credential\', \'setup\'])"',
  'perl -e \'system("riverwright", "--home", "/x", "credential", "remove")\'',
  'ruby -e \'system("rw", "--home", "/x", "credential", "remove")\'',
  'deno eval "new Deno.Command(\'riverwright\', { args: [\'--home\', \'/x\', \'credential\'] }).outputSync()"',
  'bun -e "Bun.spawnSync([\'rw\', \'--home\', \'/x\', \'credential\'])"',
  'node -e "require(\'/opt/rw/scripts/lib/cli.mjs\')"',
  'shopt -s expand_aliases\nalias x=\'rw credential\'\nx setup',
  "alias r='riverwright'",
  'echo credential | xargs nice rw',
  'script -q /dev/null riverw?ight credential setup',
  'yarn dlx riverwright@2 credential setup',
  'deno run /opt/rw/scripts/riverwright.mjs credential setup',
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
// Fix round 1 (I1): "rw" or "riverwright" as a plain word (a grep pattern, a mount option, a file name) next to a
// variable is not a riverwright command; only riverwright in program position has its subcommand checked.
const ALLOWED_I1 = [
  'grep -n rw "$FILE"',
  'mount -o rw "$DEV" /mnt',
  'echo rw $HOME',
  'grep -c riverwright $f',
  'for f in *.log; do grep rw "$f"; done',
  'sed -i s/a/b/ rw $X',
  'grep -rn riverwright "$DIR"',
  'riverwright ledger verify --run runs/*',
  'ls rw/*.md',
  'grep -rn rw src/*',
  'npx prettier@3 --check .',
  'echo $HOME credentials',
  'find . -name "*.mjs" -exec grep -l rw {} +',
  'echo push | xargs printf "%s\\n"',
];

test('the hook denies an agent shell command that runs riverwright credential in any spelling', () => {
  const missed = [...DENIED, ...DENIED_R24].filter((c) => classifyCommand(c).outward !== true);
  assert.deepEqual(missed, []);
});

test('every denied spelling is denied by the riverwright-credential rule itself (so it applies everywhere)', () => {
  const wrong = [...DENIED, ...DENIED_R24].map((c) => [c, classifyCommand(c).rule]).filter(([, rule]) => rule !== 'riverwright-credential');
  assert.deepEqual(wrong, []);
});

test('other riverwright commands and unrelated uses of the word are not blocked by that rule', () => {
  for (const c of [...ALLOWED, ...ALLOWED_I1]) assert.equal(classifyCommand(c).outward, false, c);
});

test('a symlink to the launcher or its script, by any name, is the launcher', posixOnly, () => {
  const dir = tmpDir('rw-links-');
  const links = { x: path.join(ROOT, 'bin', 'riverwright'), y: path.join(ROOT, 'bin', 'rw'), 'a.mjs': path.join(ROOT, 'scripts', 'riverwright.mjs'), 'b.mjs': path.join(ROOT, 'scripts', 'lib', 'cli.mjs') };
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(dir, name));
  for (const c of [`${dir}/x credential setup`, `${dir}/y credential remove`, `node ${dir}/a.mjs credential setup`, `node ${dir}/b.mjs credential setup`, `sudo ${dir}/x credential setup`]) {
    assert.equal(classifyCommand(c).rule, 'riverwright-credential', c);
  }
  // A relative path is resolved against the command's working directory.
  assert.equal(classifyCommand('./x credential setup', { cwd: dir }).rule, 'riverwright-credential');
  assert.equal(classifyCommand('node a.mjs credential setup', { cwd: dir }).rule, 'riverwright-credential');
  // The symlinked launcher running something else is not blocked.
  assert.equal(classifyCommand(`${dir}/x ledger verify --run /tmp/r`).outward, false);
  // A program word that resolves to the launcher has its subcommand checked: a variable could be "credential".
  assert.equal(classifyCommand(`${dir}/x $SUB`).rule, 'riverwright-credential');
});

test('a command nested too deeply to read that mentions credential is denied by the credential rule', () => {
  let c = 'rw credential setup';
  for (let k = 0; k < 12; k += 1) c = `sh -c ${JSON.stringify(c)}`;
  assert.equal(classifyCommand(c).rule, 'riverwright-credential');
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

// R23: the credential rule is always in scope. Hooks see only an agent's tool calls; the human types
// "riverwright credential" in their own terminal, which no hook sees.
const idleHome = tmpDir('riverwright-home-');
fs.mkdirSync(path.join(idleHome, 'o', 'r', 'worktrees'), { recursive: true });

test('the hook denies riverwright credential outside the workspace too, with or without an active run', async () => {
  for (const h of [home, idleHome]) {
    for (const c of ['rw credential status', 'rw credential remove', 'rw credential setup --replace', 'RIVERWRIGHT_HOME=/x rw credential setup', 'echo credential remove | xargs rw', 'rw {,credential} remove', 'rw $SUB', '$(echo rw) credential setup', 'npx riverwright@latest credential setup']) {
      const r = await callMain(['hook', 'claude-code', '--home', h], { stdin: hookPayload(c, outside), env: {}, cwd: outside });
      assert.equal(r.code, 2, `${c} (home ${h === home ? 'with' : 'without'} an active run)`);
      assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /riverwright-credential/, c);
      assert.doesNotMatch(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /Public actions go through/, c);
    }
  }
});

test('the hook denies a symlinked launcher run from the payload working directory', posixOnly, async () => {
  const dir = tmpDir('rw-links-');
  fs.symlinkSync(path.join(ROOT, 'bin', 'riverwright'), path.join(dir, 'tool'));
  const r = await callMain(['hook', 'claude-code', '--home', idleHome], { stdin: hookPayload('./tool credential setup', dir), env: {}, cwd: outside });
  assert.equal(r.code, 2);
});

test('I1: a plain word "rw" next to a variable is allowed outside the workspace while a run is active', async () => {
  for (const c of ['grep -n rw "$FILE"', 'echo rw $HOME', 'mount -o rw "$DEV" /mnt', 'grep -rn riverwright "$DIR"']) {
    const r = await callMain(['hook', 'claude-code', '--home', home], { stdin: hookPayload(c, outside), env: {}, cwd: outside });
    assert.equal(r.code, 0, c);
  }
});

test('other riverwright commands outside the workspace are still allowed', async () => {
  for (const c of ['rw version', 'riverwright ledger verify --run "$RUN"', 'riverwright --home "$H" state get']) {
    const r = await callMain(['hook', 'claude-code', '--home', home], { stdin: hookPayload(c, outside), env: {}, cwd: outside });
    assert.equal(r.code, 0, c);
  }
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
