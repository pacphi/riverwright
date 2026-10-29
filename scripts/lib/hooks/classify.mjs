import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realish } from '../paths.mjs';
import { lex, isDynamic, hasUnresolved, unCaret } from './shell.mjs';
import { outward, unresolvable, nameOf, codeLooksOutward, classifyGh, classifyHttp } from './github.mjs';

export { hasUnresolved };

// Conservative: anything that could publish, rewrite remotes, or bypass git hooks counts as outward.
// A false alarm blocks one command inside the workspace; a miss could publish without approval.
// Anything the classifier cannot fully resolve (a variable or substitution as the program or git/gh
// subcommand, eval, a shell reading code from a pipe) is outward with rule "unresolvable".
//
// The riverwright-credential rule (an agent running "riverwright credential") applies everywhere, not only
// in the workspace, and outranks every other rule in the same command (R23). It is the subcommand-slot rule (R26):
// the CLI dispatches on its first argument alone, so riverwright runs the credential command only when the word right
// after the program is "credential". Every word is read the way the shell decodes it first (quotes, backslash
// escapes, ANSI-C $'..' with \x, \u and octal, line continuations including CRLF). Then, for each word that is or
// could be riverwright (rw/riverwright as the name or last path component, with .cmd/.mjs/.exe and the like;
// cli.mjs or credential.mjs; a package such as riverwright@latest or npm:riverwright; a path whose realpath is one
// of the launcher files; a variable, substitution, glob or brace that could produce one), the next word is denied
// when it is, could be, or could vanish into "credential": a variable or substitution with no literal text that
// rules it out (--run="$RUN" cannot be "credential"; "$X" can), a glob that matches it, any brace or extglob, %NAME%,
// a PowerShell splat or comma list, a parenthesised argument (fish, PowerShell), or a "--" or glob that may vanish
// ahead of it. After a literal riverwright program only its own slot counts: its other arguments are riverwright's.
//   - Known non-executing tools: the arguments of grep, egrep, fgrep, rg, echo, printf, cat, head, tail, wc, sort,
//     uniq, diff, cmp, ls, stat, file, mount, umount, chmod, chown, cp, mv, ln, mkdir, rmdir, touch, cut, tr,
//     curl, wget, jq, rg (no --pre), sed (no e/w/W command or flag, no -f script), awk (no system() or pipe, no
//     -f), find (no -exec/-execdir/-ok/-okdir) and git (not bisect, rebase, submodule, difftool, mergetool, config,
//     hook and the other subcommands that run a command), seen through env, sudo, nice, nohup, timeout, time,
//     command, exec, builtin and the other pass-through wrappers, are not read as programs, and their quoted
//     arguments are not read as commands. git's -c values and "!" aliases are always read as commands.
//   - Every other program fails closed: all of its words are checked, and its quoted arguments, here-documents
//     and here-strings are lexed as commands. Nested payloads are lexed and checked the same way: sh/bash/zsh/
//     dash/pwsh/cmd -c, eval, env -S, su -c, expect -c, script, tmux, screen, watch and ssh (their joined
//     arguments), ssh -o ProxyCommand=..., git -c alias.*=!... and other -c values, command substitutions, code
//     piped or fed to a shell or to at, batch, crontab, ssh, su, script or expect (when the piped text cannot be
//     read exactly, the words of the command that writes it are checked as if they ran), and assignments
//     (EDITOR="...", x="..."; $x).
//   - Structural checks kept from earlier rounds: xargs, parallel, find -exec and rg --pre feeding riverwright;
//     alias definitions that run it; Start-Process with riverwright; inline code (node -e, python -c, ...) that names
//     it near "credential" or loads lib/cli.mjs or commands/credential.mjs.
// Its honest limits: it reads one command line, so it cannot see
//   - code inside a script file, Makefile or package.json that the command runs (sh ./x.sh, make, npm run),
//     including a script written by the same command (printf "rw credential setup" > s.sh && sh s.sh);
//   - a command or argument built from pieces or encoded (base64 -d | sh, IFS games, 'cred' + 'ential' in a
//     language the classifier does not read);
//   - a renamed launcher that cannot be resolved by path: a plain copy or a hard link, a symlink reached by bare
//     name through PATH, or a link created by the same command (only a path that realpath resolves to the launcher
//     files now is recognised);
//   - a tool on the non-executing list that turns out to run something (a sed or awk spelling the check misses, a
//     curl or git configuration file);
//   - a deliberate forger running as the same user, who can always reach the vault another way.
// It over-blocks in unknown programs on purpose: "$A" "$B" there is denied (the first could be riverwright, the
// second "credential"), as are quoted arguments that mention both (gh pr create --title 'rw credential fix').
// The passphrase, typed by the human in their own terminal, is the real protection (ADR-0010); this rule stops
// accidents and prompt injection.

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
const DANGEROUS_ENV = /^(GIT_SSH|GIT_SSH_COMMAND|GIT_SSH_VARIANT|GIT_PROXY_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG\w*|GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_ALLOW_PROTOCOL|RIVERWRIGHT_\w*|HOME|XDG_CONFIG_HOME)$/i;
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
    if (t === '-') break;
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
    if (t === '-') break;
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
  const inner = /\s/.test(nameOf(own[i])) ? (lex(nameOf(own[i])).commands[0]?.words ?? []) : own.slice(i);
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
      const inner = lex(m[2]).commands[0];
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
const prefer = (found, v) => (!found || (isCredential(v) && !isCredential(found)) ? (v ?? found) : found);
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

