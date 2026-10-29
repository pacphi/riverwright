import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { callMain, tmpDir, ROOT, RIVERWRIGHT } from './helpers.mjs';
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

// Fix round 4 (R27, R28). R28: a variable, glob or brace word is a possible riverwright program only where a program
// stands: in program position (after the modelled wrappers), as the program an exec wrapper runs (script, xvfb-run,
// sudo, xargs, ...), as the script a JavaScript runtime runs, or as the package a runner (npx, pnpm dlx) runs. A
// literal riverwright word anywhere still has its slot checked.
const DENIED_R28 = [
  'script -q /dev/null $X credential',
  'sudo $X credential',
  '$X credential',
  'xargs $X credential',
  'timeout 5 "$X" "$C"',
  'rlwrap "$X" credential',
  'gdb --args "$X" credential',
  'node $S credential setup',
  'node --no-warnings "$S" credential setup',
  'bun "$S" credential',
  'npx $P credential',
  'pnpm dlx "$P" credential setup',
  'npm exec -- "$P" credential setup',
  'echo $X credential | sh',
  'foo rw "$C"',
  'make "$D/rw" credential',
  'git bisect run $X credential',
  "git rebase -x '$X credential' HEAD~1",
  // ssh runs its command options and the remote command line through a shell.
  'ssh -o ProxyCommand="$X credential" host',
  'ssh host "$X" credential',
  'ssh host "$A" "$B"',
];
const ALLOWED_R28 = [
  'rm "$A" "$B"',
  'rsync -a "$SRC" "$DST"',
  'node build.js "$IN" "$OUT"',
  'cp "$X" "$Y"',
  'rm -rf "$TMP" "$OUT"',
  'tar -czf "$OUT" "$DIR"',
  'sudo rm "$A" "$B"',
  'npx prettier --write "$A" "$B"',
  'git mv "$OLD" "$NEW"',
  'git checkout "$BR" -- "$F"',
  'git fetch origin "$A" "$B"',
  'make "$A" "$B"',
  'rg rw "$FILE"',
  'rg -n riverwright "$DIR"',
];
// R27: git is non-executing only for status, log, show, diff, add, commit, branch, rev-parse, ls-files, blame, describe
// and tag listing, with no -c, no command-running option and no alias of that name in a git config the hook reads.
const DENIED_R27 = [
  "git fetch --upload-pack='rw credential setup' origin",
  "git ls-remote -u 'rw credential setup' origin",
  "git archive --exec='rw credential setup' --remote=x HEAD",
  "git grep --open-files-in-pager='rw credential setup' x",
  "git grep -O'rw credential setup' x",
  "git clone --upload-pack 'rw credential setup' x y",
  'git -c x.y=z log rw credential',
  'git --git-dir=/x/.git status rw credential',
  'GIT_CONFIG_GLOBAL=/tmp/g git status rw credential',
  'git log --ext-diff rw "$C"',
  // rg runs --pre and --hostname-bin programs, and reads more options from RIPGREP_CONFIG_PATH.
  'RIPGREP_CONFIG_PATH=/tmp/rc rg x rw "$C"',
  'rg --hostname-bin=x rw "$C"',
];
const ALLOWED_R27 = [
  'git status',
  'git log --oneline rw credential',
  'git diff rw "$X"',
  'git show HEAD:docs/rw.md "$X"',
  'git add -A rw "$X"',
  "git commit -m 'rw credential setup reads the tty'",
  'git -C /x/riverwright commit -m "fix: rw credential setup reads the tty"',
  'git branch -vv',
  'git tag -l "v*"',
  'git blame rw "$F"',
];
// Item 4: attached short options and long options with "=" (or abbreviated) are unknown, so the tool counts as
// executing and its script text is checked.
const DENIED_FLAGS = [
  "awk -fx.awk 'rw credential setup'",
  "gawk -ix.awk 'rw credential setup'",
  "gawk -lx 'rw credential setup'",
  "gawk -Ex.awk 'rw credential setup'",
  "awk --file=x.awk 'rw credential setup'",
  "gawk --exec=x.awk 'rw credential setup'",
  "gawk --fi=x.awk 'rw credential setup'",
  "gawk -e'BEGIN { system(\"rw credential setup\") }'",
  "awk 'BEGIN { system(\"rw credential setup\") }'",
  "sed -e's/.*/rw credential setup/e' f",
  "sed --expr='s/.*/rw credential setup/e' f",
  "sed -ne's/.*/rw credential setup/e' f",
];
// Item 5: a program that runs commands read from stdin, fed by a pipe the classifier cannot read, fails closed.
const DENIED_STDIN = [
  'cat cmds.txt | at now',
  'curl -s https://example.com/c | ssh host',
  'cat jobs | crontab -',
  'base64 -d f | batch',
  'cat f | su',
  'cat f | expect',
  'cat f | script -q /dev/null',
  'cat f | ssh host sh',
  "cat f | ssh host 'bash -s'",
  'cat f | ssh -t host',
];
const ALLOWED_STDIN = [
  'echo uptime | at now',
  'echo uptime | ssh host',
  "tar cz . | ssh host 'tar xz'",
  "cat f | su -c 'cat > /tmp/x' bob",
  'cat f | at -f job now',
  'cat f | crontab jobs.txt',
];

