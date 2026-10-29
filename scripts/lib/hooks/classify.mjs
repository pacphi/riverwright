import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realish } from '../paths.mjs';
import { readBounded } from '../fsx.mjs';
import { lex, isDynamic, hasUnresolved, unCaret, readingsOf } from './shell.mjs';
import { outward, unresolvable, nameOf, codeLooksOutward, classifyGh, classifyHttp } from './github.mjs';

export { hasUnresolved };

// Conservative: anything that could publish, rewrite remotes, or bypass git hooks counts as outward.
// A false alarm blocks one command inside the workspace; a miss could publish without approval.
// Anything the classifier cannot fully resolve (a variable or substitution as the program or git/gh
// subcommand, eval, a shell reading code from a pipe) is outward with rule "unresolvable".
//
// The riverwright-credential rule (an agent running "riverwright credential") applies everywhere, not only
// in the workspace, and outranks every other rule in the same command (R23).
// Threat model (ADR-0010): the credential command needs a terminal (setup reads the token and passphrase, remove asks
// for typed confirmation), so the harm this rule guards against is an agent driving it by accident or because an
// injected instruction told it to (for example `setup --replace` with a passphrase the agent chose). It does not stop
// a determined forger running as the same user, who can reach the vault file without this command at all. The
// passphrase, typed by the human in their own terminal, is the protection; this rule is a guard rail, so it is kept
// from blocking ordinary agent work.
// It is the subcommand-slot rule (R26): the CLI dispatches on its first argument alone, so riverwright runs the
// credential command only when the word right after the program is "credential". Every word is read the way the shell
// decodes it first (quotes, backslash escapes, ANSI-C $'..' with \x, \u and octal, line continuations including
// CRLF). A NUL is read every way a shell can pass it on: bash cuts the $'..' segment at it, zsh and execve cut the
// whole word at it, and a raw NUL may be dropped (C1). Then, for each word that is or could be riverwright, the next word is denied when it is, could be, or could
// vanish into "credential": a variable or substitution with no literal text that rules it out (--run="$RUN" cannot be
// "credential"; "$X" can), a glob that matches it, any brace or extglob, %NAME%, a PowerShell splat or comma list, a
// parenthesised argument (fish, PowerShell), or a "--" or glob that may vanish ahead of it. After a literal riverwright
// program only its own slot counts: its other arguments are riverwright's.
//   - What counts as riverwright (R28). A literal word, anywhere: rw/riverwright as the name or last path component
//     (with .cmd/.mjs/.exe and the like), cli.mjs or credential.mjs, a package such as riverwright@latest or
//     npm:riverwright, the value of KEY=VALUE or a "!" alias, or a path whose realpath is one of the launcher files.
//     A variable, substitution, glob or brace that could produce one counts only where a program stands: in program
//     position (after env, sudo, nice, nohup, timeout, time, command, exec and the other modelled wrappers), anywhere
//     in the arguments of an exec wrapper (script, xvfb-run, rlwrap, firejail, gdb, chroot, pkexec, runuser,
//     systemd-run, faketime, winpty, valgrind, unshare, chrt, taskset, watch, flock, xargs, parallel, arch,
//     sandbox-exec, nsenter, sg, prlimit, numactl, cpulimit, entr, direnv, dotenv, cross-env, ...), of a git
//     subcommand that runs commands, or of text about to be run (a pipe into a shell), as the script of node, bun,
//     tsx, ts-node or nodemon, as the first operand of a shell or interpreter (bash "$S", python "$S"), as the
//     package or program of npx, uvx, pnpm dlx, npm exec, yarn, pnpm, deno, uv run, poetry run, bundle exec, mise exec,
//     op run, doppler run and the other runners. A plain word right after an option that may take a value (npx -p
//     cowsay, node -r ./h.cjs, deno run --config f) may be that value, so the search for the operand goes on past it.
//     It is never one in an ordinary argument of an unknown program, so rm "$A" "$B" and node build.js "$IN" "$OUT"
//     are allowed.
//   - node, bun and deno running riverwright from stdin (node - ... < riverwright.mjs, cat riverwright.mjs | node -) or
//     preloading it (--import, --require, -r, --loader, --experimental-loader, --preload, or the same in NODE_OPTIONS)
//     shift its arguments: every word after the script operand is then a slot (F1).
//   - A path-shaped program word is resolved against the launcher files before any list trusts its name (a link
//     named grep or sudo to the launcher is riverwright), and a path with a variable directory is not trusted at all.
//     A relative path is resolved against every directory the command may be in (its own cd, pushd, chdir and
//     Set-Location, in a subshell too, and CDPATH), "~" against the account home (password database) and HOME, and a
//     glob or brace in the last segment counts when that directory holds a launcher link (F2).
//   - Known non-executing tools: the arguments of grep, egrep, fgrep, echo, printf, cat, head, tail, wc, sort, uniq,
//     diff, cmp, ls, stat, file, mount, umount, chmod, chown, cp, mv, ln, mkdir, rmdir, touch, cut, tr, curl, wget,
//     jq, rg (no --pre, --hostname-bin or RIPGREP_CONFIG_PATH), sed (no e/w/W, no -f), awk (no system() or pipe, no
//     -f/-i/-l/-E), find (no -exec/-execdir/-ok/-okdir) are not read as programs, and their quoted arguments are not
//     read as commands. An option the check cannot place (an attached -fX, -iX, -lX, -EX, an abbreviated or "="
//     long option) makes sed or awk unknown. git (R27) counts only for status, log, show, diff, add, commit, branch,
//     rev-parse, ls-files, blame, describe and tag listing, with no -c, no option that runs a command or changes the
//     repository or configuration, no GIT_* assignment before it, and no alias of that name in any git config the
//     hook can read (the repository's, found from the working directory or -C; the user's global; the system's;
//     their includes; GIT_CONFIG_COUNT). The configs are only read, never written; one that cannot be read makes
//     git unknown. git's -c values, command-running option values and "!" aliases are always read as commands.
//   - Every other program fails closed: its literal riverwright words are checked, and its quoted arguments,
//     here-documents and here-strings are lexed as commands. sed with an option after its script (GNU sed reads
//     options anywhere) is unknown too. Nested payloads are lexed and checked the same way:
//     sh/bash/zsh/dash/pwsh/cmd -c, eval, env -S, su -c, expect -c, script, tmux, screen, watch (their joined
//     arguments), ssh (the remote command line, and -o ProxyCommand, LocalCommand, KnownHostsCommand and
//     RemoteCommand), git -c alias.*=!... and other -c values, command substitutions, code piped or fed to a shell,
//     and assignments (EDITOR="...", x="..."; $x).
//   - A program that runs commands read from stdin (at, batch, crontab, expect, and ssh, su, runuser and script with
//     no command of their own, or with a bare shell or interpreter as it, past wrappers: ssh host sudo bash) fed by a
//     pipe: text the classifier can reproduce exactly is judged as a command; anything else is denied (cat cmds.txt |
//     at now). A file operand of -, /dev/stdin or /dev/fd/0 is stdin.
//   - The git files it reads (.git, commondir, config files and includes) are read only as regular files of bounded
//     size, opened without blocking; a FIFO, device, socket, directory or oversized file makes git unknown. Past the
//     work budget, nested text is denied when it mentions "credential" or has a variable, glob or brace after a
//     riverwright word.
//   - riverwright submit and post (R37) are allowed only as the whole command line: the trusted launcher's own path as
//     the program, then submit or post and plain arguments. Any other command where a word that is or could be
//     riverwright is followed by one that is or could be submit or post (found as the slot is above) is denied
//     everywhere as riverwright-publish-env: an assignment, wrapper or runtime in front, or any other command, pipe,
//     redirect or subshell on the line.
//   - Structural checks kept from earlier rounds: xargs, parallel, find -exec and rg --pre feeding riverwright;
//     alias definitions that run it; Start-Process with riverwright; inline code (node -e, python -c, a sed e command,
//     an awk system(), ...) that names it near "credential" or loads lib/cli.mjs or commands/credential.mjs.
// Its honest limits: it reads one command line, so it cannot see
//   - code inside a script file, Makefile or package.json that the command runs (sh ./x.sh, make, npm run),
//     including a script written by the same command (printf "rw credential setup" > s.sh && sh s.sh);
//   - a command or argument built from pieces or encoded (base64 -d | sh, IFS games, 'cred' + 'ential' in a
//     language the classifier does not read); a shell (not one of the stdin runners above) reading a pipe it
//     cannot read is only "unresolvable", which is denied in the workspace or while a run is active;
//   - a whole command held in one variable and run by a shell elsewhere (ssh host "$CMD", sh -c "$CMD");
//   - a variable that names riverwright in an ordinary argument of a program that runs it in a way the classifier
//     does not model (an unknown program's --cmd="$X" option, a python script that runs its arguments);
//   - a renamed launcher that cannot be resolved by path: a plain copy or a hard link, a symlink reached by bare
//     name through PATH or through a variable directory ("$D/tool", cd "$D" && ./tool, ~user/tool), or a link created
//     by the same command;
//   - a tool on the non-executing list that runs something through its configuration (a curl config, an rg config
//     already in the environment, a git pager, editor, external diff, hook or fsmonitor set in a config file);
//   - a deliberate forger running as the same user, who can always reach the vault another way.
// It over-blocks on purpose where a program may run its arguments: "$A" "$B" after an exec wrapper (xvfb-run cp
// "$A" "$B") is denied, as are quoted arguments of an unknown program, or of a git subcommand off the allowlist, that
// mention both (gh pr create --title 'rw credential fix', git stash push -m 'rw credential setup'). Because a
// variable that comes before the first plain operand of a runtime, runner, shell or interpreter stands where a program
// does (R29), these are denied machine-wide as well: node "$S" "$A", node --test "$A" "$B", node --require "$R" "$S",
// for f in *.mjs; do node "$f" "$out"; done, bun "$S" "$A", deno run -A "$S" "$A", npx "$TOOL" "$ARG",
// tsx "$S" "$A", bash "$S" "$A", python3 "$S" "$C", uv run "$X" "$Y"; and, past an option that may take a value,
// node --some-option x.mjs "$A" "$B" (options known to take none, such as -y, --test or --no-warnings, do not count).
// node --test "$A", node --test tests/*.test.mjs, npx vitest run "$A" "$B" and bash scripts/test.sh "$A" "$B" stay
// allowed.

const MAX_INPUT = 256 * 1024;
const MAX_DEPTH = 8;
const MAX_WORK = 4 * 1024 * 1024;

const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'for', 'in', 'case', 'esac', 'select', 'function', 'time', 'coproc', '[[', ']]']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'tcsh', 'csh', 'pwsh', 'powershell', 'cmd']);
const HTTP_CLIENTS = new Set(['curl', 'wget', 'http', 'https', 'httpie', 'xh', 'xhs']);
const WRAPPERS = {
  command: [], builtin: [], exec: ['-a'], call: [], nohup: [], nice: ['-n'], ionice: ['-c', '-n', '-p'], setsid: [], chronic: [], unbuffer: [],
  stdbuf: ['-i', '-o', '-e'], sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U'], doas: ['-u', '-C'], caffeinate: ['-t', '-w'],
  strace: ['-o', '-e', '-p', '-s'], ltrace: ['-o', '-e', '-p', '-s'], torsocks: [], proxychains: ['-f'], proxychains4: ['-f'], time: ['-f', '-o'],
  timeout: ['-s', '-k', '--signal', '--kill-after'], flock: ['-w', '-E', '-c'], watch: ['-n', '-d'], busybox: [],
};
const WRAPPER_POSITIONALS = { timeout: 1, flock: 1 };
// eval, and its PowerShell equivalents (names are lowercased by base()).
const EVALUATORS = new Set(['eval', 'iex', 'invoke-expression', 'icm', 'invoke-command']);
// GIT_TEST_* is matched as a prefix (ruling R33-2): GIT_TEST_COMMIT_GRAPH, for one, makes git read the commit-graph
// whatever core.commitGraph says. The object-directory, replace and graft variables change which history git sees.
const DANGEROUS_ENV = /^(GIT_SSH|GIT_SSH_COMMAND|GIT_SSH_VARIANT|GIT_PROXY_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG\w*|GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_ALLOW_PROTOCOL|GIT_TEST\w*|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_REPLACE_REF_BASE|GIT_NO_REPLACE_OBJECTS|GIT_GRAFT_FILE|GIT_NO_LAZY_FETCH|RIVERWRIGHT_\w*|HOME|XDG_CONFIG_HOME)$/i;
const GIT_WATCHED_KEY = /^(remote\.|credential|url\.|branch\.[^.]+\.(pushremote|remote)|push\.|alias\.|riverwright\.|include\.|includeif\.|core\.(hookspath|sshcommand|gitproxy|askpass)|http\.|protocol\.)/i;
const GIT_PUSHERS = new Set(['push', 'send-pack', 'http-push', 'send-email', 'imap-send']);
const GIT_VALUE_OPTS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--attr-source', '--list-cmds']);
const INTERPRETERS = [
  { test: /^(node|nodejs|bun)$/, code: ['-e', '--eval', '-p', '--print'], values: ['-r', '--require', '--import', '--loader', '-C', '--conditions', '--input-type', '--env-file'] },
  { test: /^(python|pypy)(\d+(\.\d+)*)?$/, code: ['-c'], values: ['-W', '-X', '-Q'], module: '-m' },
  { test: /^ruby$/, code: ['-e'], values: ['-I', '-r', '-C', '-E'] },
  { test: /^perl$/, code: ['-e', '-E'], values: ['-I', '-M', '-m'] },
  { test: /^php$/, code: ['-r'], values: ['-c', '-d', '-f'] },
  { test: /^(lua|luajit|osascript|rscript)$/, code: ['-e'], values: [] },
  { test: /^deno$/, code: [], values: [], subcode: 'eval' },
];

