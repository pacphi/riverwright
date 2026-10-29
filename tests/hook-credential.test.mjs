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
// Fix round 2 (R25): the credential rule is a text match over the whole command. These spellings reach no
// modelled program position: a literal riverwright word behind a launcher the classifier does not know, with a
// variable, substitution, glob or brace after it (N1), and payloads that are literal text inside another
// command (N2). They stay denied without any shell modelling.
const DENIED_R25 = [
  'C=credential; script -q /dev/null rw "$C" setup --replace',
  'script -q /dev/null rw "$(printf credential)" remove',
  'script -q /dev/null rw $C remove',
  'xvfb-run rw $C remove',
  'rlwrap rw $C remove',
  'firejail rw $C remove',
  'gdb --args rw $C remove',
  'chroot / rw $C remove',
  'pkexec rw $C remove',
  'runuser -u me -- rw $C remove',
  'systemd-run --user rw $C remove',
  'faketime now rw $C remove',
  'winpty rw $C remove',
  'touch credential; script -q /dev/null rw c*l setup',
  'valgrind rw c*l',
  'unshare -r rw c*l',
  'xvfb-run riverwright credential setup',
  'winpty rw.cmd credential remove',
  'C=credential; su -c "rw $C setup"',
  'expect -c "spawn rw $C setup"',
  'tmux new "rw $C setup"',
  'script -c "rw $C setup"',
  "su -c 'riverwright credential setup'",
  'expect -c "spawn riverwright credential setup"',
  "tmux new 'rw credential setup'",
  "git -c alias.x='!rw credential setup --replace' x",
  'ssh -o ProxyCommand="rw credential setup" localhost true',
  'x="rw credential setup"; $x',
  'F="rw credential setup"; eval "$F"',
  'eval rw \\$C',
  "sh -c 'rw $C'",
  'bash -c "rw c*l remove"',
  'rw @(credential) setup',
  'rw +(credential) setup',
  'rw !(x) setup',
  'cmd /c "rw.cmd %SUB%"',
  'xvfb-run ri[v]erwright credential setup',
  'rlwrap r{w,x} credential setup',
  'firejail river{wright,x} credential setup',
  'script -q /dev/null ri{v,}erwright credential setup',
  // PowerShell splatting: @args can hold 'credential','setup'.
  'rw @args',
  'pwsh -c "& rw @a"',
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
];
// Fix round 1 (I1): "rw" or "riverwright" as a plain word (a grep pattern, a mount option, a file name) is not a
// riverwright command.
const ALLOWED_I1 = [
  'grep -n rw file.txt',
  'mount -o rw /dev/x /mnt',
  'rw --home /abs state get',
  'rw ledger verify --run /abs',
  'npx prettier@3 --check .',
  'echo $HOME credentials',
  'echo push | xargs printf "%s\\n"',
  'node -e "require(\'./lib/cli.js\')"',
  'docker run -v "$PWD":/w:rw img',
  'grep -n credential scripts/lib/commands/credential.mjs',
  'git log -- scripts/lib/commands/credential.mjs',
  'cd /x/riverwright-worktrees/plan && ls *.mjs',
  'ls /x/riverwright/docs',
  'echo rw',
  'npx riverwright@latest ledger verify --run /abs',
  'ssh me@host rw version',
  // A directory named rw is not the program.
  'ls rw/*.md',
  'cat rw/$X',
];
// Fix round 3 (R26): the lexer decodes every word first (ANSI-C $'..', quotes, escapes, line continuations), then
// the subcommand-slot rule checks the word after anything that is or could be riverwright, wherever it stands in a
// command that is not a known non-executing tool.
const DENIED_R26 = [
  'rw cred\\\nential setup',
  'rw cred\\\r\nential setup',
  "$'\\x72w' credential setup",
  "$'\\162\\167' credential",
  "rw $'\\u0063redential' setup",
  'r\\\nw credential setup',
  'rw "cred\\\nential" setup',
  "script -q /dev/null $'\\x72w' credential setup",
  'xvfb-run rw cred\\\nential',
  "xvfb-run $'\\162\\167' $'\\143redential'",
  'script -q /dev/null rw cred{ential,} remove',
  'xvfb-run rw {,credential} remove',
  'rlwrap ri{v,}erwright credential setup',
  'faketime now rw c[r]edential',
  '$X $C',
  'xvfb-run $X credential',
  'xvfb-run rw @args',
  'rw${IFS}credential setup',
  "git -c alias.x='!rw' x credential setup",
  'EDITOR="rw credential remove" git commit',
  "git -c core.pager='rw credential remove' log",
  'ssh host rw \\$C',
  'watch -n 1 rw \\$C',
  'npm exec riverwright -- credential setup',
  'shopt -s nullglob; rw x* credential',
  'deno run -A npm:riverwright credential setup',
  "python3 -c \"import os; os.system('rw ' + 'credential')\"",
  "sed -e 's/.*/rw credential setup/e' f",
  // fish and PowerShell evaluate a parenthesised argument: its output is the slot.
  'rw (echo credential)',
  "& rw ('cred'+'ential')",
  // git subcommands that run commands, BSD sed -i '', rg --pre, and code piped to something that runs it.
  'git bisect run rw credential setup',
  "git rebase -x 'rw credential setup' HEAD~2",
  "git submodule foreach 'rw credential setup'",
  "git difftool --extcmd='rw credential setup'",
  "git config core.editor 'rw credential setup' && git commit",
  "sed -i '' 's/.*/rw credential setup/e' f",
  'touch credential; rg --pre rw x credential',
  'rg --pre=rw x credential',
  "echo -e 'rw credential setup' | sh",
  "printf '%s\\n' rw credential setup | sh",
  "echo 'rw credential setup' | at now",
  "echo '* * * * * rw credential setup' | crontab -",
  "echo 'rw credential setup' | ssh host",
];
// R26 accepted cost: an unknown program may run its arguments, so a variable there could be riverwright, and the
// variable after it the subcommand. The xargs and gh rules are unchanged structural checks.
const DENIED_COST_R26 = [
  'rm "$A" "$B"',
  'node build.js "$IN" "$OUT"',
  'ls | xargs rw ledger verify',
  "gh pr create --title 'rw credential fix'",
];
// R26 lifts R25's text rule: a riverwright word next to a variable, glob or brace is allowed when the word after the
// program is plainly not "credential", and the arguments of a known non-executing tool are never read as programs.
const ALLOWED_R26 = [
  'riverwright ledger verify --run "$RUN"',
  'riverwright --run="$RUN" ledger verify',
  'rw state get --run "$R"',
  'riverwright --home "$H" state get',
  'grep -n rw "$FILE"',
  'echo rw $HOME',
  'mount -o rw "$DEV" /mnt',
  'grep -rn rw src/*',
  'cd /x/riverwright && node --test tests/*.test.mjs',
  'cd /x/riverwright && ls *.md',
  'rw ledger verify --run runs/*',
  'chmod u+rw "$F"',
  "curl 'https://x/rw?a=b'",
  'grep -c riverwright $f',
  'for f in *.log; do grep rw "$f"; done',
  'sed -i s/a/b/ rw $X',
  'grep -rn riverwright "$DIR"',
  'riverwright ledger verify --run runs/*',
  'find . -name "*.mjs" -exec grep -l rw {} +',
  'rw --home="$H" state get',
  'rw version && npm i @types/node',
  'git commit -m "fix: riverwright credential setup reads the tty"',
  'grep -rn "rw credential" docs',
  'echo riverwright credential',
  'rw help credential',
  'rw state get *',
  'ls rw $(pwd)',
  'echo riverwright `date`',
  "git commit -m 'rw credential'",
  "git log --grep 'rw credential'",
  'git config user.name rw',
  'git rebase -i HEAD~2',
  'echo rw credential | grep x',
];
// The CLI dispatches on its first argument only (scripts/lib/cli.mjs main), so these cannot run the credential
// command: riverwright answers "unknown command --home". The slot rule allows them.
const NOT_A_WAY = [
  'riverwright --home /tmp/h credential setup',
  'riverwright --home=/tmp/h credential setup',
  'rw --home "$H" $SUB',
];