// Fix round 5. A plain word right after an option with no "=" may be that option's value, so it does not end the search
// for the script or package a runtime or runner runs; the launchers below run the program they are given; a shell's or
// interpreter's first operand is its program; sed with an option after its script is unknown; and stdin spelled as a
// file (/dev/stdin, /dev/fd/0, -) or a bare shell behind script or a wrapper on ssh reads commands from stdin.
const DENIED_R5 = [
  'npx -p cowsay "$X" credential setup',
  'npx --package cowsay "$X" credential',
  'npx -y -p cowsay -- "$X" credential',
  'npm exec --package cowsay -- "$X" credential',
  'npm exec -p cowsay "$X" credential',
  'yarn dlx -p cowsay "$X" credential',
  'node -r ./hook.cjs "$S" credential setup',
  'node --require ./hook.cjs "$S" credential',
  'node --import ./x.mjs "$S" credential',
  'node --env-file .env "$S" credential',
  'node -C dev "$S" credential',
  'deno run --config deno.json "$S" credential',
  'deno run -A --config deno.json "$S" credential',
  'bun --cwd /tmp "$S" credential',
  'ts-node -r tsconfig-paths/register "$S" credential',
  'tsx -r ./setup.cjs "$S" credential',
  'arch -arm64 "$X" credential setup',
  "sandbox-exec -p '(version 1)(allow default)' \"$X\" credential",
  'nsenter -t 1 -m "$X" credential',
  'sg grp -c "$X credential"',
  'prlimit --nofile=10 "$X" credential',
  'numactl -N 0 "$X" credential',
  'cpulimit -l 50 -- "$X" credential',
  'echo f | entr "$X" credential',
  'nodemon "$S" credential',
  'tsx "$S" credential',
  'ts-node "$S" credential',
  'deno "$S" credential',
  'uv run "$X" credential',
  'poetry run "$X" credential',
  'bundle exec "$X" credential',
  'yarn "$X" credential',
  'yarn run "$X" credential',
  'pnpm "$X" credential',
  'mise exec -- "$X" credential',
  'mise x -- "$X" credential',
  'op run -- "$X" credential',
  'doppler run -- "$X" credential',
  'direnv exec . "$X" credential',
  'dotenv -- "$X" credential',
  'cross-env A=1 "$X" credential',
  'bash "$S" credential',
  'sh -e "$S" credential setup',
  'bash -o pipefail "$S" credential',
  'python "$S" credential',
  'python3 -u "$S" credential',
  'ruby "$S" credential',
  "sed s/a/b/ -e '1e rw credential setup' f",
  "sed -n p f -e 'e rw credential setup'",
  "sed -e s/a/b/ f -e '1e rw credential setup'",
  "sed s/a/b/ --expression='1e rw credential setup' f",
  'cat f | at -f /dev/stdin now',
  'cat f | batch -f /dev/fd/0',
  'cat f | crontab /dev/stdin',
  'cat f | expect -f -',
  'cat f | expect /dev/fd/0',
  'cat f | script -q /dev/null bash',
  'cat f | script -q /dev/null sh -s',
  'cat f | ssh host sudo bash',
  'cat f | ssh host nice -n 5 sh -s',
  'echo rw credential setup | bash /dev/stdin',
];
const ALLOWED_R5 = [
  'npx tsc -p "$DIR"',
  'npx vitest run "$A" "$B"',
  'npx -y prettier --write "$A" "$B"',
  'node build.js "$IN" "$OUT"',
  'node --no-warnings build.js "$IN" "$OUT"',
  'node --test x.mjs "$A" "$B"',
  'bash scripts/test.sh "$A" "$B"',
  'bash -x scripts/test.sh "$A" "$B"',
  'python3 -u tool.py "$A" "$B"',
  'python -m pytest "$A" "$B"',
  'yarn test "$A" "$B"',
  'pnpm test -- "$A" "$B"',
  'deno task build "$A" "$B"',
  'uv pip install "$A" "$B"',
  'op item get "$A" "$B"',
  'bun run build "$A" "$B"',
  'pnpm -r build "$A" "$B"',
  "sed -i.bak 's/a/b/' rw",
  'sed -n "${A},${B}p" "$F"',
  "cat f | script -q /dev/null bash -c 'echo hi'",
  "tar cz . | ssh host 'tar xz'",
  'echo uptime | at -f /dev/stdin now',
];