// A file operand that is stdin itself.
const isStdinPath = (t) => t === '-' || t === '/dev/stdin' || t === '/dev/fd/0';

export function base(tok) {
  return String(tok).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}


// The program a word names, or null when a variable or substitution decides it. A dynamic directory
// with a literal last segment ("$VENV/bin/python") still names its program.
function programName(w) {
  if (!w) return null;
  const v = nameOf(w);
  if (!isDynamic(w)) return base(v);
  const cut = Math.max(v.lastIndexOf('/'), v.lastIndexOf('\\'));
  const tail = v.slice(cut + 1);
  if (cut >= 0 && tail && !/[$`%{}()]/.test(tail)) return base(tail);
  return null;
}

function checkEnvName(name) {
  if (!DANGEROUS_ENV.test(name)) return null;
  return /^RIVERWRIGHT_/i.test(name)
    ? outward('riverwright-env', `setting ${name} changes how Riverwright finds or checks a run`)
    : outward('git-env', `setting ${name} changes what git runs, reads or pushes`);
}

function classifyGitRemote(rest, ctx) {
  let j = 0;
  while (rest[j] && nameOf(rest[j]).startsWith('-')) j += 1;
  const action = rest[j];
  if (!action) return null;
  if (isDynamic(action)) return ctx.strict ? unresolvable('the git remote action is a variable or substitution') : null;
  const a = nameOf(action).toLowerCase();
  if (['show', 'get-url', 'update', 'prune'].includes(a)) return null;
  return outward('git-remote-change', `git remote ${a}`);
}

function classifyGitConfig(rest, ctx) {
  const positionals = [];
  let wide = false;
  let write = false;
  let edit = false;
  for (let i = 0; i < rest.length; i += 1) {
    const t = nameOf(rest[i]);
    if (t === '--global' || t === '--system') wide = true;
    else if (t === '-e' || t === '--edit') edit = true;
    else if (/^--(unset|unset-all|add|replace-all|rename-section|remove-section)$/.test(t)) write = true;
    else if (['-f', '--file', '--blob', '--type', '--default', '--comment', '--value'].includes(t)) i += 1;
    else if (!t.startsWith('-')) positionals.push(rest[i]);
  }
  if (positionals[0] && ['get', 'set', 'unset', 'list', 'edit', 'rename-section', 'remove-section', 'get-color', 'get-colorbool'].includes(nameOf(positionals[0]))) {
    const sub = nameOf(positionals.shift());
    if (['set', 'unset', 'rename-section', 'remove-section'].includes(sub)) write = true;
    if (sub === 'edit') edit = true;
  }
  if (edit) return outward('git-config-edit', 'editing git config in an editor');
  if (ctx.strict && positionals.some(isDynamic)) return unresolvable('a git config key or value is a variable or substitution');
  const watched = positionals.find((w) => GIT_WATCHED_KEY.test(nameOf(w)));
  if (watched) return outward('git-config-remote', `git config ${nameOf(watched)} (remotes, credentials, aliases, hooks or riverwright settings)`);
  if (positionals.length >= 2) write = true;
  if (write && wide) return outward('git-config-global', 'writing global or system git config');
  return null;
}

function classifyGit(args, ctx) {
  if (args.some((w) => /core\.hookspath/i.test(w.value))) return outward('git-hooks-path', 'changing core.hooksPath');
  let i = 0;
  for (; i < args.length; i += 1) {
    const t = nameOf(args[i]);
    if (t === '-c' || t === '--config-env' || (t.startsWith('-c') && t.length > 2) || t.startsWith('--config-env=')) {
      let kv = t.startsWith('--config-env=') ? t.slice(13) : t.length > 2 && t.startsWith('-c') ? t.slice(2) : null;
      let dyn = isDynamic(args[i]);
      if (kv === null) { i += 1; kv = nameOf(args[i]); dyn = isDynamic(args[i]); }
      if (dyn && ctx.strict) return unresolvable('a git -c setting is a variable or substitution');
      const key = String(kv ?? '').split('=')[0];
      if (GIT_WATCHED_KEY.test(key)) return outward('git-config-override', `git -c ${key}`);
      continue;
    }
    if (t.startsWith('--exec-path=')) return outward('git-exec-path', 'running git programs from another directory');
    if (GIT_VALUE_OPTS.has(t)) { i += 1; continue; }
    if (t.startsWith('-')) continue;
    break;
  }
  const subWord = args[i];
  if (!subWord) return null;
  if (isDynamic(subWord)) return ctx.strict ? unresolvable('the git subcommand is a variable or substitution') : null;
  const sub = nameOf(subWord).toLowerCase();
  const rest = args.slice(i + 1);
  if (GIT_PUSHERS.has(sub)) return outward('git-push', `git ${sub}`);
  if (sub === 'svn' && nameOf(rest[0]).toLowerCase() === 'dcommit') return outward('git-push', 'git svn dcommit');
  if (sub === 'p4' && nameOf(rest[0]).toLowerCase() === 'submit') return outward('git-push', 'git p4 submit');
  if (sub.startsWith('credential')) return outward('git-credential', 'reading or storing git credentials');
  if (sub.startsWith('remote-')) return outward('git-remote-helper', `git ${sub}`);
  if ((sub === 'subtree' || sub === 'lfs') && nameOf(rest[0]).toLowerCase() === 'push') return outward('git-push', `git ${sub} push`);
  if (sub === 'remote') return classifyGitRemote(rest, ctx);
  if (sub === 'config') return classifyGitConfig(rest, ctx);
  return null;
}

function classifyShell(prog, args, cmd, ctx) {
  // Expansions stay in the text as $NAME, so the nested classification sees exactly which words vary.
  const script = (w) => (w ? classifyScript(w.value, ctx.deeper(true)) : null);
  if (prog === 'cmd') {
    const k = args.findIndex((w) => /^\/[ck]$/i.test(nameOf(w)));
    if (k === -1) return null;
    return classifyScript(args.slice(k + 1).map((w) => w.value).join(' '), ctx.deeper(true));
  }
  let stdin = true;
  for (let i = 0; i < args.length; i += 1) {
    const t = nameOf(args[i]);
    if (prog === 'pwsh' || prog === 'powershell') {
      if (/^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)$/i.test(t)) return unresolvable('PowerShell runs an encoded command');
      if (/^-(c|co|com|comm|comma|comman|command)$/i.test(t)) return script({ value: args.slice(i + 1).map((w) => w.value).join(' ') });
      if (/^-(f|fi|fil|file)$/i.test(t)) return null;
      if (/^-(o|op|opt|outputformat|if|inputformat|ex|executionpolicy|wd|workingdirectory|config\w*)$/i.test(t)) { i += 1; continue; }
      if (t.startsWith('-')) continue;
      return null;
    }
    if (t === '--') { stdin = i + 1 >= args.length; break; }
    if (/^--(rcfile|init-file)$/.test(t) || /^[-+][oO]$/.test(t)) { i += 1; continue; }
    if (t.startsWith('--')) continue;
    if (/^[-+][A-Za-z]+$/.test(t)) {
      if (t[0] === '-' && t.includes('c')) {
        let j = i + 1;
        while (args[j] && /^[-+][A-Za-z]+$/.test(nameOf(args[j]))) j += 1;
        return script(args[j]) ?? null;
      }
      continue;
    }
    if (isStdinPath(t)) break;
    stdin = false;
    break;
  }
  if (!stdin) return null;
  return classifyStdinCode(prog, cmd, ctx, (text) => classifyScript(text, ctx.deeper(true)));
}

// A shell or interpreter with no script operand reads its program from stdin.
function classifyStdinCode(prog, cmd, ctx, judge) {
  if (cmd.stdin === 'heredoc') {
    for (const h of cmd.heredocs) { const v = judge(h.text); if (v) return v; }
    return null;
  }
  if (cmd.stdin === 'herestring') {
    for (const w of cmd.herestrings) {
      if (isDynamic(w)) return unresolvable(`${prog} runs code held in a variable or substitution`);
      const v = judge(w.value);
      if (v) return v;
    }
    return null;
  }
  if (cmd.stdin === 'pipe') {
    const text = pipedText(cmd.prev);
    if (text === null) return pipedCredential(cmd.prev, ctx) ?? unresolvable(`${prog} runs code piped in from another command`);
    return judge(text);
  }
  return null;
}

// The text a plain cat/echo/printf pipes onward, or null when it cannot be known exactly (files other
// than a script operand, escapes some echo builtins expand, variables, substitutions).
function pipedText(prev) {
  if (!prev) return null;
  const p = programName(prev.words[0]);
  const args = prev.words.slice(1);
  if (args.some((w) => isDynamic(w) || w.subs.length)) return null;
  if (p === 'cat' && !args.length) {
    if (prev.stdin === 'heredoc') return prev.heredocs.some((h) => !h.quoted && /[$`\\]/.test(h.text)) ? null : prev.heredocs.map((h) => h.text).join('\n');
    if (prev.stdin === 'herestring') return prev.herestrings.some(isDynamic) ? null : prev.herestrings.map((w) => w.value).join('\n');
    return null;
  }
  if (p === 'echo' || p === 'printf') {
    const data = args.filter((w) => !(p === 'echo' && /^-[nE]+$/.test(w.value)));
    if (data.some((w) => /[\\%]/.test(w.value) || /^-[a-zA-Z]*e/.test(w.value))) return null;
    return data.map((w) => w.value).join(' ');
  }
  return null;
}

function classifyInterpreter(prog, spec, args, cmd, ctx) {
  const judge = (code) => {
    if (ctx.cred && inlineCredential(code)) return credentialVerdict(CREDENTIAL_DETAIL);
    return codeLooksOutward(code) ? outward('inline-code', `${prog} inline code reaches GitHub or runs git/gh`) : null;
  };
  const run = (w) => {
    if (!w) return null;
    if (isDynamic(w)) return unresolvable(`${prog} runs code held in a variable or substitution`);
    return judge(w.value);
  };
  if (spec.subcode) return nameOf(args[0]) === spec.subcode ? run(args[1]) : null;
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i];
    const t = nameOf(w);
    const flag = spec.code.find((f) => t === f || (f.startsWith('--') ? t.startsWith(`${f}=`) : t.startsWith(f) && t.length > f.length && f.length === 2));
    if (flag) {
      if (t === flag) return run(args[i + 1]);
      return run({ value: t.slice(flag.length + (flag.startsWith('--') ? 1 : 0)), dynamic: isDynamic(w) });
    }
    if (spec.module && t === spec.module) return null;
    if (spec.values.includes(t)) { i += 1; continue; }
    if (isStdinPath(t)) break;
    if (t.startsWith('-')) continue;
    return null;
  }
  return classifyStdinCode(prog, cmd, ctx, judge);
}

// The words of the program a wrapper chain (nice, sudo, timeout 5, ...) finally runs.
function throughWrappers(words) {
  let ws = words;
  for (let guard = 0; guard < 16 && ws.length; guard += 1) {
    const p = programName(ws[0]);
    if (p === null || !Object.hasOwn(WRAPPERS, p)) break;
    ws = ws.slice(1 + wrapperSkip(p, ws.slice(1)));
  }
  return ws;
}

// xargs, parallel and find -exec run riverwright with arguments they supply (stdin, a file, a file name): any of
// them could be "credential".
function feedsRiverwright(words, ctx) {
  if (!ctx.cred) return false;
  const ws = throughWrappers(words);
  return ws.length > 0 && mayBeRiverwright(ws[0], ctx);
}

function classifyXargs(args, ctx) {
  let i = 0;
  let replace = null;
  for (; i < args.length; i += 1) {
    const t = nameOf(args[i]);
    if (t === '-I') { replace = nameOf(args[i + 1]); i += 1; continue; }
    if (t.startsWith('-I')) { replace = t.slice(2); continue; }
    if (['-n', '-L', '-P', '-s', '-d', '-E', '-a'].includes(t)) { i += 1; continue; }
    if (/^-i/.test(t)) { replace = t.slice(2) || '{}'; continue; }
    if (t === '--replace' || t.startsWith('--replace=')) { replace = t.includes('=') ? t.slice(10) : '{}'; continue; }
    if (t.startsWith('-')) continue;
    break;
  }
  const rest = args.slice(i);
  if (!rest.length) return null;
  if (feedsRiverwright(rest, ctx)) return credentialVerdict('xargs supplies the arguments to riverwright (they could be "credential")');
  if (ctx.cred && replace && nameOf(rest[0]).includes(replace) && rest[1] && couldBeCredential(rest[1])) {
    return credentialVerdict('xargs supplies the program, and the word after it is (or could expand to) "credential"');
  }
  const p = programName(rest[0]);
  if (p === null || ['git', 'gh', 'env', 'sudo', 'xargs', 'hub', ...EVALUATORS, ...SHELLS, ...HTTP_CLIENTS].includes(p) || INTERPRETERS.some((s) => s.test.test(p))) {
    return unresolvable(`xargs supplies the arguments to ${p ?? 'a variable program'}`);
  }
  return classifyInvocation(rest, { words: rest, stdin: null, heredocs: [], herestrings: [] }, ctx);
}