test('the hook denies an agent shell command that runs riverwright credential in any spelling', () => {
  const missed = [...DENIED, ...DENIED_R24, ...DENIED_R25, ...DENIED_R26].filter((c) => classifyCommand(c).outward !== true);
  assert.deepEqual(missed, []);
});

test('every denied spelling is denied by the riverwright-credential rule itself (so it applies everywhere)', () => {
  const wrong = [...DENIED, ...DENIED_R24, ...DENIED_R25, ...DENIED_R26].map((c) => [c, classifyCommand(c).rule]).filter(([, rule]) => rule !== 'riverwright-credential');
  assert.deepEqual(wrong, []);
});

test('R26: a variable followed by a variable in an unknown program is denied (accepted cost)', () => {
  const wrong = DENIED_COST_R26.map((c) => [c, classifyCommand(c).rule]).filter(([, rule]) => rule !== 'riverwright-credential');
  assert.deepEqual(wrong, []);
});

test('R26: the word after riverwright decides; known non-executing tools and plain words are allowed', () => {
  const wrong = [...ALLOWED_R26, ...NOT_A_WAY].map((c) => [c, classifyCommand(c)]).filter(([, v]) => v.outward !== false).map(([c, v]) => [c, v.rule]);
  assert.deepEqual(wrong, []);
});