// The list tests read no real git config: a scratch working directory and HOME, and no system config.
const hermeticDir = tmpDir('rw-hermetic-');
const HERMETIC = { cwd: hermeticDir, env: { HOME: hermeticDir, GIT_CONFIG_NOSYSTEM: '1' } };
const classify = (c, o = {}) => classifyCommand(c, { ...HERMETIC, ...o });

test('the hook denies an agent shell command that runs riverwright credential in any spelling', () => {
  const missed = [...DENIED, ...DENIED_R24, ...DENIED_R25, ...DENIED_R26, ...DENIED_R28].filter((c) => classify(c).outward !== true);
  assert.deepEqual(missed, []);
});

test('every denied spelling is denied by the riverwright-credential rule itself (so it applies everywhere)', () => {
  const wrong = [...DENIED, ...DENIED_R24, ...DENIED_R25, ...DENIED_R26, ...DENIED_R28].map((c) => [c, classify(c).rule]).filter(([, rule]) => rule !== 'riverwright-credential');
  assert.deepEqual(wrong, []);
});

test('R26: xargs feeding riverwright and a quoted riverwright command in gh stay denied (accepted cost)', () => {
  const wrong = DENIED_COST_R26.map((c) => [c, classify(c).rule]).filter(([, rule]) => rule !== 'riverwright-credential');
  assert.deepEqual(wrong, []);
});

test('R26: the word after riverwright decides; known non-executing tools and plain words are allowed', () => {
  const wrong = [...ALLOWED_R26, ...NOT_A_WAY].map((c) => [c, classify(c)]).filter(([, v]) => v.outward !== false).map(([c, v]) => [c, v.rule]);
  assert.deepEqual(wrong, []);
});

test('R28: a variable in an ordinary argument of an unknown program is not a program', () => {
  const wrong = ALLOWED_R28.map((c) => [c, classify(c)]).filter(([, v]) => v.rule === 'riverwright-credential').map(([c]) => c);
  assert.deepEqual(wrong, []);
});

test('R27: git counts as non-executing only for an allowlisted subcommand with no command-running option', () => {
  const missed = DENIED_R27.map((c) => [c, classify(c).rule]).filter(([, rule]) => rule !== 'riverwright-credential');
  assert.deepEqual(missed, []);
  const wrong = ALLOWED_R27.map((c) => [c, classify(c)]).filter(([, v]) => v.rule === 'riverwright-credential').map(([c]) => c);
  assert.deepEqual(wrong, []);
});