function classifyAssignments(args, ctx) {
  for (const w of args) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\+?=|$)/.exec(nameOf(w));
    if (m) { const v = checkEnvName(m[1]); if (v) return v; }
    else if (isDynamic(w) && ctx.strict && !nameOf(w).startsWith('-')) return unresolvable('an exported name is a variable or substitution');
  }
  return null;
}

// How many of a wrapper's arguments are its own options and positionals before the program it runs.
function wrapperSkip(prog, args) {
  const valued = WRAPPERS[prog];
  let skip = WRAPPER_POSITIONALS[prog] ?? 0;
  let i = 0;
  for (; i < args.length; i += 1) {
    const t = nameOf(args[i]);
    if (valued.includes(t)) { i += 1; continue; }
    if (t.startsWith('-') && t !== '-') continue;
    if (skip > 0) { skip -= 1; continue; }
    break;
  }
  return i;
}

const PARALLEL_VALUE_OPTS = new Set(['-j', '--jobs', '-P', '--max-procs', '-S', '--sshlogin', '--sshloginfile', '--slf', '-a', '--arg-file', '--colsep', '-C', '-d', '--delimiter', '-E', '-I', '--delay', '--timeout', '--joblog', '--results', '-n', '-N', '-L', '--max-args', '--tmpdir', '--workdir', '--tag-string']);

// GNU parallel: the command comes before ::: / ::::, possibly as one quoted string.
function classifyParallel(args, ctx) {
  const end = args.findIndex((w) => /^::::?\+?$/.test(nameOf(w)));
  const own = args.slice(0, end === -1 ? undefined : end);
  let i = 0;
  for (; i < own.length; i += 1) {
    const t = nameOf(own[i]);
    if (PARALLEL_VALUE_OPTS.has(t)) { i += 1; continue; }
    if (t.startsWith('-')) continue;
    break;
  }
  if (i >= own.length) return null;
  const inner = /\s/.test(nameOf(own[i])) ? (lex(nameOf(own[i]), ctx.opts.lex).commands[0]?.words ?? []) : own.slice(i);
  return feedsRiverwright(inner, ctx) ? credentialVerdict('parallel supplies the arguments to riverwright (they could be "credential")') : null;
}

function classifyInvocation(words, cmd, ctx) {
  const prog = programName(words[0]);
  if (prog === null) return ctx.strict ? unresolvable('the program is a variable or substitution') : null;
  const args = words.slice(1);
  if (EVALUATORS.has(prog)) return unresolvable(`${prog} runs text the classifier cannot see`);
  if (prog === 'env') {
    let envVerdict = null;
    let i = 0;
    for (; i < args.length; i += 1) {
      const t = nameOf(args[i]);
      if (['-u', '--unset', '-C', '--chdir'].includes(t)) { i += 1; continue; }
      if (t === '-S' || t === '--split-string' || t.startsWith('--split-string=')) {
        const s = t.includes('=') ? { value: t.slice(t.indexOf('=') + 1), dynamic: isDynamic(args[i]) } : args[i + 1];
        if (!s || isDynamic(s)) return unresolvable('env -S splits a variable into a command');
        return classifyScript(s.value, ctx.deeper(true));
      }
      if (t.startsWith('-')) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(t);
      if (m) { envVerdict = envVerdict ?? checkEnvName(m[1]); continue; }
      break;
    }
    const inner = args.length > i ? classifyInvocation(args.slice(i), cmd, ctx) : null;
    return prefer(envVerdict, inner);
  }
  if (Object.hasOwn(WRAPPERS, prog)) {
    const i = wrapperSkip(prog, args);
    if (prog === 'command' && args.some((w) => ['-v', '-V'].includes(nameOf(w)))) return null;
    return args.length > i ? classifyInvocation(args.slice(i), cmd, ctx) : null;
  }
  if (['export', 'declare', 'typeset', 'local', 'readonly', 'set', 'setenv', 'setx'].includes(prog)) return classifyAssignments(args, ctx);
  if (prog === 'alias') {
    for (const w of args) {
      const m = /^([^=]+)=([\s\S]*)$/.exec(nameOf(w));
      if (!m) continue;
      if (isDynamic(w) && ctx.strict) return unresolvable('an alias is defined from a variable or substitution');
      const inner = lex(m[2], ctx.opts.lex).commands[0];
      // bash expands an alias defined earlier in the same script (shopt -s expand_aliases).
      if (ctx.cred && inner && throughWrappers(inner.words).length && mayBeRiverwright(throughWrappers(inner.words)[0], ctx)) {
        return credentialVerdict(`alias ${m[1]} runs riverwright (its arguments could be "credential")`);
      }
      const p = inner && programName(inner.words[0]);
      if (p && (['git', 'gh', 'env', 'sudo', 'xargs', 'hub', ...EVALUATORS, ...SHELLS, ...HTTP_CLIENTS].includes(p) || INTERPRETERS.some((s) => s.test.test(p)))) {
        return outward('shell-alias', `alias ${m[1]} runs ${p}`);
      }
    }
    return null;
  }
  if (prog === 'xargs') return classifyXargs(args, ctx);
  if (prog === 'parallel') return classifyParallel(args, ctx);
  if (prog === 'find') {
    const k = args.findIndex((w) => ['-exec', '-execdir', '-ok', '-okdir'].includes(nameOf(w)));
    if (k === -1) return null;
    const end = args.findIndex((w, j) => j > k && [';', '+'].includes(nameOf(w)));
    if (end === k + 1 || k + 1 >= args.length) return null;
    const run = args.slice(k + 1, end === -1 ? undefined : end);
    // A found file can be named "credential" (find credential -prune -exec rw {} remove).
    if (run.some((w) => nameOf(w).includes('{}')) && feedsRiverwright(run, ctx)) return credentialVerdict('find -exec supplies file names to riverwright (a file can be named "credential")');
    return classifyInvocation(run, { words: [], stdin: null, heredocs: [], herestrings: [] }, ctx);
  }
  if (prog === 'git') return classifyGit(args, ctx);
  if (prog.startsWith('git-')) return classifyGit([{ value: prog.slice(4), dynamic: false }, ...args], ctx);
  if (prog === 'gh') return classifyGh(args, ctx);
  if (prog === 'hub') {
    const sub = args.find((w) => !nameOf(w).startsWith('-'));
    if (!sub || ['browse', 'compare', 'help', 'version', 'ci-status', 'sync'].includes(nameOf(sub))) return null;
    return outward('hub', `hub ${nameOf(sub)}`);
  }
  if (HTTP_CLIENTS.has(prog)) return classifyHttp(prog, args, ctx);
  if (SHELLS.has(prog)) return classifyShell(prog, args, cmd, ctx);
  const spec = INTERPRETERS.find((s) => s.test.test(prog));
  if (spec) return classifyInterpreter(prog, spec, args, cmd, ctx);
  return null;
}

