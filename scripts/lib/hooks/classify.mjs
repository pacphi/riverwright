import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realish } from '../paths.mjs';
import { lex, isDynamic, hasUnresolved } from './shell.mjs';
import { outward, unresolvable, nameOf, codeLooksOutward, classifyGh, classifyHttp } from './github.mjs';

export { hasUnresolved };

// Conservative: anything that could publish, rewrite remotes, or bypass git hooks counts as outward.
// A false alarm blocks one command inside the workspace; a miss could publish without approval.
// Anything the classifier cannot fully resolve (a variable or substitution as the program or git/gh
// subcommand, eval, a shell reading code from a pipe) is outward with rule "unresolvable".
//
// The riverwright-credential rule (an agent running "riverwright credential") applies everywhere, not only
// in the workspace, and outranks every other rule in the same command. It is a deliberately conservative TEXT
// match over the whole command (R25), not a model of the shell: with quotes and backslashes removed, a
// riverwright word ("rw" or "riverwright" as a word or the last path component, cli.mjs, credential.mjs)
// followed anywhere later by "credential", a variable, a substitution, a glob or a brace is denied. Nested
// payloads (sh -c '...', git -c alias.x='!...', ssh -o ProxyCommand=..., eval, su -c, tmux new '...') are
// literal text in the command, so they are covered without being parsed. It over-blocks on purpose:
// `grep -n rw "$FILE"`, `rw state get *` and prose such as `git commit -m "... riverwright credential ..."` are
// denied too (workaround: write the value out, or `git commit -F file`). A few structural checks remain for
// spellings with no riverwright word in them: a variable or glob program word with a "credential" argument,
// xargs/parallel/find feeding riverwright, an alias to it, inline code that loads the CLI, and a path that
// realpath resolves to the launcher files. Its honest limits: it reads one command line, so it cannot see
//   - code inside a script file, Makefile or package.json that the command runs (sh ./x.sh, make, npm run);
//   - a renamed or copied launcher that cannot be resolved by path: a plain copy (cp bin/riverwright /tmp/x),
//     a hard link, or a bare program name found through PATH (only a path that realpath resolves to the
//     launcher files is recognised);
//   - a command or argument built from pieces or encoded (base64 -d | sh, 'cred' + 'ential' with no
//     riverwright word);
//   - a deliberate forger running as the same user, who can always reach the vault another way.
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
    if (text === null) return unresolvable(`${prog} runs code piped in from another command`);
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
    if (inlineCredential(code)) return credentialVerdict(CREDENTIAL_DETAIL);
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
  if (replace && nameOf(rest[0]).includes(replace) && rest.slice(1).some(mayBeCredential)) {
    return credentialVerdict('xargs supplies the program, and an argument is (or could expand to) "credential"');
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
  const cred = credentialAtProgram(words, ctx);
  if (cred) return cred;
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
      if (inner && throughWrappers(inner.words).length && mayBeRiverwright(throughWrappers(inner.words)[0], ctx)) {
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
// terminal, so an agent's shell command that names it is denied in any spelling, wherever it runs.
// The text rule (credentialInText, run by classifyCommand on the raw command) does most of the work. The
// structural checks below catch the spellings that have no riverwright word for the text rule to find
// (credentialAtProgram, called by classifyInvocation, so env, sudo, wrappers, xargs and find -exec reach it, plus
// npx/pnpm/npm/yarn/bunx and node/bun/deno running a script): the program is a glob or brace that could be
// riverwright, a path that resolves to the launcher, or a variable or substitution, and an argument is or could
// match "credential" (or, for a riverwright program, its subcommand is a variable). Nothing is expanded: a glob is
// matched, never generated, and a brace is taken as "could be anything".
// base() lowercases and drops .exe/.cmd/.bat, so upper case and Windows names are caught too.
const RIVERWRIGHT_NAMES = new Set(['riverwright', 'rw']);
const RIVERWRIGHT_CANDIDATES = ['riverwright', 'rw', ...['mjs', 'cmd', 'exe', 'bat', 'ps1', 'js'].flatMap((x) => [`riverwright.${x}`, `rw.${x}`])];
const RIVERWRIGHT_VALUE_OPTS = new Set(['--home', '--run', '--workspace']);
const CREDENTIAL_DETAIL = 'riverwright credential (sealing, replacing or removing your credential is something you do yourself, in your own terminal)';
// A text-rule hit is often a false positive (grep -n rw "$FILE"), so it says how to get past it.
const CREDENTIAL_TEXT_DETAIL = 'riverwright credential, or a riverwright word followed by "credential", a variable, a substitution, a glob or a brace (any of them could become "credential"). Sealing, replacing or removing your credential is something you do yourself, in your own terminal. If this command is not that, write the value out in full instead of a variable or pattern, or put a commit message in a file (git commit -F)';
const GLOB = /[*?[]/;

// The launcher's own files. A program word, or the script node runs, whose real path is one of these is
// riverwright whatever it is called (a symlink named anything).
const LAUNCHER_FILES = ['../../../bin/riverwright', '../../../bin/riverwright.cmd', '../../../bin/rw', '../../../bin/rw.cmd', '../../riverwright.mjs', '../cli.mjs', '../commands/credential.mjs']
  .map((rel) => realish(fileURLToPath(new URL(rel, import.meta.url))));

const credentialVerdict = (why) => outward('riverwright-credential', why);
const isCredential = (v) => v?.rule === 'riverwright-credential';
const prefer = (found, v) => (!found || (isCredential(v) && !isCredential(found)) ? (v ?? found) : found);
const mentionsCredential = (s) => /credential/i.test(String(s).replace(/["'`\\^]/g, ''));

// The text rule. Every regex here is matched once from left to right with fixed-length alternatives, so the
// cost is linear in the command's length.
//   - a riverwright word: "rw" or "riverwright" (optionally .cmd/.mjs/.exe/.bat/.ps1/.js) not inside a longer
//     name and not followed by "/" (a directory named rw is not the program), or cli.mjs / credential.mjs;
//   - after the first riverwright word: the word "credential", a variable or substitution ($, backtick,
//     %NAME%, a PowerShell splat @name), a glob (* ? [ and the extglob openers @( +( !( ), or a brace. It is
//     searched from the end of that word in the whole text, so riverwright@latest and me@host are not splats.
const RIVERWRIGHT_WORD = /(?<![\w.-])(?:riverwright|rw)(?:\.(?:cmd|mjs|exe|bat|ps1|js))?(?![\w./-])|(?<![\w-])(?:cli|credential)\.mjs(?!\w)/i;
const AFTER_RIVERWRIGHT = /(?<!\w)credential(?!\w)|[$`*?[{]|[@+!]\(|%[A-Za-z_]\w*%|(?<![\w@])@\w/gi;
const CREDENTIAL_WORD = /(?<!\w)credential(?!\w)/gi;

// The two readings of a command: quotes, cmd.exe carets and backslashes removed (r\iverwright, cred""ential),
// and backslashes read as "/" (a Windows path, C:\tools\rw.cmd). Whitespace is collapsed.
function textForms(raw) {
  const t = String(raw).replace(/["'^]/g, '').replace(/\s+/g, ' ');
  return [t.replace(/\\/g, ''), t.replace(/\\/g, '/')];
}

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

// A brace that bash would expand ({a,b} or {x..y}): it could become anything, so it is never expanded here.
function isBrace(v) {
  const k = v.indexOf('{');
  return k !== -1 && (v.indexOf(',', k) !== -1 || v.indexOf('..', k) !== -1);
}

// A glob or brace word that could name riverwright: a glob whose last segment (with a literal letter, so a bare
// "*" does not count) matches a riverwright name, or a brace whose letters could still spell "rw".
function patternCouldBeRiverwright(word) {
  const seg = word.split('/').pop();
  if (isBrace(seg)) {
    const r = seg.search(/r/i);
    return r !== -1 && /w/i.test(seg.slice(r + 1));
  }
  if (!GLOB.test(seg) || !/[a-z0-9]/i.test(seg.replace(/\[[^\]]*\]/g, ''))) return false;
  const name = seg.replace(/(?!^)@[^@]*$/, '');
  return RIVERWRIGHT_CANDIDATES.some((c) => globMatch(name, c));
}

// True when the command, read as text, names riverwright and then "credential" or something that could become
// it. Also: a glob or brace word that could be riverwright, before the last word "credential" (a launcher the
// classifier does not model: script -q /dev/null riverw?ight credential setup).
function credentialInText(raw) {
  for (const t of textForms(raw)) {
    const m = RIVERWRIGHT_WORD.exec(t);
    if (m) {
      AFTER_RIVERWRIGHT.lastIndex = m.index + m[0].length;
      if (AFTER_RIVERWRIGHT.test(t)) return true;
    }
    let last = -1;
    for (const c of t.matchAll(CREDENTIAL_WORD)) last = c.index;
    if (last > 0 && t.slice(0, last).split(/[\s;&|()<>]+/).some((w) => (GLOB.test(w) || isBrace(w)) && patternCouldBeRiverwright(w))) return true;
  }
  return false;
}

// The name a program or package word stands for: its base name without .exe/.cmd/.mjs, a package version
// (riverwright@latest, @scope/riverwright@1.2.3) or a tarball suffix.
function riverwrightName(v) {
  return base(v).replace(/(?!^)@[^@]*$/, '').replace(/\.(mjs|cjs|js|tgz|tar\.gz)$/, '');
}

// A word that is "credential", or could match it (a glob, a brace, a PowerShell comma list 'credential','setup').
function mayBeCredential(w) {
  if (!w || isDynamic(w)) return false;
  const v = nameOf(w);
  if (isBrace(v)) return true;
  return v.split(',').some((part) => (GLOB.test(part) ? globMatch(part, 'credential') : part.toLowerCase() === 'credential'));
}

// A path that resolves (realpath, against the command's working directory) to one of the launcher files. A
// bare name is a path only where a script runner takes it (node a.mjs); as a program it is looked up in PATH.
function resolvesToLauncher(v, ctx, script = false) {
  if ((!script && !/[\\/]/.test(v)) || GLOB.test(v) || /[{}]/.test(v) || v.includes('\0')) return false;
  try {
    return ctx.opts.launchers.has(realish(path.resolve(ctx.opts.cwd, v)));
  } catch {
    return false;
  }
}

// A word that is, or could be, the riverwright program: its name, a glob that matches it, a brace (could be
// anything), or a path that resolves to the launcher files.
function mayBeRiverwright(w, ctx, { script = false } = {}) {
  if (!w) return false;
  if (isDynamic(w)) {
    const p = programName(w);
    return p !== null && RIVERWRIGHT_NAMES.has(riverwrightName(p));
  }
  const v = nameOf(w);
  if (isBrace(v)) return true;
  const seg = v.split(/[\\/]/).pop();
  if (GLOB.test(seg)) return RIVERWRIGHT_CANDIDATES.some((c) => globMatch(seg.replace(/(?!^)@[^@]*$/, ''), c));
  return RIVERWRIGHT_NAMES.has(riverwrightName(seg)) || resolvesToLauncher(v, ctx, script);
}

// riverwright is the program: an argument that is or could match "credential" is denied, and so is a
// subcommand given as a variable (it could be "credential"). Values of --home/--run/--workspace are skipped.
function riverwrightArgs(args, ctx) {
  if (args.some(mayBeCredential)) return credentialVerdict(CREDENTIAL_DETAIL);
  if (!ctx.strict) return null;
  for (let k = 0; k < args.length; k += 1) {
    const t = nameOf(args[k]);
    if (!isDynamic(args[k]) && RIVERWRIGHT_VALUE_OPTS.has(t.toLowerCase())) { k += 1; continue; }
    // An option stays an option even when its value is a variable (--home="$H").
    if (t.startsWith('-')) continue;
    if (isDynamic(args[k])) return credentialVerdict('the riverwright subcommand is a variable or substitution (it could be "credential")');
    break;
  }
  return null;
}

const RUNNER_VALUE_OPTS = new Set(['-p', '--package', '-c', '--call', '--registry', '--cache', '--userconfig', '--prefix', '-w', '--workspace', '-C', '--dir', '--filter', '-F']);
const SCRIPT_RUNNERS = /^(node|nodejs|bun|deno)$/;

// The index (in args) of the package or script a runner starts, or -1.
function runnerTarget(prog, args) {
  const firstOperand = (from, values) => {
    for (let i = from; i < args.length; i += 1) {
      const t = nameOf(args[i]);
      if (values.has(t)) { i += 1; continue; }
      if (t.startsWith('-') && t !== '-') continue;
      return i;
    }
    return -1;
  };
  if (['npx', 'bunx', 'pnpx'].includes(prog)) return firstOperand(0, RUNNER_VALUE_OPTS);
  if (['pnpm', 'npm', 'yarn'].includes(prog)) {
    const k = firstOperand(0, RUNNER_VALUE_OPTS);
    if (k === -1 || isDynamic(args[k])) return k;
    if (!['exec', 'dlx', 'x', 'run'].includes(nameOf(args[k]).toLowerCase())) return -1;
    return firstOperand(k + 1, RUNNER_VALUE_OPTS);
  }
  if (SCRIPT_RUNNERS.test(prog)) {
    const spec = INTERPRETERS.find((s) => s.test.test(prog));
    const values = new Set(spec ? spec.values : []);
    // Inline code (-e, --eval, -p) is classifyInterpreter's job.
    if (args.some((w) => spec && spec.code.some((f) => nameOf(w) === f || nameOf(w).startsWith(`${f}=`)))) return -1;
    let k = firstOperand(0, values);
    if (k !== -1 && ['run', 'x'].includes(nameOf(args[k]))) k = firstOperand(k + 1, values);
    if (k !== -1 && prog === 'deno' && nameOf(args[k]) === 'eval') return -1;
    return k;
  }
  return -1;
}

// The program of an invocation, seen through riverwright-like names, runners and variables.
function credentialAtProgram(words, ctx) {
  const w0 = words[0];
  if (!w0) return null;
  const args = words.slice(1);
  const prog = programName(w0);
  if (prog === null) {
    return args.some(mayBeCredential) ? credentialVerdict('the program is a variable or substitution and an argument is (or could match) "credential"') : null;
  }
  if (mayBeRiverwright(w0, ctx)) return riverwrightArgs(args, ctx);
  const k = runnerTarget(prog, args);
  if (k === -1) return null;
  const target = args[k];
  const rest = args.slice(k + 1);
  if (isDynamic(target) && programName(target) === null) {
    return rest.some(mayBeCredential) ? credentialVerdict(`${prog} runs a package or script named by a variable, and an argument is (or could match) "credential"`) : null;
  }
  return mayBeRiverwright(target, ctx, { script: SCRIPT_RUNNERS.test(prog) }) ? riverwrightArgs(rest, ctx) : null;
}

// Inline code (node -e, python -c, perl -e, ruby -e, deno eval, bun -e) that starts riverwright with "credential"
// next to it, or near it in an argument list, or that loads the CLI or the credential command directly.
const INLINE_CREDENTIAL = /(?:^|[^\w-])(?:riverwright|rw)(?:\.mjs|\.cmd)?['"`\[\])\s,]+['"`]?credential\b/i;
const INLINE_NEAR = /\briverwright\b[\s\S]{0,160}?\bcredential\b|['"`]rw(?:\.cmd|\.mjs)?['"`][\s\S]{0,160}?\bcredential\b/i;
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
  // Safety net: text that looks like a command (a quoted argument, a here-document) is checked too.
  if (ctx.depth < 4) {
    for (const w of all) {
      if (/\s/.test(w.value) && take(classifyScript(w.value, ctx.deeper(false)))) return found;
    }
    for (const h of cmd.heredocs) { if (take(classifyScript(h.text, ctx.deeper(false)))) return found; }
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

function makeCtx(depth, strict, budget, opts) {
  return { depth, strict, budget, opts, deeper: (s) => makeCtx(depth + 1, s, budget, opts) };
}

function classifyScript(text, ctx) {
  const s = String(text);
  ctx.budget.used += s.length;
  if (ctx.depth > MAX_DEPTH || ctx.budget.used > MAX_WORK) {
    if (mentionsCredential(s)) return credentialVerdict('the command nests too deeply to check, and it mentions "credential"');
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
  // R25: the credential rule reads the whole command as text first, at any length.
  if (credentialInText(text)) return credentialVerdict(CREDENTIAL_TEXT_DETAIL);
  if (text.length > MAX_INPUT) {
    return mentionsCredential(text) ? credentialVerdict('the command is too long to check, and it mentions "credential"') : unresolvable('the command is too long to check');
  }
  const launchers = new Set([...LAUNCHER_FILES, ...trustedLauncher.map((p) => realish(p))]);
  const opts = { cwd, launchers };
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
    return mentionsCredential(text) ? credentialVerdict('the command is too complex to check, and it mentions "credential"') : unresolvable('the command is too complex to check');
  }
}