test('R27: an alias named like an allowlisted git subcommand, in any git config the hook reads, makes git unknown', () => {
  const cmd = 'git status rw credential';
  assert.equal(classify(cmd).outward, false);
  // The repository's own config, found from the working directory (and from -C).
  const repo = tmpDir('rw-git-repo-');
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n[alias]\n\tstatus = !sh -c \'"$@"\' x\n');
  assert.equal(classify(cmd, { cwd: repo }).rule, 'riverwright-credential');
  // Forward slashes, so the path reads the same on Windows (where the lexer treats a backslash as an escape).
  assert.equal(classify(`git -C ${repo.split(path.sep).join('/')} status rw credential`).rule, 'riverwright-credential');
  fs.mkdirSync(path.join(repo, 'sub'));
  assert.equal(classify(cmd, { cwd: path.join(repo, 'sub') }).rule, 'riverwright-credential');
  // A linked worktree: .git is a file naming the git directory; the shared config is in its commondir.
  const common = tmpDir('rw-git-common-');
  fs.mkdirSync(path.join(common, 'worktrees', 'w'), { recursive: true });
  fs.writeFileSync(path.join(common, 'config'), '[Alias]\n\tLog = !x\n');
  fs.writeFileSync(path.join(common, 'worktrees', 'w', 'commondir'), '../..\n');
  const wt = tmpDir('rw-git-wt-');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(common, 'worktrees', 'w')}\n`);
  assert.equal(classify('git log rw credential', { cwd: wt }).rule, 'riverwright-credential');
  // The user's global config (HOME, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL), an include, and GIT_CONFIG_COUNT.
  const h = tmpDir('rw-git-home-');
  fs.writeFileSync(path.join(h, '.gitconfig'), '[alias]\n  diff = !x\n');
  assert.equal(classify('git diff rw credential', { env: { HOME: h, GIT_CONFIG_NOSYSTEM: '1' } }).rule, 'riverwright-credential');
  fs.mkdirSync(path.join(h, 'xdg', 'git'), { recursive: true });
  fs.writeFileSync(path.join(h, 'xdg', 'git', 'config'), '[alias "x"]\n[alias]\n  show = !x\n');
  assert.equal(classify('git show rw credential', { env: { HOME: hermeticDir, XDG_CONFIG_HOME: path.join(h, 'xdg'), GIT_CONFIG_NOSYSTEM: '1' } }).rule, 'riverwright-credential');
  fs.writeFileSync(path.join(h, 'main.gitconfig'), '[include]\n\tpath = more.gitconfig\n');
  fs.writeFileSync(path.join(h, 'more.gitconfig'), '[alias]\n\tblame = !x\n');
  assert.equal(classify('git blame rw credential', { env: { HOME: hermeticDir, GIT_CONFIG_GLOBAL: path.join(h, 'main.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } }).rule, 'riverwright-credential');
  assert.equal(classify('git add rw credential', { env: { ...HERMETIC.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'alias.add', GIT_CONFIG_VALUE_0: '!x' } }).rule, 'riverwright-credential');
  // The same commands with no alias anywhere are allowed.
  for (const c of ['git log rw credential', 'git diff rw credential', 'git show rw credential', 'git blame rw credential', 'git add rw credential']) assert.equal(classify(c).outward, false, c);
});

test('item 4: an attached short option or a long option with "=" is unknown, so the tool counts as executing', () => {
  const missed = DENIED_FLAGS.map((c) => [c, classify(c).rule]).filter(([, rule]) => rule !== 'riverwright-credential');
  assert.deepEqual(missed, []);
  for (const c of ["awk -F: '{ print $1 }' rw", "sed -i.bak 's/a/b/' rw", "sed -n 's/rw/x/p' f", "awk -v x=1 '{ print }' rw"]) assert.equal(classify(c).outward, false, c);
});

test('item 5: a program that runs commands from stdin, fed by a pipe the classifier cannot read, is denied', () => {
  const missed = DENIED_STDIN.map((c) => [c, classify(c).rule]).filter(([, rule]) => rule !== 'riverwright-credential');
  assert.deepEqual(missed, []);
  const wrong = ALLOWED_STDIN.map((c) => [c, classify(c)]).filter(([, v]) => v.rule === 'riverwright-credential').map(([c]) => c);
  assert.deepEqual(wrong, []);
});

test('round 5: option values, more launchers, shell and interpreter operands, sed options and stdin spellings', () => {
  const missed = DENIED_R5.map((c) => [c, classify(c).rule]).filter(([, rule]) => rule !== 'riverwright-credential');
  assert.deepEqual(missed, []);
  const wrong = ALLOWED_R5.map((c) => [c, classify(c)]).filter(([, v]) => v.rule === 'riverwright-credential').map(([c]) => c);
  assert.deepEqual(wrong, []);
  // A shell reading an unreadable pipe through /dev/stdin is the same as one reading the pipe directly.
  assert.equal(classify('cat f | sh /dev/stdin').rule, classify('cat f | sh').rule);
});

// NEW-1: the files the git alias check reads (.git, commondir, config files and their includes) are read only when
// they are regular files of a bounded size. A FIFO, a device, a directory or an oversized file is unreadable, so git
// is not trusted (the check fails closed) and the hook never waits on it.
const gitRepo = (configText = '[core]\n\tbare = false\n') => {
  const repo = tmpDir('rw-git-odd-');
  fs.mkdirSync(path.join(repo, '.git'));
  fs.writeFileSync(path.join(repo, '.git', 'config'), configText);
  return repo;
};
const fwd = (p) => p.split(path.sep).join('/');

test('NEW-1: an oversized or non-regular git file makes git unknown instead of being read', () => {
  const plain = gitRepo();
  assert.equal(classify(`git -C ${fwd(plain)} log rw credential`).outward, false);
  const big = gitRepo(`[core]\n${'\t# padding\n'.repeat(110000)}`);
  assert.equal(classify(`git -C ${fwd(big)} log rw credential`).rule, 'riverwright-credential');
  const dirConfig = tmpDir('rw-git-odd-');
  fs.mkdirSync(path.join(dirConfig, '.git', 'config'), { recursive: true });
  assert.equal(classify(`git -C ${fwd(dirConfig)} log rw credential`).rule, 'riverwright-credential');
  const dirCommon = gitRepo();
  fs.mkdirSync(path.join(dirCommon, '.git', 'commondir'));
  assert.equal(classify(`git -C ${fwd(dirCommon)} log rw credential`).rule, 'riverwright-credential');
});

test('NEW-1: a FIFO or device at a git file the hook reads never hangs the real hook', posixOnly, () => {
  const fifoCommon = gitRepo();
  assert.equal(spawnSync('mkfifo', [path.join(fifoCommon, '.git', 'commondir')]).status, 0);
  const fifoConfig = tmpDir('rw-git-odd-');
  fs.mkdirSync(path.join(fifoConfig, '.git'));
  assert.equal(spawnSync('mkfifo', [path.join(fifoConfig, '.git', 'config')]).status, 0);
  const zeroCommon = gitRepo();
  fs.symlinkSync('/dev/zero', path.join(zeroCommon, '.git', 'commondir'));
  const zeroConfig = tmpDir('rw-git-odd-');
  fs.mkdirSync(path.join(zeroConfig, '.git'));
  fs.symlinkSync('/dev/zero', path.join(zeroConfig, '.git', 'config'));
  const fifoHome = tmpDir('rw-git-home-');
  assert.equal(spawnSync('mkfifo', [path.join(fifoHome, '.gitconfig')]).status, 0);
  const hookHome = tmpDir('riverwright-home-');
  fs.mkdirSync(path.join(hookHome, 'o', 'r', 'worktrees'), { recursive: true });
  const cases = [];
  for (const repo of [fifoCommon, fifoConfig, zeroCommon, zeroConfig]) {
    cases.push([`git -C ${repo} status`, 0, HERMETIC.env]);
    cases.push([`git -C ${repo} status; rw credential setup`, 2, HERMETIC.env]);
    cases.push([`git -C ${repo} log rw credential`, 2, HERMETIC.env]);
  }
  cases.push(['git log rw credential', 2, { HOME: fifoHome, GIT_CONFIG_NOSYSTEM: '1' }]);
  for (const [command, code, env] of cases) {
    const r = spawnSync(process.execPath, [RIVERWRIGHT, 'hook', 'claude-code', '--home', hookHome], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: hermeticDir }),
      env: { PATH: process.env.PATH, ...env }, cwd: hermeticDir, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(r.error?.code, undefined, `${command}: the hook did not return`);
    assert.equal(r.status, code, command);
    if (code === 2) assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /riverwright-credential/, command);
    // The classifier itself answers well inside a second.
    const t0 = performance.now();
    classifyCommand(command, { cwd: hermeticDir, env });
    assert.ok(performance.now() - t0 < 1000, command);
  }
});

// NEW-2: past the work budget, nested text that runs riverwright with a variable or "credential" is denied.
test('NEW-2: a nested payload after a prefix that uses up the work budget is still denied', () => {
  const nest = (core) => { let s = core; for (let i = 0; i < 8; i += 1) s = `sh -c ${JSON.stringify(s)}`; return s; };
  const prefix = nest('x '.repeat(25000));
  assert.ok(prefix.length < 64 * 1024);
  assert.notEqual(classify(prefix).rule, 'riverwright-credential');
  const tail = "; C=$(printf cred)ential bash -c 'rw \"$C\" setup --replace'";
  assert.equal(classify(tail.slice(2)).rule, 'riverwright-credential');
  assert.equal(classify(prefix + tail).rule, 'riverwright-credential');
  assert.equal(classify(`${prefix}; bash -c 'rw credential setup'`).rule, 'riverwright-credential');
});

// NEW-5: the user and system git configs are read once per command, not once per directory.
test('NEW-5: the shared git config is read once per classified command', () => {
  const h = tmpDir('rw-git-home-');
  const config = path.join(h, '.gitconfig');
  fs.writeFileSync(config, '[alias]\n\tlg = log --oneline\n');
  const dirs = Array.from({ length: 20 }, () => fwd(tmpDir('rw-git-dir-')));
  const touches = (command) => {
    let n = 0;
    const saved = {};
    for (const name of ['statSync', 'lstatSync', 'openSync', 'readFileSync']) {
      saved[name] = fs[name];
      fs[name] = function counted(p, ...rest) { if (String(p) === config) n += 1; return saved[name].call(this, p, ...rest); };
    }
    try {
      classify(command, { env: { HOME: h, GIT_CONFIG_NOSYSTEM: '1' } });
    } finally {
      Object.assign(fs, saved);
    }
    return n;
  };
  const one = touches(`git -C ${dirs[0]} status`);
  assert.ok(one > 0);
  assert.equal(touches(dirs.map((d) => `git -C ${d} status`).join('; ')), one);
});

test('item 3: a path-shaped program word is checked against the launcher before any list trusts its name', posixOnly, () => {
  const dir = tmpDir('rw-named-links-');
  for (const name of ['grep', 'sudo', 'cp', 'git', 'nice', 'env']) fs.symlinkSync(path.join(ROOT, 'bin', 'riverwright'), path.join(dir, name));
  for (const name of ['grep', 'sudo', 'cp', 'git', 'nice', 'env']) {
    assert.equal(classify(`${dir}/${name} credential setup`).rule, 'riverwright-credential', name);
    assert.equal(classify(`${dir}/${name} "$SUB"`).rule, 'riverwright-credential', name);
    assert.equal(classify(`./${name} credential setup`, { cwd: dir }).rule, 'riverwright-credential', name);
    assert.equal(classify(`sudo ${dir}/${name} credential setup`).rule, 'riverwright-credential', name);
  }
  assert.equal(classify(`${dir}/grep state get`).outward, false);
  // The real tools of those names stay what they are.
  assert.equal(classify('/usr/bin/grep rw "$X"').outward, false);
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

test('N3: a worst-case 256 KB command is classified in under three seconds (linear, not quadratic)', () => {
  for (const [label, c] of Object.entries(WORST)) {
    assert.ok(c.length <= 256 * 1024, label);
    for (const platform of ['darwin', 'win32']) {
      const cmd = platform === 'win32' ? `${c.slice(0, 256 * 1024 - 4)} \\x` : c;
      const t0 = performance.now();
      classify(cmd, { platform });
      const ms = performance.now() - t0;
      assert.ok(ms < 3000, `${label} (${platform}) took ${ms.toFixed(0)} ms`);
    }
  }
});

test('a command longer than the classifier reads is denied when it names riverwright or credential', () => {
  const pad = 'x'.repeat(300 * 1024);
  assert.equal(classify(`echo ${pad}; rw $C remove`).rule, 'riverwright-credential');
  assert.equal(classify(`echo ${pad}; rw credential remove`).rule, 'riverwright-credential');
  assert.notEqual(classify(`echo ${pad}`).rule, 'riverwright-credential');
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
    const a = classify(c);
    assert.equal(typeof a.outward, 'boolean');
    assert.deepEqual(classify(c), a);
  }
  // A commit message full of brace sequences is not a riverwright command.
  assert.equal(classify(shapes[0]).outward, false);
});

test('other riverwright commands and unrelated uses of the word are not blocked by that rule', () => {
  for (const c of [...ALLOWED, ...ALLOWED_I1]) assert.equal(classify(c).outward, false, c);
  for (const c of ['C:\\Users\\me\\rw\\notes.txt', 'type C:\\rw\\bin\\rw.cmd']) assert.equal(classify(c, { platform: 'win32' }).outward, false, c);
});

test('a symlink to the launcher or its script, by any name, is the launcher', posixOnly, () => {
  const dir = tmpDir('rw-links-');
  const links = { x: path.join(ROOT, 'bin', 'riverwright'), y: path.join(ROOT, 'bin', 'rw'), 'a.mjs': path.join(ROOT, 'scripts', 'riverwright.mjs'), 'b.mjs': path.join(ROOT, 'scripts', 'lib', 'cli.mjs') };
  for (const [name, target] of Object.entries(links)) fs.symlinkSync(target, path.join(dir, name));
  for (const c of [`${dir}/x credential setup`, `${dir}/y credential remove`, `node ${dir}/a.mjs credential setup`, `node ${dir}/b.mjs credential setup`, `sudo ${dir}/x credential setup`]) {
    assert.equal(classify(c).rule, 'riverwright-credential', c);
  }
  // A relative path is resolved against the command's working directory.
  assert.equal(classify('./x credential setup', { cwd: dir }).rule, 'riverwright-credential');
  assert.equal(classify('node a.mjs credential setup', { cwd: dir }).rule, 'riverwright-credential');
  // The symlinked launcher running something else is not blocked.
  assert.equal(classify(`${dir}/x ledger verify --run /tmp/r`).outward, false);
  // A program word that resolves to the launcher has its subcommand checked: a variable could be "credential".
  assert.equal(classify(`${dir}/x $SUB`).rule, 'riverwright-credential');
  // R26: any word of a command that is not a known non-executing tool, so a launcher the classifier does not model
  // cannot hide the symlink.
  for (const c of [`script -q /dev/null ${dir}/x credential setup`, `xvfb-run ${dir}/y $SUB`, `faketime now node ${dir}/a.mjs credential`]) {
    assert.equal(classify(c).rule, 'riverwright-credential', c);
  }
  assert.equal(classify(`xvfb-run ${dir}/x state get`).outward, false);
});

test('a command nested too deeply to read that mentions credential is denied by the credential rule', () => {
  let c = 'rw credential setup';
  for (let k = 0; k < 12; k += 1) c = `sh -c ${JSON.stringify(c)}`;
  assert.equal(classify(c).rule, 'riverwright-credential');
});

test('on Windows a backslash path to the launcher is read as a path', () => {
  for (const c of ['C:\\tools\\riverwright\\bin\\riverwright.cmd credential setup', '"C:\\Program Files\\rw\\bin\\rw.cmd" credential remove', 'node C:\\rw\\scripts\\riverwright.mjs credential setup']) {
    assert.equal(classify(c, { platform: 'win32' }).rule, 'riverwright-credential', c);
  }
  assert.equal(classify('C:\\rw\\bin\\riverwright.cmd ledger verify', { platform: 'win32' }).outward, false);
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