// N3: the rule does no brace or glob expansion, so a large or deeply nested command is cheap to check.
const WORST = (() => {
  const n = 60000;
  const nest = `${'{'.repeat(n)}${'}'.repeat(n)}`;
  return {
    'nested braces, echo': `echo ${nest}`,
    'nested braces, rw argument': `rw ${nest}`,
    'nested braces in three quoting levels, then rw credential': `echo "a 'b \\"${nest} c\\"'"; rw credential remove`,
    'comma nesting': `echo ${'{a,'.repeat(40000)}b${'}'.repeat(40000)}`,
    'sequence groups': `git commit -m '${'{a..b}'.repeat(40000)}'`,
    'many rw words, no trigger': 'rw '.repeat(80000),
    'many glob stars for a variable program': `$X ${'*'.repeat(120000)}z`,
    'many glob stars and letters': `$X ${'*e'.repeat(60000)}z`,
    'long word': `rw ${'a'.repeat(250000)}`,
    'many brackets': `$X ${'['.repeat(120000)}]`,
    'many path words before a variable': `xvfb-run ${'/a/b $X '.repeat(30000)}`,
    'one very deep path before credential': `xvfb-run ${'/a'.repeat(100000)} credential`,
    'many distinct path words before credential': `xvfb-run ${Array.from({ length: 12000 }, (_, i) => `/a/${i} credential`).join(' ')}`,
    'many quoted payloads': `xvfb-run ${'"rw state" '.repeat(20000)}`,
  };
})();

test('N3: a worst-case 256 KB command is classified in under a second', () => {
  for (const [label, c] of Object.entries(WORST)) {
    assert.ok(c.length <= 256 * 1024, label);
    for (const platform of ['darwin', 'win32']) {
      const cmd = platform === 'win32' ? `${c.slice(0, 256 * 1024 - 4)} \\x` : c;
      const t0 = performance.now();
      classifyCommand(cmd, { platform });
      const ms = performance.now() - t0;
      assert.ok(ms < 1000, `${label} (${platform}) took ${ms.toFixed(0)} ms`);
    }
  }
});

test('a command longer than the classifier reads is denied when it names riverwright or credential', () => {
  const pad = 'x'.repeat(300 * 1024);
  assert.equal(classifyCommand(`echo ${pad}; rw $C remove`).rule, 'riverwright-credential');
  assert.equal(classifyCommand(`echo ${pad}; rw credential remove`).rule, 'riverwright-credential');
  assert.notEqual(classifyCommand(`echo ${pad}`).rule, 'riverwright-credential');
});