// "riverwright credential ..." seals, replaces or removes the credential. The human runs it in their own
// terminal, so an agent's shell command that can run it is denied, wherever it runs (R23).
// R26, the subcommand-slot rule. The CLI dispatches on its first argument alone (scripts/lib/cli.mjs main), so
// riverwright runs the credential command only when the word right after the program is "credential". Over the
// lexer's decoded words, for each word that is or could be riverwright, the next word (the slot) is checked: it is
// denied when it is, could be, or could vanish into "credential". Nothing is expanded: a glob is matched (never
// generated), a brace is "could be anything", and a word's shape (its value with each expansion written as "*")
// tells literal text from text a variable supplies.
const RIVERWRIGHT_NAMES = new Set(['riverwright', 'rw']);
const CANDIDATE_NAMES = ['riverwright', 'rw', ...['mjs', 'cmd', 'exe', 'bat', 'com', 'ps1', 'js'].flatMap((x) => [`riverwright.${x}`, `rw.${x}`]), 'cli.mjs', 'credential.mjs'];
const CREDENTIAL_DETAIL = 'riverwright credential (sealing, replacing or removing your credential is something you do yourself, in your own terminal)';
// A slot denial is sometimes a false positive (rm "$A" "$B"), so it says how to get past one.
const SLOT_DETAIL = 'riverwright credential, or a word that could be riverwright followed by one that could be "credential" (a variable, substitution, glob or brace). Sealing, replacing or removing your credential is something you do yourself, in your own terminal. If this command is not that, write the values out in full instead of variables or patterns';
const GLOB = /[*?[]/;
const EXTGLOB = /[@!+?*]\(/;
// Text worth lexing again as a command for this rule: it could name riverwright or credential.
const PAYLOAD_HINT = /rw|credential|cli\.mjs/i;
// A riverwright word in raw text (only for a command too long to lex).
const RIVERWRIGHT_TEXT = /(?<![\w.-])(?:riverwright|rw)(?![\w-])|(?<![\w-])(?:cli|credential)\.mjs(?!\w)/i;

// The launcher's own files. A program word, or the script node runs, whose real path is one of these is
// riverwright whatever it is called (a symlink named anything).
const LAUNCHER_FILES = ['../../../bin/riverwright', '../../../bin/riverwright.cmd', '../../../bin/rw', '../../../bin/rw.cmd', '../../riverwright.mjs', '../cli.mjs', '../commands/credential.mjs']
  .map((rel) => realish(fileURLToPath(new URL(rel, import.meta.url))));

const credentialVerdict = (why) => outward('riverwright-credential', why);
const isCredential = (v) => v?.rule === 'riverwright-credential';
// The rules that apply everywhere outrank the others: riverwright-credential first, then riverwright-publish-env (R37).
const RANK = { 'riverwright-credential': 2, 'riverwright-publish-env': 1 };
const rank = (v) => (v ? (RANK[v.rule] ?? 0) : -1);
const prefer = (found, v) => (!found || rank(v) > rank(found) ? (v ?? found) : found);
const mentionsCredential = (s) => /credential/i.test(String(s).replace(/["'`\\^]/g, ''));

// A glob, matched (never expanded) against a short name, case-insensitively. Any [...] class counts as one
// character. The classic two-pointer match: time is (pattern length) x (name length), with no backtracking blowup.
function globMatch(pattern, name) {
  const units = [];
  const p = pattern.toLowerCase();
  const lastClose = p.lastIndexOf(']');
  let fixed = 0;
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') { if (units[units.length - 1] !== '*') units.push('*'); continue; }
    if (c === '?') units.push('?');
    else if (c === '[' && lastClose >= i + 2) { units.push('?'); i = p.indexOf(']', i + 2); }
    else units.push(c);
    // Each unit other than "*" takes one character: more of them than the name has cannot match.
    fixed += 1;
    if (fixed > name.length) return false;
  }
  const s = name.toLowerCase();
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < units.length && (units[pi] === '?' || units[pi] === s[si])) { pi += 1; si += 1; }
    else if (pi < units.length && units[pi] === '*') { star = pi; mark = si; pi += 1; }
    else if (star !== -1) { pi = star + 1; mark += 1; si = mark; }
    else return false;
  }
  while (pi < units.length && units[pi] === '*') pi += 1;
  return pi === units.length;
}

// A word's shape: its decoded value with every expansion ($X, ${..}, $(..), backticks, %NAME%) written as "*".
function shapeOf(w) {
  const s = typeof w?.shape === 'string' ? w.shape : isDynamic(w) ? '*' : String(w?.value ?? '');
  return unCaret(s).replace(/%[A-Za-z_]\w*%/g, '*');
}

// The slot test: the word is "credential", or could become it (a variable or substitution with no literal text
// that rules it out, a glob that matches it, any brace or extglob, a PowerShell splat or a comma list with it).
function couldBeCredential(w) {
  const s = shapeOf(w);
  if (/[{}]/.test(s) || EXTGLOB.test(s) || /^@\w/.test(s)) return true;
  return s.split(',').some((part) => globMatch(part, 'credential'));
}

// A word that may disappear before riverwright sees its arguments, so the word after it can be the slot: "--"
// (npm exec and npx drop it) and a glob (nullglob removes one that matches nothing).
const mayVanish = (w) => nameOf(w) === '--' || (!isDynamic(w) && GLOB.test(shapeOf(w)));

// The name a program or package word stands for: its base name without .exe/.cmd/.mjs, a package version
// (riverwright@latest, @scope/riverwright@1.2.3) or a tarball suffix.
function riverwrightName(v) {
  return base(v).replace(/(?!^)@[^@]*$/, '').replace(/\.(mjs|cjs|js|tgz|tar\.gz)$/, '');
}

// Could this shape name riverwright (or its script)? Only the last path segment counts. An expansion ("*" in a
// dynamic word) can supply anything, including a "/", so only the literal text after it is known.
function formCouldBeRiverwright(form, dynamic) {
  // A package specifier (deno run npm:riverwright) names the package after its scheme.
  const seg = form.split(/[\\/]/).pop().replace(/^(?:npm|jsr):/i, '');
  if (/[{}]/.test(seg) || EXTGLOB.test(seg)) {
    const l = seg.toLowerCase();
    const r = l.indexOf('r');
    return (r !== -1 && l.indexOf('w', r + 1) !== -1) || l.includes('mjs');
  }
  const name = seg.replace(/(?!^)@[^@]*$/, '');
  if (dynamic && name.includes('*')) {
    const tail = name.slice(name.lastIndexOf('*') + 1);
    return CANDIDATE_NAMES.some((n) => globMatch(`*${tail}`, n));
  }
  if (GLOB.test(name)) return CANDIDATE_NAMES.some((n) => globMatch(name, n));
  return RIVERWRIGHT_NAMES.has(riverwrightName(name)) || ['cli.mjs', 'credential.mjs'].includes(name.toLowerCase());
}

// F2 (Task 17): the working directories a relative path may be resolved against. The command's own cd, pushd, chdir
// and Set-Location change it, in a subshell too, so every directory any of them names is kept (the set only grows: a
// subshell's end, popd and "cd -" go back to a directory already in it). A cd later in the command counts as well
// (classifyCommand reads the command again when the set grew, for loops). Past MAX_CWDS, a relative path fails closed.
const MAX_CWDS = 32;
const MAX_DIR_ENTRIES = 1024;
const CD_PROGRAMS = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location']);

// The homes "~" may stand for: the account's home from the password database (os.userInfo, which the environment
// cannot change) and the HOME the shell has. Both are checked.
function homesOf(ctx) {
  const o = ctx.opts;
  if (!o.homes) {
    let account = null;
    try { account = o.userInfo().homedir; } catch { account = null; }
    o.homes = [...new Set([account, o.env.HOME, o.env.USERPROFILE].filter((h) => typeof h === 'string' && path.isAbsolute(h)))];
  }
  return o.homes;
}

// The absolute paths a path word may name: "~" expanded to each home (and kept literal), a relative path against
// every working directory the command may be in. null when there are too many directories to know.
function pathsOf(v, ctx) {
  const out = [];
  if (v === '~' || /^~[\\/]/.test(v)) for (const h of homesOf(ctx)) out.push(path.join(h, v.slice(1)));
  if (path.isAbsolute(v)) out.push(v);
  else {
    if (ctx.opts.cwds.overflow) return null;
    for (const c of ctx.opts.cwds) out.push(path.resolve(c, v));
  }
  return out;
}

function trackCd(cmd, ctx) {
  const ws = cmd.words;
  const k = programIndex(ws, ctx);
  if (k >= ws.length || !CD_PROGRAMS.has(programName(ws[k]) ?? '')) return;
  const args = ws.slice(k + 1);
  const target = args.find((w) => { const t = nameOf(w); return t === '-' || !t.startsWith('-'); });
  let v;
  if (!target) v = '~';
  else if (isDynamic(target)) {
    // $HOME, ${HOME} and $PWD are known; any other variable is a variable directory (a stated limit).
    v = nameOf(target).replace(/^(?:\$HOME|\$\{HOME\})(?=$|[\\/])/, '~').replace(/^(?:\$PWD|\$\{PWD\})(?=$|[\\/])/, '.');
    if (/[$`]/.test(v)) return;
  } else v = nameOf(target);
  if (v === '-') return;
  const cwds = ctx.opts.cwds;
  const bases = path.isAbsolute(v) || v === '~' || /^~[\\/]/.test(v) ? [] : String(ctx.opts.env.CDPATH ?? '').split(path.delimiter).filter((d) => path.isAbsolute(d));
  const found = [...(pathsOf(v, ctx) ?? []), ...bases.map((b) => path.resolve(b, v))];
  for (const d of found) {
    if (cwds.includes(d)) continue;
    if (cwds.length >= MAX_CWDS) { cwds.overflow = true; return; }
    cwds.push(d);
  }
}

// Does any entry of this directory resolve to the launcher files? A glob or brace in the last segment of a path could
// match it (F2). Cached per directory; an unreadable or very large directory fails closed only when it exists.
function dirHoldsLauncher(dir, ctx) {
  const cache = ctx.opts.dirCache;
  if (cache.has(dir)) return cache.get(dir);
  let hit = false;
  try {
    const names = fs.readdirSync(dir);
    hit = names.length > MAX_DIR_ENTRIES || names.some((n) => ctx.opts.launchers.has(realish(path.join(dir, n))));
  } catch (err) {
    hit = !['ENOENT', 'ENOTDIR'].includes(err.code);
  }
  cache.set(dir, hit);
  return hit;
}

// A path that resolves (realpath, against the command's working directories, after "~") to one of the launcher files.
// A bare name is a path only when it looks like a script (node a.mjs); as a program it is looked up in PATH. A glob or
// brace in its last segment counts when that directory holds a launcher link; one in a directory segment fails closed.
// Long or deep paths are not resolved (realish walks up one parent per missing segment); results are cached.
function resolvesToLauncher(v, ctx) {
  if (!/[\\/]/.test(v) && !/\.(mjs|cjs|js)$/i.test(v)) return false;
  if (v.includes('\0') || v.length > 1024 || v.split(/[\\/]/).length > 64) return false;
  const pattern = GLOB.test(v) || /[{}]/.test(v);
  const cut = Math.max(v.lastIndexOf('/'), v.lastIndexOf('\\'));
  if (pattern && (GLOB.test(v.slice(0, cut + 1)) || /[{}]/.test(v.slice(0, cut + 1)))) return true;
  const paths = pathsOf(pattern ? (v.slice(0, cut + 1) || '.') : v, ctx);
  if (paths === null) return true;
  const cache = ctx.opts.realCache;
  return paths.some((p) => {
    if (pattern) return dirHoldsLauncher(p, ctx);
    if (cache.has(p)) return cache.get(p);
    let hit = false;
    try {
      hit = ctx.opts.launchers.has(realish(p));
    } catch {
      hit = false;
    }
    cache.set(p, hit);
    return hit;
  });
}

// A word that is, or could be, the riverwright program: its name, a pattern or expansion that could produce it, a
// path that resolves to the launcher files. For a KEY=VALUE word (ProxyCommand=rw, alias.x=!rw, EDITOR=rw) the value
// counts too, with a leading "!" (a shell alias) removed.
function mayBeRiverwright(w, ctx) {
  if (!w) return false;
  const s = shapeOf(w);
  const dynamic = isDynamic(w);
  if (formCouldBeRiverwright(s, dynamic)) return true;
  const eq = s.indexOf('=');
  if (eq !== -1 && formCouldBeRiverwright(s.slice(eq + 1).replace(/^!/, ''), dynamic)) return true;
  if (s.startsWith('!') && formCouldBeRiverwright(s.slice(1), dynamic)) return true;
  return !dynamic && resolvesToLauncher(nameOf(w), ctx);
}

// A literal riverwright program word (no expansion, no pattern): its own arguments are riverwright's, which it
// never runs, so only its slot matters.
function isLiteralRiverwright(w) {
  if (!w || isDynamic(w)) return false;
  const s = shapeOf(w);
  return !GLOB.test(s) && !/[{}]/.test(s) && formCouldBeRiverwright(s, false);
}

// A word that holds riverwright and its subcommand at once: a brace or expansion whose own text mentions
// "credential" ({rw,credential}), or riverwright followed by an expansion that could split off "credential"
// (rw${IFS}credential).
function holdsCredential(w, ctx) {
  const s = shapeOf(w);
  if (/[{}]/.test(s) && /credential/i.test(s) && mayBeRiverwright(w, ctx)) return true;
  if (!isDynamic(w)) return false;
  const m = /^(?:riverwright|rw)(?:\.\w+)?(\*.*)$/i.exec(s.split(/[\\/]/).pop());
  return Boolean(m) && globMatch(m[1].replace(/,.*$/, ''), 'credential');
}

// Known tools that never run their arguments as commands (R26). Their arguments are not read as programs. sed and
// awk count only without a way to run a command (sed's e command or flag, w/W file writes; awk's system() or a
// pipe) and only when every option is one the check knows (an attached or abbreviated option it cannot place, such
// as -fX, -iX, -lX, -EX or --fi=X, makes the tool unknown). find counts only without -exec/-execdir/-ok/-okdir, rg
// only without --pre, --hostname-bin or a RIPGREP_CONFIG_PATH assignment, and git only for the allowlist below
// (R27). Every other program fails closed: its literal riverwright words are checked, and its quoted arguments are
// read as commands.
const NON_EXECUTING = new Set(['grep', 'egrep', 'fgrep', 'rg', 'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'diff', 'cmp', 'ls', 'stat', 'file', 'mount', 'umount', 'chmod', 'chown', 'cp', 'mv', 'ln', 'mkdir', 'rmdir', 'touch', 'cut', 'tr', 'curl', 'wget', 'jq', 'git', 'sed', 'awk', 'gawk', 'mawk', 'nawk', 'find']);
const FIND_EXEC = ['-exec', '-execdir', '-ok', '-okdir'];

// The one long option a (possibly abbreviated) name stands for, or null when it is unknown or ambiguous.
function longOption(name, known) {
  if (known.includes(name)) return name;
  const hits = name ? known.filter((o) => o.startsWith(name)) : [];
  return hits.length === 1 ? hits[0] : null;
}

const AWK_LONG = ['file', 'include', 'load', 'exec', 'source', 'assign', 'field-separator'];
const SED_LONG = ['expression', 'file', 'in-place', 'line-length', 'quiet', 'silent', 'regexp-extended', 'separate', 'null-data', 'zero-terminated', 'unbuffered', 'posix', 'debug', 'sandbox', 'follow-symlinks', 'binary', 'help', 'version'];

// The script texts of an awk command, or null when a script comes from a file or an option is unknown.
function awkScripts(args) {
  const scripts = [];
  for (let i = 0; i < args.length; i += 1) {
    const t = nameOf(args[i]);
    if (t === '--') { if (!scripts.length && i + 1 < args.length) scripts.push(nameOf(args[i + 1])); return scripts; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = t.slice(2, eq === -1 ? undefined : eq);
      // Any name that could abbreviate a file-loading option is unknown, even when it could also be another one.
      if (['file', 'include', 'load', 'exec'].some((o) => o.startsWith(name))) return null;
      const opt = longOption(name, AWK_LONG);
      if (opt === 'source') { scripts.push(eq === -1 ? nameOf(args[i += 1]) : t.slice(eq + 1)); continue; }
      if (opt && eq === -1) i += 1;
      continue;
    }
    if (t.startsWith('-') && t !== '-') {
      // A cluster of short options; the first that takes a value takes the rest of the word (or the next word).
      for (let j = 1; j < t.length; j += 1) {
        const c = t[j];
        const rest = t.slice(j + 1);
        if ('filEW'.includes(c)) return null;
        if (c === 'e') { scripts.push(rest || nameOf(args[i += 1])); break; }
        if (c === 'v' || c === 'F') { if (!rest) i += 1; break; }
      }
      continue;
    }
    if (!scripts.length) scripts.push(t);
    return scripts;
  }
  return scripts;
}

// The script texts of a sed command, or null when a script comes from a file or an option is unknown. After a bare
// -i the next word may be a suffix (BSD) or the script (GNU): both are read as scripts.
function sedScripts(args) {
  const scripts = [];
  let suffixMaybe = false;
  for (let i = 0; i < args.length; i += 1) {
    const t = nameOf(args[i]);
    if (t === '--') { if (!scripts.length) scripts.push(...args.slice(i + 1, i + 1 + (suffixMaybe ? 2 : 1)).map(nameOf)); return scripts; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const opt = longOption(t.slice(2, eq === -1 ? undefined : eq), SED_LONG);
      if (opt === null || opt === 'file') return null;
      if (opt === 'expression') scripts.push(eq === -1 ? nameOf(args[i += 1]) : t.slice(eq + 1));
      if (opt === 'line-length' && eq === -1) i += 1;
      continue;
    }
    if (t.startsWith('-') && t !== '-') {
      for (let j = 1; j < t.length; j += 1) {
        const c = t[j];
        const rest = t.slice(j + 1);
        if (c === 'f') return null;
        if (c === 'e') { scripts.push(rest || nameOf(args[i += 1])); break; }
        if (c === 'i' || c === 'I') { if (!rest) suffixMaybe = true; break; }
        if (c === 'l') { if (!rest) i += 1; break; }
        if (!'nsErRuzbH'.includes(c)) return null;
      }
      continue;
    }
    if (t === '' && suffixMaybe) continue;
    // GNU sed reads options anywhere (getopt permutes), so an option after the first operand (sed s/a/b/ f -e '1e ...')
    // could add a script: sed is then unknown.
    const end = args.findIndex((w, j) => j > i && nameOf(w) === '--');
    if (args.slice(i + 1, end === -1 ? undefined : end).some((w) => { const u = nameOf(w); return u.startsWith('-') && u !== '-'; })) return null;
    if (!scripts.length) {
      scripts.push(t);
      // Read as BSD sed would (the word after -i was its suffix). BSD sed has no e command, and a w file write in the
      // GNU reading is already checked, so this second reading counts only for an e.
      if (suffixMaybe && i + 1 < args.length && nameOf(args[i + 1]).includes('e')) scripts.push(nameOf(args[i + 1]));
    }
    return scripts;
  }
  return scripts;
}

function toolScripts(prog, args) {
  return prog === 'sed' ? sedScripts(args) : awkScripts(args);
}

// R27: git counts as non-executing only for these built-in subcommands, with no -c or --config-env, no option that
// runs a command or changes which repository or configuration git reads, no GIT_* assignment before it, and no alias
// of that name in any git config the hook can read. git ignores an alias named like a built-in command, so the alias
// check is a second line of defence. tag counts only when it lists tags.
const GIT_SAFE = new Set(['status', 'log', 'show', 'diff', 'add', 'commit', 'branch', 'rev-parse', 'ls-files', 'blame', 'describe', 'tag']);
const GIT_SAFE_GLOBALS = new Set(['--no-pager', '-P', '-p', '--paginate', '--no-optional-locks', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-replace-objects', '--no-advice']);
// git subcommands that run a command they are given (bisect run, rebase -x, submodule foreach, difftool --extcmd, a
// configured editor or alias, hooks). Their arguments are checked like an exec wrapper's.
const GIT_RUNNERS = new Set(['bisect', 'rebase', 'submodule', 'filter-branch', 'filter-repo', 'difftool', 'mergetool', 'config', 'hook', 'for-each-repo', 'daemon', 'instaweb', 'send-email']);
// Options (long names; git accepts any unambiguous prefix) that run a command, and those that only stop git from
// counting as non-executing (a configured external diff, text conversion or editor).
const GIT_RUNNING_LONG = ['exec', 'upload-pack', 'receive-pack', 'open-files-in-pager', 'extcmd'];
const GIT_UNSAFE_LONG = ['ext-diff', 'textconv', 'edit', 'tool'];
// The short option that runs a command, per subcommand (grep -O, fetch -u, rebase -x).
const GIT_SHORT_RUNNERS = { grep: 'O', fetch: 'u', pull: 'u', clone: 'u', 'ls-remote': 'u', rebase: 'x' };

// The git tier for the credential rule: "safe" (non-executing), "broad" (it runs a command it is given: every word
// may be a program, like an exec wrapper) or "narrow" (an unknown program: its literal riverwright words are checked).
// alias: the body of an alias of that name, when one is found.
function gitTier(args, ctx, pre) {
  let safe = !pre.some((w) => /^GIT_\w*=/i.test(nameOf(w)));
  let broad = false;
  let dirs = [...ctx.opts.cwds];
  let i = 0;
  for (; i < args.length; i += 1) {
    const w = args[i];
    const t = nameOf(w);
    if (t === '-c' || t === '--config-env') { broad = true; i += 1; continue; }
    if (/^-c./.test(t) || t.startsWith('--config-env=')) { broad = true; continue; }
    if (t === '-C') {
      const d = args[i + 1];
      if (!d || isDynamic(d)) safe = false;
      else dirs = dirs.map((x) => path.resolve(x, nameOf(d)));
      i += 1;
      continue;
    }
    if (GIT_SAFE_GLOBALS.has(t)) continue;
    if (t.startsWith('-')) { safe = false; if (GIT_VALUE_OPTS.has(t)) i += 1; continue; }
    break;
  }
  const subWord = args[i];
  if (!subWord) return { tier: broad ? 'broad' : safe ? 'safe' : 'narrow' };
  if (isDynamic(subWord) || /[*?[{}]/.test(shapeOf(subWord))) return { tier: 'broad' };
  const sub = nameOf(subWord).toLowerCase();
  const rest = args.slice(i + 1);
  const end = rest.findIndex((w) => nameOf(w) === '--');
  const opts = (end === -1 ? rest : rest.slice(0, end)).map(nameOf);
  for (const t of opts) {
    if (t.startsWith('--')) {
      const name = t.slice(2).split('=')[0].toLowerCase();
      if (!name) continue;
      if (GIT_RUNNING_LONG.some((o) => o.startsWith(name))) { broad = true; safe = false; }
      else if (GIT_UNSAFE_LONG.some((o) => o.startsWith(name))) safe = false;
    } else if (/^-[^-]/.test(t) && /[xOue]/.test(t.slice(1))) {
      safe = false;
      if (GIT_SHORT_RUNNERS[sub] && t.slice(1).includes(GIT_SHORT_RUNNERS[sub])) broad = true;
    }
  }
  if (GIT_RUNNERS.has(sub)) broad = true;
  // The repository's aliases, for every directory the command may be in (F2).
  for (const dir of ctx.opts.cwds.overflow ? [] : dirs) {
    const aliases = gitAliases(ctx, dir);
    if (aliases === null) safe = false;
    else if (aliases.has(sub)) return { tier: 'broad', alias: aliases.get(sub) };
  }
  if (ctx.opts.cwds.overflow) safe = false;
  if (broad) return { tier: 'broad' };
  const listing = sub !== 'tag' || !rest.length || opts.some((t) => t === '--list' || /^-[a-z]*l/i.test(t));
  return { tier: safe && GIT_SAFE.has(sub) && listing ? 'safe' : 'narrow' };
}

// git configuration, read (never written) only to find aliases: the repository's config (found from the working
// directory or -C, through a linked worktree's commondir), the user's global config, the system config, included
// files, and GIT_CONFIG_COUNT / GIT_CONFIG_PARAMETERS. Returns a Map of alias name to body, or null when a file
// cannot be read (then git is not trusted). The user's and system's part is read once per command; the repository's
// part is cached per directory.
const GIT_CONFIG_MAX = 1024 * 1024;
const GIT_POINTER_MAX = 64 * 1024;

function gitAliases(ctx, dir) {
  const cache = ctx.opts.gitCache;
  if (cache.has(dir)) return cache.get(dir);
  const env = ctx.opts.env;
  if (ctx.opts.gitShared === undefined) {
    // The user's global config, the system config, their includes and GIT_CONFIG_COUNT: the same for every directory.
    let shared = new Map();
    try {
      const seen = new Set();
      for (const f of gitUserConfigs(env, ctx.opts.platform)) {
        if (!readGitConfig(f, shared, env, 0, seen)) { shared = null; break; }
      }
      if (shared && !gitEnvAliases(env, shared, seen)) shared = null;
    } catch {
      shared = null;
    }
    ctx.opts.gitShared = shared;
  }
  let out = ctx.opts.gitShared && new Map(ctx.opts.gitShared);
  if (out) {
    try {
      const seen = new Set();
      for (const f of gitRepoConfigs(dir, env)) {
        if (!readGitConfig(f, out, env, 0, seen)) { out = null; break; }
      }
    } catch {
      out = null;
    }
  }
  cache.set(dir, out);
  return out;
}

function gitRepoConfigs(dir, env) {
  if (env.GIT_DIR) return gitDirConfigs(path.resolve(dir, env.GIT_DIR));
  let d = path.resolve(dir);
  for (let n = 0; n < 256; n += 1) {
    const dotgit = path.join(d, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch (err) { if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err; }
    if (st?.isDirectory()) return gitDirConfigs(dotgit);
    if (st) {
      // A .git file names the git directory; anything else there (a FIFO, a device) is unreadable.
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readBounded(dotgit, GIT_POINTER_MAX) ?? '');
      if (!m) throw new Error('a .git file that names no git directory');
      return gitDirConfigs(path.resolve(d, m[1]));
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return [];
}

function gitDirConfigs(gitDir) {
  const common = readBounded(path.join(gitDir, 'commondir'), GIT_POINTER_MAX);
  const shared = common === null ? gitDir : path.resolve(gitDir, common.trim());
  return [path.join(shared, 'config'), path.join(gitDir, 'config.worktree')];
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

function gitUserConfigs(env, platform) {
  const home = env.HOME || env.USERPROFILE || null;
  const files = [];
  if (env.GIT_CONFIG_GLOBAL) files.push(env.GIT_CONFIG_GLOBAL);
  else {
    const xdg = env.XDG_CONFIG_HOME || (home && path.join(home, '.config'));
    if (xdg) files.push(path.join(xdg, 'git', 'config'));
    if (home) files.push(path.join(home, '.gitconfig'));
  }
  if (env.GIT_CONFIG) files.push(env.GIT_CONFIG);
  if (!truthy(env.GIT_CONFIG_NOSYSTEM)) {
    if (env.GIT_CONFIG_SYSTEM) files.push(env.GIT_CONFIG_SYSTEM);
    else {
      files.push('/etc/gitconfig', '/opt/homebrew/etc/gitconfig', '/usr/local/etc/gitconfig', '/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig', '/Applications/Xcode.app/Contents/Developer/usr/share/git-core/gitconfig');
      if (platform === 'win32') for (const pf of new Set([env.ProgramFiles, env.PROGRAMFILES, 'C:\\Program Files'].filter(Boolean))) files.push(path.join(pf, 'Git', 'etc', 'gitconfig'));
    }
  }
  return files;
}

const gitUnquote = (v) => String(v).replace(/\s+[#;].*$/, '').trim().replace(/^"([\s\S]*)"$/, '$1').replace(/\\(.)/g, '$1');

// Reads one config file's aliases into `out` and follows its includes (every includeIf is followed, whatever its
// condition). A missing file is fine; any other failure (including a file that is not a regular file) returns false.
function readGitConfig(file, out, env, depth, seen) {
  if (depth > 10 || seen.size > 64) return false;
  const abs = path.resolve(file);
  if (seen.has(abs)) return true;
  seen.add(abs);
  let text;
  try {
    text = readBounded(abs, GIT_CONFIG_MAX);
  } catch {
    return false;
  }
  if (text === null) return true;
  let section = '';
  let sub = null;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    const h = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/.exec(line);
    if (h) {
      section = h[1].toLowerCase();
      sub = h[2] ?? null;
      const dot = section.indexOf('.');
      if (dot !== -1) { sub = section.slice(dot + 1); section = section.slice(0, dot); }
      if (section === 'alias' && sub !== null) out.set(sub.toLowerCase(), '');
      line = h[3].trim();
    }
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = gitUnquote(m[2] ?? '');
    if (section === 'alias' && sub === null) out.set(key, value);
    if ((section === 'include' || section === 'includeif') && key === 'path' && value) {
      const home = env.HOME || env.USERPROFILE || '';
      const p = value.startsWith('~/') ? path.join(home, value.slice(2)) : path.resolve(path.dirname(abs), value);
      if (!readGitConfig(p, out, env, depth + 1, seen)) return false;
    }
  }
  return true;
}

function gitEnvAliases(env, out, seen) {
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  if (n > 0) {
    if (n > 1000) return false;
    for (let i = 0; i < n; i += 1) {
      const key = String(env[`GIT_CONFIG_KEY_${i}`] ?? '').toLowerCase();
      if (key.startsWith('alias.')) out.set(key.slice(6), String(env[`GIT_CONFIG_VALUE_${i}`] ?? ''));
      if (/^include(if)?\..*path$/.test(key) && !readGitConfig(String(env[`GIT_CONFIG_VALUE_${i}`] ?? ''), out, env, 1, seen)) return false;
    }
  }
  for (const m of String(env.GIT_CONFIG_PARAMETERS ?? '').matchAll(/alias\.([^'=\s]+)/gi)) out.set(m[1].toLowerCase(), '');
  if (/include/i.test(String(env.GIT_CONFIG_PARAMETERS ?? ''))) return false;
  return true;
}

// pre: the words before the program (assignments, env and wrapper words).
function nonExecuting(prog, args, ctx, pre = []) {
  if (!NON_EXECUTING.has(prog)) return false;
  if (prog === 'git') return gitTier(args, ctx, pre).tier === 'safe';
  // ripgrep runs a --pre preprocessor with each file name as its argument, and a --hostname-bin program; a config
  // file named by RIPGREP_CONFIG_PATH can add either. Its long options cannot be abbreviated.
  if (prog === 'rg') return !pre.some((w) => /^RIPGREP_CONFIG_PATH=/.test(nameOf(w))) && !args.some((w) => /^--(pre|hostname-bin)(=|$)/.test(nameOf(w)));
  if (prog === 'find') return !args.some((w) => FIND_EXEC.includes(nameOf(w)));
  if (prog === 'sed') { const s = toolScripts(prog, args); return s !== null && !s.some((x) => /[ewW]/.test(x)); }
  if (/awk$/.test(prog)) { const s = toolScripts(prog, args); return s !== null && !s.some((x) => /system|\|/.test(x)); }
  return true;
}

// Wrappers that run the rest of their words directly (no shell): the program is the word after their options.
// watch and flock are left out: they can run their arguments through a shell (see JOINERS).
const PASS_WRAPPERS = new Set(Object.keys(WRAPPERS).filter((p) => p !== 'watch' && p !== 'flock'));
// Programs that join their arguments into a command line for a shell (ssh's remote command, watch, su -c,
// script -c, tmux and screen commands, expect -c): the joined text is lexed and checked too.
const JOINERS = new Set(['ssh', 'watch', 'su', 'runuser', 'script', 'tmux', 'screen', 'expect', 'flock']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

// A path-shaped program word that is the launcher (its realpath is one of the launcher files), whatever it is
// called: checked before any list trusts its name (./bin/grep -> riverwright is riverwright, not grep).
const isLauncherPath = (w, ctx) => Boolean(w) && !isDynamic(w) && /[\\/]/.test(nameOf(w)) && resolvesToLauncher(nameOf(w), ctx);
// A program word whose name can be trusted for the lists: not a path with a variable directory ("$D/grep" can be
// any file named grep, including a link to the launcher).
const trustsName = (w) => !(isDynamic(w) && /[\\/]/.test(nameOf(w)));

// The index of the program: past leading keywords, assignments, env (its options and assignments) and the
// pass-through wrappers. words.length when there is none (env -S, a lone assignment). A path-shaped word that is the
// launcher, or that has a variable directory, is the program whatever its name.
function programIndex(ws, ctx) {
  let i = 0;
  let wrappers = 0;
  while (i < ws.length) {
    const w = ws[i];
    const t = nameOf(w);
    if ((!w.quoted && KEYWORDS.has(t)) || ASSIGNMENT.test(t)) { i += 1; continue; }
    if (/[\\/]/.test(t) && (!trustsName(w) || isLauncherPath(w, ctx))) break;
    const p = programName(w);
    if (p === 'env') {
      i += 1;
      while (i < ws.length) {
        const u = nameOf(ws[i]);
        if (u === '-S' || u === '--split-string' || u.startsWith('--split-string=')) return ws.length;
        if (['-u', '--unset', '-C', '--chdir'].includes(u)) { i += 2; continue; }
        if ((u.startsWith('-') && u !== '-') || ASSIGNMENT.test(u)) { i += 1; continue; }
        break;
      }
      continue;
    }
    if (p !== null && PASS_WRAPPERS.has(p) && wrappers < 16) {
      wrappers += 1;
      // The guard keeps a long wrapper chain linear; past it, the wrapper is treated as an unknown program.
      const rest = ws.slice(i + 1, i + 1 + 64);
      i += 1 + wrapperSkip(p, rest);
      if (p === 'command' && rest.some((x) => ['-v', '-V'].includes(nameOf(x)))) return ws.length;
      continue;
    }
    break;
  }
  return i;
}

// Where xargs's own options end and the command it runs starts.
function xargsCommandIndex(args) {
  for (let i = 0; i < args.length; i += 1) {
    const t = nameOf(args[i]);
    if (['-I', '-n', '-L', '-P', '-s', '-d', '-E', '-a'].includes(t)) { i += 1; continue; }
    if (t.startsWith('-')) continue;
    return i;
  }
  return args.length;
}

// Does the command run anything it is given (so quoted text and here-documents in it could be commands)?
function isExecuting(ws, ctx) {
  const k = programIndex(ws, ctx);
  if (k >= ws.length) return true;
  if (isLauncherPath(ws[k], ctx) || !trustsName(ws[k])) return true;
  const p = programName(ws[k]);
  if (p === null) return true;
  const args = ws.slice(k + 1);
  if (p === 'xargs') return isExecuting(args.slice(xargsCommandIndex(args)), ctx);
  return !nonExecuting(p, args, ctx, ws.slice(0, k));
}

// Text that a program will run as a command, lexed and checked with this rule. Only a credential verdict counts.
function payload(text, ctx) {
  if (!PAYLOAD_HINT.test(text)) return null;
  const v = classifyScript(text, ctx.deeper(false, true));
  return isCredential(v) ? v : null;
}

// A "!" alias body (git runs it with a shell): checked as a command, and denied when it runs riverwright (the
// arguments after the alias on the command line are riverwright's).
function gitAliasBody(body, ctx) {
  const code = body.replace(/^!/, '');
  const v = payload(code, ctx);
  if (v) return v;
  if (body.startsWith('!')) {
    const first = lex(code, ctx.opts.lex).commands[0];
    const ws = first ? first.words.slice(programIndex(first.words, ctx)) : [];
    if (ws.length && mayBeRiverwright(ws[0], ctx)) return credentialVerdict('a git "!" alias runs riverwright (the arguments after it could be "credential")');
  }
  return null;
}

// git runs -c values that hold commands (alias.x=!..., core.pager, core.editor, core.sshCommand) and any "!" alias
// it is given (git config alias.x '!...'). An alias that runs riverwright gets the command line's arguments after it.
function gitPayloads(args, ctx) {
  for (let i = 0; i < args.length; i += 1) {
    const t = nameOf(args[i]);
    let body = null;
    if (t === '-c' && args[i + 1]) { const v = nameOf(args[i + 1]); body = v.slice(v.indexOf('=') + 1); i += 1; }
    else if (t.startsWith('-c') && t.length > 2) body = t.slice(t.indexOf('=') + 1);
    else if (t.startsWith('!')) body = t;
    else {
      // A command-running option with its value attached (--upload-pack=..., -O..., -x...).
      const m = /^(?:--[a-z-]+=|-[xOu])(.+)$/.exec(t);
      if (m && (/^-[xOu]/.test(t) || GIT_RUNNING_LONG.some((o) => o.startsWith(t.slice(2, t.indexOf('=')))))) body = m[1];
    }
    if (body === null) continue;
    const v = gitAliasBody(body, ctx);
    if (v) return v;
  }
  return null;
}

// R28: programs that run a program named among their arguments. sudo, env, nice, nohup, timeout and the other
// modelled wrappers are looked through (programIndex), so the program they run is in program position; for the
// others every variable, glob or brace word in their arguments may be that program.
const EXEC_WRAPPERS = new Set(['script', 'xvfb-run', 'rlwrap', 'firejail', 'gdb', 'chroot', 'pkexec', 'runuser', 'systemd-run', 'faketime', 'winpty', 'valgrind', 'unshare', 'nohup', 'timeout', 'stdbuf', 'setsid', 'flock', 'sudo', 'doas', 'env', 'nice', 'ionice', 'chrt', 'taskset', 'strace', 'ltrace', 'time', 'watch', 'xargs', 'parallel',
  'arch', 'sandbox-exec', 'nsenter', 'sg', 'prlimit', 'numactl', 'cpulimit', 'entr', 'direnv', 'dotenv', 'cross-env']);
// JavaScript runtimes (and the script runners like them) run a script operand and package runners run a package: that
// word stands where a program does. So does the first operand of a shell or an interpreter (bash "$S", python "$S").
const JS_RUNTIMES = new Set(['node', 'nodejs', 'bun', 'tsx', 'ts-node', 'nodemon']);
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx']);
// Programs whose subcommand runs the program named after it (npm exec, uv run, bundle exec, op run, mise exec, ...).
const RUNNER_SUBCOMMANDS = {
  npm: ['exec', 'x'], pnpm: ['exec', 'dlx', 'run'], yarn: ['dlx', 'exec', 'run'], bun: ['x', 'run', 'exec'], deno: ['run', 'x'],
  uv: ['run'], poetry: ['run'], bundle: ['exec'], mise: ['exec', 'x'], op: ['run'], doppler: ['run'],
};
// yarn, pnpm and deno also run a bin or script named as their first operand (yarn "$X"), so a first operand that is not
// one of their subcommands stands where a program does.
const BARE_RUNNERS = new Set(['yarn', 'pnpm', 'deno']);
// Options known to take no value, so the plain word after one is the operand (npx -y prettier "$A" "$B"). -r is one
// only for the runners (pnpm -r, deno run -r); for a JavaScript runtime it loads a module (tsx -r ./setup.cjs).
const FLAG_OPTIONS = new Set(['-y', '--yes', '-q', '--quiet', '-s', '--silent', '-r', '--recursive', '-A', '--allow-all', '--no-warnings', '--test', '--watch', '--enable-source-maps', '--bun']);
const isPlainWord = (w) => !isDynamic(w) && !/[*?[{}]/.test(shapeOf(w)) && !EXTGLOB.test(shapeOf(w));

// Does this option word end the search for a program operand (it gives inline code or names the program itself)?
// 'code': stop; 'next': the next word is the program (python -m, pwsh -File); 'value': the next plain word may be its
// value; 'flag': it takes no value.
function optionKind(prog, spec, t) {
  if (SHELLS.has(prog)) {
    if (prog === 'pwsh' || prog === 'powershell') {
      if (/^-(c|co|com|comm|comma|comman|command|e|ec|en|enc\w*)$/i.test(t)) return 'code';
      if (/^-(f|fi|fil|file)$/i.test(t)) return 'next';
      return t.includes(':') ? 'flag' : 'value';
    }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) return 'code';
    return /^--(rcfile|init-file)$/.test(t) || /^[-+][oO]$/.test(t) ? 'value' : 'flag';
  }
  if (spec) {
    if (spec.code.some((f) => t === f || (f.startsWith('--') ? t.startsWith(`${f}=`) : t.startsWith(f) && f.length === 2))) return 'code';
    if (spec.module && t === spec.module) return 'next';
    if (spec.values.includes(t)) return 'value';
    if (/^-[A-Za-z]+$/.test(t)) return 'flag';
  }
  if (t.includes('=') || (FLAG_OPTIONS.has(t) && !(t === '-r' && JS_RUNTIMES.has(prog)))) return 'flag';
  return 'value';
}

// The arguments (indices) that stand where a program does for a JavaScript runtime, a package runner, a shell or an
// interpreter: every variable, glob or brace word up to the first plain operand, that operand, and the word after "--".
// A plain word right after an option that may take a value (npx -p cowsay, node -r ./h.cjs, deno run --config f) may be
// that value, so it is marked and the search goes on to the next plain word.
function programOperands(prog, args) {
  const out = new Set();
  const spec = INTERPRETERS.find((s) => s.test.test(prog) && !s.subcode);
  let start = null;
  if (JS_RUNTIMES.has(prog) || PACKAGE_RUNNERS.has(prog) || SHELLS.has(prog) || spec) start = 0;
  if (Object.hasOwn(RUNNER_SUBCOMMANDS, prog)) {
    const s = args.findIndex((w) => !nameOf(w).startsWith('-'));
    if (s !== -1 && RUNNER_SUBCOMMANDS[prog].includes(nameOf(args[s]).toLowerCase())) start = s + 1;
    else if (BARE_RUNNERS.has(prog)) start = 0;
  }
  if (start === null) return out;
  let afterValueOption = false;
  for (let j = start; j < args.length; j += 1) {
    const w = args[j];
    const t = nameOf(w);
    if (t === '--') { if (j + 1 < args.length) out.add(j + 1); break; }
    if (!isPlainWord(w)) { out.add(j); afterValueOption = false; continue; }
    if (t.startsWith('-') && t !== '-') {
      const kind = optionKind(prog, spec, t);
      if (kind === 'code') break;
      if (kind === 'next') { if (j + 1 < args.length) out.add(j + 1); break; }
      afterValueOption = kind === 'value';
      continue;
    }
    out.add(j);
    if (!afterValueOption) break;
    afterValueOption = false;
  }
  return out;
}

// A literal riverwright word (R28): its last path segment, or the value of a KEY=VALUE word or a "!" alias, names
// riverwright with no variable, glob or brace in it; or a path that resolves to the launcher files.
function namesRiverwright(w, ctx) {
  const s = shapeOf(w);
  const plain = (f) => { const seg = f.split(/[\\/]/).pop(); return !/[*?[\]{}]/.test(seg) && !EXTGLOB.test(seg); };
  const forms = [s];
  const eq = s.indexOf('=');
  if (eq !== -1) forms.push(s.slice(eq + 1).replace(/^!/, ''));
  if (s.startsWith('!')) forms.push(s.slice(1));
  if (forms.some((f) => plain(f) && formCouldBeRiverwright(f, false))) return true;
  return !isDynamic(w) && resolvesToLauncher(nameOf(w), ctx);
}

// The slot rule over one command's words. Returns a credential verdict or null. parenNext: the command was cut
// short by "(" (fish and PowerShell evaluate a parenthesised argument, so its output is the next word).
// force: check every word even when the program is a non-executing tool (its output is about to be run), and let
// any word be a program.
function credentialSlots(ws, ctx, depth = 0, parenNext = false, force = false) {
  if (!ws.length || depth > 8) return null;
  // Assignments before the program can hold a command the program runs (EDITOR, PAGER, GIT_SSH_COMMAND) or a
  // command run later from the variable (x="rw credential setup"; $x).
  for (const w of ws) {
    const t = nameOf(w);
    if (!w.quoted && KEYWORDS.has(t)) continue;
    if (!ASSIGNMENT.test(t)) break;
    const v = payload(t.slice(t.indexOf('=') + 1), ctx);
    if (v) return v;
  }
  const k = programIndex(ws, ctx);
  const progWord = ws[k];
  const launcher = isLauncherPath(progWord, ctx);
  // A launcher path has no name to trust; a variable directory makes the name untrustworthy for the allow lists.
  const prog = k < ws.length && !launcher ? programName(progWord) : undefined;
  const trusted = prog != null && trustsName(progWord);
  const args = ws.slice(k + 1);
  const pre = ws.slice(0, k);
  let broadArgs = force || (prog != null && EXEC_WRAPPERS.has(prog));
  if (prog === 'git') {
    const v = gitPayloads(args, ctx);
    if (v) return v;
    const g = trusted ? gitTier(args, ctx, pre) : { tier: 'broad' };
    if (g.alias) { const a = gitAliasBody(g.alias, ctx); if (a) return a; }
    if (g.tier === 'safe' && !force) return null;
    if (g.tier === 'broad') broadArgs = true;
  } else if (trusted && !force && nonExecuting(prog, args, ctx, pre)) return null;
  if (prog === 'xargs') return credentialSlots(args.slice(xargsCommandIndex(args)), ctx, depth + 1, false, force);
  if (prog === 'find') {
    // Only the commands find runs; its own arguments are paths and tests.
    for (let i = 0; i < args.length; i += 1) {
      if (!FIND_EXEC.includes(nameOf(args[i]))) continue;
      let end = i + 1;
      while (end < args.length && ![';', '+'].includes(nameOf(args[end]))) end += 1;
      const v = credentialSlots(args.slice(i + 1, end), ctx, depth + 1);
      if (v) return v;
      i = end;
    }
    if (!force) return null;
  }
  if (prog === 'rg') {
    // rg --pre PROG runs PROG with each file name as its first argument: a file can be named "credential".
    for (let i = 0; i < args.length; i += 1) {
      const t = nameOf(args[i]);
      const pp = t === '--pre' ? args[i + 1] : t.startsWith('--pre=') ? { ...args[i], value: t.slice(6), shape: shapeOf(args[i]).slice(6) } : null;
      if (pp && mayBeRiverwright(pp, ctx)) return credentialVerdict('rg --pre runs riverwright with each file name as its subcommand (a file can be named "credential")');
    }
  }
  if (prog === 'sed' || /awk$/.test(prog ?? '')) {
    // A sed e command or an awk system() that names riverwright and credential.
    const scripts = toolScripts(prog, args) ?? [];
    if (scripts.some((s) => inlineCredential(s))) return credentialVerdict(CREDENTIAL_DETAIL);
  }
  if (prog === 'start-process' || prog === 'saps') {
    if (args.some((w) => mayBeRiverwright(w, ctx))) return credentialVerdict('Start-Process runs riverwright with an argument list (it could hold "credential")');
  }
  // Which words are checked: for a riverwright program (literal, or a path to the launcher), only the words up to it
  // (its own arguments are riverwright's); for anything else, every word, under the R28 limits below.
  const last = k < ws.length && (launcher || isLiteralRiverwright(progWord)) ? k : ws.length - 1;
  // R28: a variable, glob or brace word can be the program only where a program stands: program position, the
  // arguments of an exec wrapper (or of a git subcommand that runs commands, or of text about to be run), the script
  // of a JavaScript runtime or the package of a runner. Elsewhere only a literal riverwright word counts.
  const operands = prog != null ? programOperands(prog, args) : new Set();
  // slot[j]: the slot starting at word j is, could be, or could vanish into "credential". Filled right to left.
  const slot = new Array(ws.length + 1).fill(false);
  slot[ws.length] = parenNext;
  for (let j = ws.length - 1; j >= 0; j -= 1) slot[j] = couldBeCredential(ws[j]) || (mayVanish(ws[j]) && slot[j + 1]);
  for (let i = 0; i <= last; i += 1) {
    if (holdsCredential(ws[i], ctx)) return credentialVerdict(SLOT_DETAIL);
    if (!slot[i + 1]) continue;
    const anywhere = i === k || force || (broadArgs && i > k) || operands.has(i - k - 1);
    if (anywhere ? mayBeRiverwright(ws[i], ctx) : namesRiverwright(ws[i], ctx)) return credentialVerdict(SLOT_DETAIL);
  }
  if (prog === 'ssh') {
    // ssh runs its command options through a shell, and the remote command line through the remote shell: each is
    // checked as a command whose first word stands where a program does (ssh host "$X" credential).
    const { options, remote } = sshParts(args);
    const texts = [...options.filter(([key]) => SSH_COMMAND_OPTIONS.has(key)).map(([, v]) => v), remote.map(nameOf).join(' ')];
    for (const text of texts) {
      const v = text.trim() ? classifyScript(text, ctx.deeper(false, true)) : null;
      if (isCredential(v)) return v;
    }
  } else if (prog && (JOINERS.has(prog) || EVALUATORS.has(prog))) {
    const v = payload(args.map((w) => nameOf(w)).join(' '), ctx);
    if (v) return v;
  }
  if (force) {
    for (const w of ws) { const v = /\s/.test(w.value) ? payload(w.value, ctx) : null; if (v) return v; }
  }
  return null;
}

// F1 (Task 17): node, bun and deno can run riverwright with its arguments shifted. A script read from stdin (node -
// ... < riverwright.mjs, node /dev/stdin ..., cat riverwright.mjs | node - ...) and a launcher loaded before the
// script (--import, --require, -r, --loader, --experimental-loader, bun's --preload, or the same in NODE_OPTIONS)
// see the words after the script operand as their arguments. So when the code riverwright runs comes from such a
// place, every word after the script operand is a slot: one that is, or could be, "credential" is denied.
const STDIN_RUNTIMES = new Set(['node', 'nodejs', 'bun', 'deno']);
const PRELOAD_OPTS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--preload']);
const PRELOAD_ATTACHED = /^(?:--(?:import|require|loader|experimental-loader|preload)=|-r(?=.))([\s\S]*)$/;
const RUNTIME_CODE = new Set(['-e', '--eval', '-p', '--print']);

// A file a runtime reads code from: its name, a path that resolves to the launcher files (a bare name is a file here,
// not a PATH lookup), or a variable or pattern that could be either.
function codeFileIsRiverwright(w, ctx) {
  if (!w) return false;
  if (isDynamic(w) || !isPlainWord(w)) return mayBeRiverwright(w, ctx);
  const v = nameOf(w);
  if (formCouldBeRiverwright(shapeOf(w), false)) return true;
  return resolvesToLauncher(/[\\/]/.test(v) || path.isAbsolute(v) ? v : `./${v}`, ctx);
}

// A NODE_OPTIONS value that preloads a riverwright file (or is a variable that could).
function nodeOptionsPreload(w, ctx) {
  if (isDynamic(w)) return true;
  const toks = nameOf(w).slice(nameOf(w).indexOf('=') + 1).split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i += 1) {
    const m = PRELOAD_ATTACHED.exec(toks[i]);
    const value = m ? m[1] : PRELOAD_OPTS.has(toks[i]) ? toks[i + 1] : null;
    if (value && codeFileIsRiverwright({ value: value.replace(/^["']|["']$/g, ''), shape: value.replace(/^["']|["']$/g, ''), dynamic: false, subs: [] }, ctx)) return true;
  }
  return false;
}

function runtimeCredential(cmd, ctx) {
  const ws = cmd.words;
  const k = programIndex(ws, ctx);
  if (k >= ws.length || isLauncherPath(ws[k], ctx)) return null;
  const prog = programName(ws[k]);
  if (!STDIN_RUNTIMES.has(prog)) return null;
  const args = ws.slice(k + 1);
  const spec = INTERPRETERS.find((s) => s.test.test(prog));
  let loads = ws.slice(0, k).some((w) => /^NODE_OPTIONS=/.test(nameOf(w)) && nodeOptionsPreload(w, ctx));
  let j = 0;
  if (prog === 'deno' || prog === 'bun') {
    const s = args.findIndex((w) => !nameOf(w).startsWith('-'));
    if (s !== -1 && nameOf(args[s]) === 'run') j = s + 1;
  }
  let script = -1;
  for (; j < args.length; j += 1) {
    const w = args[j];
    const t = nameOf(w);
    if (t === '--') { script = j + 1 < args.length ? j + 1 : -1; break; }
    if (t === '-' || !t.startsWith('-')) { script = j; break; }
    const m = PRELOAD_ATTACHED.exec(t);
    if (m) { if (codeFileIsRiverwright({ ...w, value: m[1], shape: shapeOf(w).slice(t.length - m[1].length) }, ctx)) loads = true; continue; }
    if (PRELOAD_OPTS.has(t)) { if (codeFileIsRiverwright(args[j + 1], ctx)) loads = true; j += 1; continue; }
    // Inline code: its arguments start after the code word.
    if (RUNTIME_CODE.has(t)) { script = j + 1 < args.length ? j + 1 : -1; break; }
    if (spec?.values.includes(t)) { j += 1; continue; }
  }
  const fromStdin = script === -1 || isStdinPath(nameOf(args[script]));
  const stdinIsRiverwright = fromStdin && (cmd.inputs.some((w) => codeFileIsRiverwright(w, ctx))
    || (cmd.stdin === 'pipe' && Boolean(cmd.prev?.words.slice(1).some((w) => codeFileIsRiverwright(w, ctx)))));
  if (!loads && !stdinIsRiverwright) return null;
  const rest = script === -1 ? [] : args.slice(script + 1);
  if (rest.some((w) => couldBeCredential(w))) {
    return credentialVerdict(`${prog} runs riverwright from ${loads ? 'a preloaded module' : 'its standard input'}, so the words after the script operand are its arguments (one is, or could be, "credential")`);
  }
  return null;
}

// R37 (Task 17, F3 redo): "riverwright submit" and "riverwright post" ask the human for the passphrase, so anything
// that changes the process they run in (an environment variable such as NODE_OPTIONS, PATH, BASH_ENV, HTTPS_PROXY or
// HOME; a wrapper such as sudo, env, strace, proxychains, script or expect; node or a shell running the launcher
// script; an earlier export, source, alias or printf -v) could put code the agent chose where the passphrase is typed.
// That list is open-ended, so the rule is an allowlist: submit and post are allowed only as the whole command line, the
// trusted launcher as the program and plain arguments after it (isTrustedPublish, checked before anything else). Every
// other command that could run them is denied everywhere, like the credential rule. The words that could run them are
// found the way the credential rule finds its slot, with "submit" and "post" in place of "credential".
const PUBLISH_SUBCOMMANDS = ['submit', 'post'];
const PUBLISH_DETAIL = (sub) => `${sub ? `"riverwright ${sub}"` : '"riverwright submit" or "riverwright post"'} is allowed only as the whole command line: the installed launcher's own path, then ${sub ?? 'the subcommand'} and its plain arguments, with no variable, wrapper or runtime in front of it and no other command, pipe, redirect or subshell around it. Anything else could load code the agent chose into the process you type your passphrase into. Run it plainly, in your own terminal`;

function couldBePublish(w) {
  if (!w) return false;
  const sh = shapeOf(w);
  return /[{}]/.test(sh) || EXTGLOB.test(sh) || /^@\w/.test(sh) || sh.split(',').some((part) => PUBLISH_SUBCOMMANDS.some((n) => globMatch(part, n)));
}

function publishSlots(ws, ctx, depth = 0) {
  if (!ws.length || depth > 8) return null;
  const k = programIndex(ws, ctx);
  const progWord = ws[k];
  const launcher = isLauncherPath(progWord, ctx);
  const prog = k < ws.length && !launcher ? programName(progWord) : undefined;
  const args = ws.slice(k + 1);
  if (prog != null && trustsName(progWord) && nonExecuting(prog, args, ctx, ws.slice(0, k))) return null;
  // xargs and find -exec: only the commands they run (find's own arguments are paths and tests).
  if (prog === 'xargs') return publishSlots(args.slice(xargsCommandIndex(args)), ctx, depth + 1);
  if (prog === 'find') {
    for (let i = 0; i < args.length; i += 1) {
      if (!FIND_EXEC.includes(nameOf(args[i]))) continue;
      let end = i + 1;
      while (end < args.length && ![';', '+'].includes(nameOf(args[end]))) end += 1;
      const v = publishSlots(args.slice(i + 1, end), ctx, depth + 1);
      if (v) return v;
      i = end;
    }
    return null;
  }
  const broadArgs = prog != null && EXEC_WRAPPERS.has(prog);
  const operands = prog != null ? programOperands(prog, args) : new Set();
  const last = k < ws.length && (launcher || isLiteralRiverwright(progWord)) ? k : ws.length - 1;
  const slot = new Array(ws.length + 1).fill(false);
  for (let j = ws.length - 1; j >= 0; j -= 1) slot[j] = couldBePublish(ws[j]) || (mayVanish(ws[j]) && slot[j + 1]);
  for (let i = 0; i <= last; i += 1) {
    if (!slot[i + 1]) continue;
    const anywhere = i === k || (broadArgs && i > k) || operands.has(i - k - 1);
    if (anywhere ? mayBeRiverwright(ws[i], ctx) : namesRiverwright(ws[i], ctx)) {
      const sub = ws.slice(i + 1).find((w) => couldBePublish(w));
      const named = PUBLISH_SUBCOMMANDS.find((n) => n === nameOf(sub).toLowerCase());
      return outward('riverwright-publish-env', PUBLISH_DETAIL(named));
    }
  }
  return null;
}

// Programs that run commands read from stdin (besides the shells and interpreters classifyStdinCode reads), when
// they are given no command of their own.
const STDIN_RUNNERS = new Set(['at', 'batch', 'crontab', 'ssh', 'su', 'runuser', 'script', 'expect']);

// A command line that runs a shell or an interpreter reading its program from stdin, past any wrappers (sh, bash -s,
// sudo bash, nice -n 5 sh -s, python -, node /dev/stdin).
function bareStdinCommand(words, ctx) {
  const ws = words.slice(programIndex(words, ctx));
  const p = programName(ws[0]);
  if (p === null) return false;
  const rest = ws.slice(1).map(nameOf);
  const operands = rest.filter((t) => !(t.startsWith('-') && t !== '-'));
  const fromStdin = !operands.length || isStdinPath(operands[0]);
  if (SHELLS.has(p)) return fromStdin && !rest.some((t) => /^-[a-zA-Z]*c/.test(t));
  const spec = INTERPRETERS.find((x) => x.test.test(p));
  return Boolean(spec) && fromStdin && !rest.some((t) => spec.code.some((f) => t === f || t.startsWith(f)));
}
const SSH_VALUE_OPTS = new Set('bcDEeFIiJLlmOopQRSWwB'.split(''));

// ssh's own options (with their values), its host and the remote command words. -o values come as [key, value].
function sshParts(args) {
  const options = [];
  let i = 0;
  for (; i < args.length; i += 1) {
    const t = nameOf(args[i]);
    if (t === '--') { i += 1; break; }
    if (t.startsWith('-') && t.length > 1) {
      // A cluster: the first option that takes a value takes the rest of the word or the next word.
      const j = [...t.slice(1)].findIndex((c) => SSH_VALUE_OPTS.has(c));
      if (j === -1) continue;
      const attached = t.slice(j + 2);
      const value = attached || nameOf(args[i + 1] ?? { value: '' });
      if (!attached) i += 1;
      if (t[j + 1] === 'o') { const m = /^\s*([A-Za-z]+)\s*(?:=|\s)\s*([\s\S]*)$/.exec(value); if (m) options.push([m[1].toLowerCase(), m[2]]); }
      continue;
    }
    break;
  }
  return { options, host: args[i], remote: args.slice(i + 1) };
}

// ssh options whose value is a command line run by a local or remote shell.
const SSH_COMMAND_OPTIONS = new Set(['proxycommand', 'localcommand', 'knownhostscommand', 'remotecommand']);

// Does this stdin runner read commands from stdin (rather than from a file, or passing stdin to a command)?
function readsCommandsFromStdin(prog, args, ctx) {
  const ts = args.map(nameOf);
  if (prog === 'at' || prog === 'batch') {
    // -f FILE reads the job from a file, which may be stdin itself (-f /dev/stdin).
    const k = ts.findIndex((t) => /^-[a-zA-Z]*f/.test(t));
    return k === -1 || isStdinPath(ts[k].slice(ts[k].indexOf('f') + 1) || ts[k + 1] || '');
  }
  if (prog === 'crontab') {
    if (ts.some((t) => /^-[a-zA-Z]*[lre]/.test(t))) return false;
    const files = ts.filter((t, i) => !(t.startsWith('-') && t !== '-') && ts[i - 1] !== '-u');
    return !files.length || files.some(isStdinPath);
  }
  if (prog === 'expect') {
    if (ts.some((t) => /^-[a-zA-Z]*c/.test(t))) return false;
    const files = ts.filter((t) => !(t.startsWith('-') && t !== '-'));
    return !files.length || isStdinPath(files[0]) || (ts.includes('-f') && isStdinPath(ts[ts.indexOf('-f') + 1] ?? ''));
  }
  if (prog === 'su' || prog === 'runuser') return !ts.some((t) => /^--(command|session-command)(=|$)/.test(t) || /^-[a-zA-Z]*c/.test(t));
  if (prog === 'script') {
    if (ts.some((t) => /^--command(=|$)/.test(t) || /^-[a-zA-Z]*c/.test(t))) return false;
    const positionals = [];
    for (let i = 0; i < ts.length; i += 1) {
      if (/^-[TIOBEmt]$/.test(ts[i])) { i += 1; continue; }
      if (ts[i].startsWith('-') && ts[i] !== '-') continue;
      positionals.push(i);
    }
    // BSD script FILE COMMAND...: a bare shell or interpreter as the command reads the piped text.
    return positionals.length < 2 || bareStdinCommand(args.slice(positionals[1]), ctx);
  }
  if (prog === 'ssh') {
    const { remote } = sshParts(args);
    if (!remote.length) return true;
    // A remote shell or interpreter with no script reads the commands from stdin too (ssh host sh, ssh host 'bash -s').
    const first = lex(remote.map(nameOf).join(' '), ctx.opts.lex).commands[0];
    return Boolean(first) && bareStdinCommand(first.words, ctx);
  }
  return false;
}

// The command piping into a program that runs its stdin: its output is a command, so its words are checked as if
// it ran them (echo -e 'rw credential setup' | sh, printf '%s\n' rw credential | at now).
function pipedCredential(prev, ctx) {
  return prev && ctx.cred ? credentialSlots(prev.words, ctx, 1, false, true) : null;
}

// A stdin runner fed by a pipe: text the classifier can reproduce exactly is judged as a command; anything else is
// denied (it cannot be read, and the runner would run it).
function stdinRunnerCredential(cmd, ctx) {
  const k = programIndex(cmd.words, ctx);
  const p = k < cmd.words.length && !isLauncherPath(cmd.words[k], ctx) ? programName(cmd.words[k]) : null;
  if (!STDIN_RUNNERS.has(p) || !readsCommandsFromStdin(p, cmd.words.slice(k + 1), ctx)) return null;
  const text = pipedText(cmd.prev);
  if (text === null) return pipedCredential(cmd.prev, ctx) ?? credentialVerdict(`${p} runs commands piped in from another command, and the classifier cannot read them exactly`);
  const v = classifyScript(text, ctx.deeper(true));
  return isCredential(v) ? v : null;
}

// Inline code (node -e, python -c, perl -e, ruby -e, deno eval, bun -e) that starts riverwright with "credential"
// next to it, or near it in an argument list, or that loads the CLI or the credential command directly.
const INLINE_CREDENTIAL = /(?:^|[^\w-])(?:riverwright|rw)(?:\.mjs|\.cmd)?['"`\[\])\s,]+['"`]?credential\b/i;
const INLINE_NEAR = /\briverwright\b[\s\S]{0,160}?\bcredential\b|(?<![\w.-])rw(?:\.cmd|\.mjs)?(?![\w-])[\s\S]{0,160}?\bcredential\b/i;
const INLINE_CLI = /(?:commands[\\/]+credential|lib[\\/]+cli)\.mjs\b/i;
const inlineCredential = (code) => INLINE_CREDENTIAL.test(code) || INLINE_NEAR.test(code) || INLINE_CLI.test(code);

// Every part of a simple command is classified. The first verdict found is kept, except that a
// riverwright-credential verdict replaces any other (it applies everywhere; the others only in scope).
function classifySimple(cmd, ctx) {
  let found = null;
  const take = (v) => { found = prefer(found, v); return isCredential(found); };
  const all = [...cmd.words, ...cmd.redirects, ...cmd.herestrings];
  // Substitutions run before the command itself.
  for (const w of all) {
    for (const sub of w.subs) {
      if (take(classifyScript(sub, ctx.deeper(ctx.strict)))) return found;
    }
  }
  // The riverwright-credential rule (R26) runs before any other rule can settle the verdict.
  if (ctx.cred && take(credentialSlots(cmd.words, ctx, 0, Boolean(cmd.parenNext)))) return found;
  if (ctx.cred && take(runtimeCredential(cmd, ctx))) return found;
  if (ctx.cred) take(publishSlots(cmd.words, ctx));
  if (ctx.cred && cmd.stdin === 'pipe' && take(stdinRunnerCredential(cmd, ctx))) return found;
  // Safety net: text that looks like a command (a quoted argument, a here-document) is checked too. For the
  // credential rule it counts only when the program may run what it is given: the quoted arguments of grep, echo
  // or git commit -m are text, never commands.
  const runs = ctx.cred && isExecuting(cmd.words, ctx);
  if (ctx.depth < 4) {
    const inner = ctx.deeper(false, runs);
    for (const w of all) {
      if (/\s/.test(w.value) && take(classifyScript(w.value, inner))) return found;
    }
    for (const h of cmd.heredocs) { if (take(classifyScript(h.text, inner))) return found; }
  } else if (runs && [...all.map((w) => w.value), ...cmd.heredocs.map((h) => h.text)].some((v) => /\s/.test(v) && PAYLOAD_HINT.test(v) && mentionsCredential(v))) {
    return credentialVerdict('the command nests too deeply to check, and it mentions "credential"');
  }
  let i = 0;
  while (i < cmd.words.length) {
    const w = cmd.words[i];
    const t = nameOf(w);
    if (!w.quoted && KEYWORDS.has(t)) { i += 1; continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(t);
    if (m) { take(checkEnvName(m[1])); i += 1; continue; }
    break;
  }
  if (i < cmd.words.length && take(classifyInvocation(cmd.words.slice(i), cmd, ctx))) return found;
  // A git or gh word anywhere later in the command (sudo -u x git push, find -exec, echo ... | sh).
  for (let k = i + 1; k < cmd.words.length && !found; k += 1) {
    const w = cmd.words[k];
    if (isDynamic(w)) continue;
    const b = base(nameOf(w));
    const lenient = ctx.deeper(false);
    take(b === 'git' ? classifyGit(cmd.words.slice(k + 1), lenient) : b === 'gh' ? classifyGh(cmd.words.slice(k + 1), lenient) : null);
  }
  return found;
}

// cred: whether the riverwright-credential rule applies here. It is off only inside text that a non-executing
// tool merely reads (grep "rw credential" docs), which is still checked for the other rules.
function makeCtx(depth, strict, budget, opts, cred = true) {
  return { depth, strict, budget, opts, cred, deeper: (s, c = cred) => makeCtx(depth + 1, s, budget, opts, c) };
}

function classifyScript(text, ctx) {
  const s = String(text);
  ctx.budget.used += s.length;
  if (ctx.depth > MAX_DEPTH || ctx.budget.used > MAX_WORK) {
    if (ctx.cred && mentionsCredential(s)) return credentialVerdict('the command nests too deeply to check, and it mentions "credential"');
    // Past the budget the text is not lexed, so a riverwright word with a variable, substitution, glob or brace after it
    // (rw "$C" setup) is denied too: that later word could be "credential".
    const rw = ctx.cred ? RIVERWRIGHT_TEXT.exec(s) : null;
    if (rw && /[$`*?[{}%@]/.test(s.slice(rw.index + rw[0].length))) return credentialVerdict('the command is too large to check, and it runs riverwright with a word that could be "credential"');
    return ctx.strict ? unresolvable('the command nests too deeply to check') : null;
  }
  const { commands, incomplete } = lex(s, ctx.opts.lex);
  let found = incomplete && ctx.strict ? unresolvable('the command has an unterminated quote, substitution or here-document') : null;
  for (const cmd of commands) {
    found = prefer(found, classifySimple(cmd, ctx));
    if (isCredential(found)) return found;
    trackCd(cmd, ctx);
  }
  return found;
}

// Anything that could chain, substitute, expand (%VAR% in cmd), redirect, glob or escape disqualifies
// the publish exemption.
const PUBLISH_META = /[;&|<>`$%^(){}\r\n*?!\[\]~\\\0]|(?:^|\s)#/;

// The publish exemption belongs to the installed launcher only: the program must resolve to one of the trusted real
// paths, and the command must be one plain invocation with nothing in front of it (R37: not node with the launcher
// script either). On Windows a backslash is a path separator, so it is read as "/" (every other metacharacter still
// counts).
function isTrustedPublish(raw, trustedLauncher, platform) {
  const text = platform === 'win32' ? raw.replace(/\\/g, '/') : raw;
  if (!trustedLauncher.length || PUBLISH_META.test(text)) return false;
  const { commands, incomplete } = lex(text);
  if (incomplete || commands.length !== 1) return false;
  const toks = commands[0].words.map((w) => w.value);
  const trusted = new Set(trustedLauncher.map((p) => realish(p)));
  const isTrusted = (p) => typeof p === 'string' && (path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) && trusted.has(realish(p));
  return isTrusted(toks[0]) && PUBLISH_SUBCOMMANDS.includes(toks[1]);
}

// `cwd` is the command's working directory: a relative program path is resolved against it to see whether it
// is the launcher.
// userInfo: where the account's home ("~") comes from; a test seam, os.userInfo by default (read only for a "~" path).
export function classifyCommand(command, { trustedLauncher = [], platform = process.platform, cwd = process.cwd(), env = process.env, userInfo = os.userInfo } = {}) {
  const text = String(command ?? '');
  if (text.length <= MAX_INPUT && isTrustedPublish(text.trim(), trustedLauncher, platform)) return { outward: false, riverwrightPublish: true };
  // Too long to lex: denied by the credential rule when it names riverwright or credential anywhere.
  if (text.length > MAX_INPUT) {
    return mentionsCredential(text) || RIVERWRIGHT_TEXT.test(text) ? credentialVerdict('the command is too long to check, and it names riverwright or "credential"') : unresolvable('the command is too long to check');
  }
  const launchers = new Set([...LAUNCHER_FILES, ...trustedLauncher.map((p) => realish(p))]);
  const cwds = [path.resolve(cwd)];
  const opts = { cwd, cwds, env: env ?? {}, platform, launchers, userInfo, realCache: new Map(), dirCache: new Map(), gitCache: new Map(), lex: {} };
  // Each reading (readingsOf: the NUL readings of C1, and on Windows the "/" reading, so
  // "C:\\tools\\riverwright\\bin\\riverwright.cmd credential setup" is seen as the program it is) is classified and the
  // strongest verdict kept; an extra reading can only add denials. The scope check uses the same readings.
  const readings = readingsOf(text, platform);
  try {
    let found = null;
    // A second round when the command changed directory: every directory it names then counts from the start (a cd
    // after a use, in a loop).
    for (let round = 0; round < 2; round += 1) {
      for (const [t, lexOpts] of readings) {
        found = prefer(found, classifyScript(t, makeCtx(0, true, { used: 0 }, { ...opts, lex: lexOpts })));
        if (isCredential(found)) break;
      }
      if (isCredential(found) || cwds.length === 1) break;
    }
    return found ?? { outward: false };
  } catch (err) {
    // A command shaped to exhaust the stack gets a fixed verdict, never a crash. Any other error is a bug and
    // is thrown: the hook then exits 2, which blocks the command (it does not fall open as "unresolvable").
    if (!(err instanceof RangeError)) throw err;
    return mentionsCredential(text) || RIVERWRIGHT_TEXT.test(text) ? credentialVerdict('the command is too complex to check, and it names riverwright or "credential"') : unresolvable('the command is too complex to check');
  }
}