// A path that resolves (realpath, against the command's working directory) to one of the launcher files. A
// bare name is a path only when it looks like a script (node a.mjs); as a program it is looked up in PATH. Long or
// deep paths are not resolved (realish walks up one parent per missing segment); results are cached per command.
function resolvesToLauncher(v, ctx) {
  if (!/[\\/]/.test(v) && !/\.(mjs|cjs|js)$/i.test(v)) return false;
  if (GLOB.test(v) || /[{}]/.test(v) || v.includes('\0') || v.length > 1024 || v.split(/[\\/]/).length > 64) return false;
  const cache = ctx.opts.realCache;
  if (cache.has(v)) return cache.get(v);
  let hit = false;
  try {
    hit = ctx.opts.launchers.has(realish(path.resolve(ctx.opts.cwd, v)));
  } catch {
    hit = false;
  }
  cache.set(v, hit);
  return hit;
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
// pipe), find only without -exec/-execdir/-ok/-okdir. git counts too, but its -c values and "!" aliases are read
// as commands (gitPayloads). Every other program fails closed: all of its words are checked.
const NON_EXECUTING = new Set(['grep', 'egrep', 'fgrep', 'rg', 'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'diff', 'cmp', 'ls', 'stat', 'file', 'mount', 'umount', 'chmod', 'chown', 'cp', 'mv', 'ln', 'mkdir', 'rmdir', 'touch', 'cut', 'tr', 'curl', 'wget', 'jq', 'git', 'sed', 'awk', 'gawk', 'mawk', 'nawk', 'find']);
const FIND_EXEC = ['-exec', '-execdir', '-ok', '-okdir'];

// The script texts of a sed or awk command, or null when one is read from a file (unknown).
function toolScripts(prog, args) {
  const scripts = [];
  let positional = null;
  const awk = prog !== 'sed';
  for (let i = 0; i < args.length; i += 1) {
    const t = nameOf(args[i]);
    if (t === '--') { positional = positional ?? nameOf(args[i + 1]); break; }
    if (awk) {
      if (/^(-f|--file|-i|--include|-l|--load|-E|--exec)$/.test(t) || /^--(file|include|load|exec)=/.test(t)) return null;
      if (t === '-e' || t === '--source') { scripts.push(nameOf(args[i + 1])); i += 1; continue; }
      if (t.startsWith('--source=')) { scripts.push(t.slice(9)); continue; }
      if (t === '-v' || t === '-F') { i += 1; continue; }
    } else {
      if (t === '--file' || t.startsWith('--file=') || /^-[a-zA-Z]*f/.test(t) && !t.startsWith('--')) return null;
      if (t === '--expression' || /^-[a-zA-Z]*e$/.test(t) && !t.startsWith('--')) { scripts.push(nameOf(args[i + 1])); i += 1; continue; }
      if (t.startsWith('--expression=')) { scripts.push(t.slice(13)); continue; }
      if (t === '-l' || t === '--line-length') { i += 1; continue; }
    }
    if ((t.startsWith('-') && t !== '-') || t === '') continue;
    positional = t;
    break;
  }
  if (!scripts.length && positional !== null) scripts.push(positional);
  return scripts;
}

// git subcommands that run a command they are given (bisect run, rebase -x, submodule foreach, difftool
// --extcmd, a configured editor or alias, hooks).
const GIT_RUNNERS = new Set(['bisect', 'rebase', 'submodule', 'filter-branch', 'filter-repo', 'difftool', 'mergetool', 'config', 'hook', 'for-each-repo', 'daemon', 'instaweb', 'send-email']);

function gitSubcommand(args) {
  for (let i = 0; i < args.length; i += 1) {
    const t = nameOf(args[i]);
    if (t === '-c' || t === '--config-env' || GIT_VALUE_OPTS.has(t)) { i += 1; continue; }
    if (t.startsWith('-')) continue;
    return t.toLowerCase();
  }
  return null;
}

function nonExecuting(prog, args) {
  if (!NON_EXECUTING.has(prog)) return false;
  if (prog === 'git') return !GIT_RUNNERS.has(gitSubcommand(args));
  // ripgrep runs a --pre preprocessor with each file name as its argument.
  if (prog === 'rg') return !args.some((w) => /^--pre(=|$)/.test(nameOf(w)));
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

// The index of the program: past leading keywords, assignments, env (its options and assignments) and the
// pass-through wrappers. words.length when there is none (env -S, a lone assignment).
function programIndex(ws) {
  let i = 0;
  let wrappers = 0;
  while (i < ws.length) {
    const w = ws[i];
    const t = nameOf(w);
    if ((!w.quoted && KEYWORDS.has(t)) || ASSIGNMENT.test(t)) { i += 1; continue; }
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
function isExecuting(ws) {
  const k = programIndex(ws);
  if (k >= ws.length) return true;
  const p = programName(ws[k]);
  if (p === null) return true;
  const args = ws.slice(k + 1);
  if (p === 'xargs') return isExecuting(args.slice(xargsCommandIndex(args)));
  return !nonExecuting(p, args);
}

// Text that a program will run as a command, lexed and checked with this rule. Only a credential verdict counts.
function payload(text, ctx) {
  if (!PAYLOAD_HINT.test(text)) return null;
  const v = classifyScript(text, ctx.deeper(false, true));
  return isCredential(v) ? v : null;
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
    if (body === null) continue;
    const code = body.replace(/^!/, '');
    const v = payload(code, ctx);
    if (v) return v;
    if (body.startsWith('!')) {
      const first = lex(code).commands[0];
      const ws = first ? first.words.slice(programIndex(first.words)) : [];
      if (ws.length && mayBeRiverwright(ws[0], ctx)) return credentialVerdict('a git "!" alias runs riverwright (the arguments after it could be "credential")');
    }
  }
  return null;
}

// The slot rule over one command's words. Returns a credential verdict or null. parenNext: the command was cut
// short by "(" (fish and PowerShell evaluate a parenthesised argument, so its output is the next word).
// force: check every word even when the program is a non-executing tool (its output is about to be run).
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
  const k = programIndex(ws);
  const prog = k < ws.length ? programName(ws[k]) : undefined;
  const args = ws.slice(k + 1);
  if (prog === 'git') { const v = gitPayloads(args, ctx); if (v) return v; }
  if (prog && !force && nonExecuting(prog, args)) return null;
  if (prog === 'xargs') return credentialSlots(args.slice(xargsCommandIndex(args)), ctx, depth + 1);
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
    return null;
  }
  if (prog === 'rg') {
    // rg --pre PROG runs PROG with each file name as its first argument: a file can be named "credential".
    for (let i = 0; i < args.length; i += 1) {
      const t = nameOf(args[i]);
      const pre = t === '--pre' ? args[i + 1] : t.startsWith('--pre=') ? { ...args[i], value: t.slice(6), shape: shapeOf(args[i]).slice(6) } : null;
      if (pre && mayBeRiverwright(pre, ctx)) return credentialVerdict('rg --pre runs riverwright with each file name as its subcommand (a file can be named "credential")');
    }
  }
  if (prog === 'start-process' || prog === 'saps') {
    if (args.some((w) => mayBeRiverwright(w, ctx))) return credentialVerdict('Start-Process runs riverwright with an argument list (it could hold "credential")');
  }
  // Which words could be riverwright: for a literal riverwright program, only the words up to it (its own
  // arguments are riverwright's); for anything else, every word (an unknown program may run its arguments).
  const last = k < ws.length && isLiteralRiverwright(ws[k]) ? k : ws.length - 1;
  // slot[j]: the slot starting at word j is, could be, or could vanish into "credential". Filled right to left.
  const slot = new Array(ws.length + 1).fill(false);
  slot[ws.length] = parenNext;
  for (let j = ws.length - 1; j >= 0; j -= 1) slot[j] = couldBeCredential(ws[j]) || (mayVanish(ws[j]) && slot[j + 1]);
  for (let i = 0; i <= last; i += 1) {
    if ((slot[i + 1] && mayBeRiverwright(ws[i], ctx)) || holdsCredential(ws[i], ctx)) return credentialVerdict(SLOT_DETAIL);
  }
  if (prog && (JOINERS.has(prog) || EVALUATORS.has(prog))) {
    const v = payload(args.map((w) => nameOf(w)).join(' '), ctx);
    if (v) return v;
  }
  if (force) {
    for (const w of ws) { const v = /\s/.test(w.value) ? payload(w.value, ctx) : null; if (v) return v; }
  }
  return null;
}

// Programs that run commands read from stdin (besides the shells and interpreters classifyStdinCode reads).
const STDIN_RUNNERS = new Set(['at', 'batch', 'crontab', 'ssh', 'su', 'runuser', 'script', 'expect']);

// The command piping into a program that runs its stdin: its output is a command, so its words are checked as if
// it ran them (echo -e 'rw credential setup' | sh, printf '%s\n' rw credential | at now).
function pipedCredential(prev, ctx) {
  return prev && ctx.cred ? credentialSlots(prev.words, ctx, 1, false, true) : null;
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
  if (ctx.cred && cmd.stdin === 'pipe' && STDIN_RUNNERS.has(programName(cmd.words[programIndex(cmd.words)]))) {
    if (take(pipedCredential(cmd.prev, ctx))) return found;
  }
  // Safety net: text that looks like a command (a quoted argument, a here-document) is checked too. For the
  // credential rule it counts only when the program may run what it is given: the quoted arguments of grep, echo
  // or git commit -m are text, never commands.
  const runs = ctx.cred && isExecuting(cmd.words);
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
    return ctx.strict ? unresolvable('the command nests too deeply to check') : null;
  }
  const { commands, incomplete } = lex(s);
  let found = incomplete && ctx.strict ? unresolvable('the command has an unterminated quote, substitution or here-document') : null;
  for (const cmd of commands) {
    found = prefer(found, classifySimple(cmd, ctx));
    if (isCredential(found)) return found;
  }
  return found;
}

// Anything that could chain, substitute, expand (%VAR% in cmd), redirect, glob or escape disqualifies
// the publish exemption.
const PUBLISH_META = /[;&|<>`$%^(){}\r\n*?!\[\]~\\\0]|(?:^|\s)#/;

// The publish exemption belongs to the installed launcher only: the program (or the script node runs)
// must resolve to one of the trusted real paths, and the command must be one plain invocation. On
// Windows a backslash is a path separator, so it is read as "/" (every other metacharacter still counts).
function isTrustedPublish(raw, trustedLauncher, platform) {
  const text = platform === 'win32' ? raw.replace(/\\/g, '/') : raw;
  if (!trustedLauncher.length || PUBLISH_META.test(text)) return false;
  const { commands, incomplete } = lex(text);
  if (incomplete || commands.length !== 1) return false;
  const toks = commands[0].words.map((w) => w.value);
  const trusted = new Set(trustedLauncher.map((p) => realish(p)));
  const isTrusted = (p) => typeof p === 'string' && (path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) && trusted.has(realish(p));
  let i = 0;
  if (toks[0] === 'node' || (path.isAbsolute(toks[0] ?? '') && realish(toks[0]) === realish(process.execPath))) i = 1;
  return isTrusted(toks[i]) && ['submit', 'post'].includes(toks[i + 1]);
}

// `cwd` is the command's working directory: a relative program path is resolved against it to see whether it
// is the launcher.
export function classifyCommand(command, { trustedLauncher = [], platform = process.platform, cwd = process.cwd() } = {}) {
  const text = String(command ?? '');
  if (text.length <= MAX_INPUT && isTrustedPublish(text.trim(), trustedLauncher, platform)) return { outward: false, riverwrightPublish: true };
  // Too long to lex: denied by the credential rule when it names riverwright or credential anywhere.
  if (text.length > MAX_INPUT) {
    return mentionsCredential(text) || RIVERWRIGHT_TEXT.test(text) ? credentialVerdict('the command is too long to check, and it names riverwright or "credential"') : unresolvable('the command is too long to check');
  }
  const launchers = new Set([...LAUNCHER_FILES, ...trustedLauncher.map((p) => realish(p))]);
  const opts = { cwd, launchers, realCache: new Map() };
  try {
    let found = classifyScript(text, makeCtx(0, true, { used: 0 }, opts));
    // On Windows a backslash separates path segments and does not escape; read that way too, so
    // "C:\\tools\\riverwright\\bin\\riverwright.cmd credential setup" is seen as the program it is. This second
    // reading applies to every rule, not only the credential rule; it can only add denials.
    if (platform === 'win32' && text.includes('\\') && !isCredential(found)) {
      found = prefer(found, classifyScript(text.replace(/\\/g, '/'), makeCtx(0, true, { used: 0 }, opts)));
    }
    return found ?? { outward: false };
  } catch (err) {
    // A command shaped to exhaust the stack gets a fixed verdict, never a crash. Any other error is a bug and
    // is thrown: the hook then exits 2, which blocks the command (it does not fall open as "unresolvable").
    if (!(err instanceof RangeError)) throw err;
    return mentionsCredential(text) || RIVERWRIGHT_TEXT.test(text) ? credentialVerdict('the command is too complex to check, and it names riverwright or "credential"') : unresolvable('the command is too complex to check');
  }
}