test('N3: input shaped to overflow the stack never throws, and the verdict is the same every time', () => {
  const shapes = [
    `git commit -m '${'{a..b}'.repeat(20000)}'`,
    `echo ${'{'.repeat(20000)}a${',b}'.repeat(20000)}`,
    `rw ${'{'.repeat(20000)}a${',b}'.repeat(20000)}`,
    `echo ${'$('.repeat(40000)}x${')'.repeat(40000)}`,
    `${'('.repeat(40000)}x${')'.repeat(40000)}`,
  ];
  for (const c of shapes) {
    const a = classifyCommand(c);
    assert.equal(typeof a.outward, 'boolean');
    assert.deepEqual(classifyCommand(c), a);
  }
  // A commit message full of brace sequences is not a riverwright command.
  assert.equal(classifyCommand(shapes[0]).outward, false);
});

test('other riverwright commands and unrelated uses of the word are not blocked by that rule', () => {
  for (const c of [...ALLOWED, ...ALLOWED_I1]) assert.equal(classifyCommand(c).outward, false, c);
  for (const c of ['C:\\Users\\me\\rw\\notes.txt', 'type C:\\rw\\bin\\rw.cmd']) assert.equal(classifyCommand(c, { platform: 'win32' }).outward, false, c);
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
  // R26: any word of a command that is not a known non-executing tool, so a launcher the classifier does not model
  // cannot hide the symlink.
  for (const c of [`script -q /dev/null ${dir}/x credential setup`, `xvfb-run ${dir}/y $SUB`, `faketime now node ${dir}/a.mjs credential`]) {
    assert.equal(classifyCommand(c).rule, 'riverwright-credential', c);
  }
  assert.equal(classifyCommand(`xvfb-run ${dir}/x state get`).outward, false);
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
    for (const c of ['rw credential status', 'rw credential remove', 'rw credential setup --replace', 'RIVERWRIGHT_HOME=/x rw credential setup', 'echo credential remove | xargs rw', 'rw {,credential} remove', 'rw $SUB', '$(echo rw) credential setup', 'npx riverwright@latest credential setup',
      // N1 and N2: behind a launcher the classifier does not model, or as literal text inside another command.
      'C=credential; script -q /dev/null rw "$C" setup --replace', "git -c alias.x='!rw credential setup --replace' x", 'ssh -o ProxyCommand="rw credential setup" localhost true', 'x="rw credential setup"; $x', 'F="rw credential setup"; eval "$F"']) {
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

test('I1: a plain word "rw" with nothing dynamic after it is allowed outside the workspace while a run is active', async () => {
  for (const c of ['grep -n rw file.txt', 'mount -o rw /dev/x /mnt', 'docker run -v "$PWD":/w:rw img']) {
    const r = await callMain(['hook', 'claude-code', '--home', home], { stdin: hookPayload(c, outside), env: {}, cwd: outside });
    assert.equal(r.code, 0, c);
  }
});

test('R26: a plain word "rw" followed by a variable is allowed outside the workspace, with or without a run', async () => {
  for (const h of [home, idleHome]) {
    for (const c of ['grep -n rw "$FILE"', 'rw --home="$H" state get', 'riverwright ledger verify --run "$RUN"']) {
      const r = await callMain(['hook', 'claude-code', '--home', h], { stdin: hookPayload(c, outside), env: {}, cwd: outside });
      assert.equal(r.code, 0, c);
    }
  }
});

test('N3: a command shaped to overflow the stack gets a JSON decision from the hook, never a crash', async () => {
  for (const c of [`git commit -m '${'{a..b}'.repeat(20000)}'`, `echo ${'{'.repeat(20000)}a${',b}'.repeat(20000)}`]) {
    const r = await callMain(['hook', 'claude-code', '--home', home], { stdin: hookPayload(c, outside), env: {}, cwd: outside });
    assert.equal(r.code, 0, c.slice(0, 40));
    assert.equal(r.stderr, '');
  }
});

test('other riverwright commands outside the workspace are still allowed', async () => {
  for (const c of ['rw version', 'riverwright ledger verify --run /abs/run', 'riverwright --home /abs/h state get']) {
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
