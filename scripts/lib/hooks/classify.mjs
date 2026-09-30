import path from 'node:path';
import { realish } from '../paths.mjs';
import { lex, isDynamic, hasUnresolved } from './shell.mjs';
import { outward, unresolvable, nameOf, codeLooksOutward, classifyGh, classifyHttp } from './github.mjs';

export { hasUnresolved };

// Conservative: anything that could publish, rewrite remotes, or bypass git hooks counts as outward.
// A false alarm blocks one command inside the workspace; a miss could publish without approval.
// Anything the classifier cannot fully resolve (a variable or substitution as the program or git/gh
// subcommand, eval, a shell reading code from a pipe) is outward with rule "unresolvable".

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
  const judge = (code) => (codeLooksOutward(code) ? outward('inline-code', `${prog} inline code reaches GitHub or runs git/gh`) : null);
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

function classifyXargs(args, ctx) {
  let i = 0;
  for (; i < args.length; i += 1) {
    const t = nameOf(args[i]);
    if (['-I', '-n', '-L', '-P', '-s', '-d', '-E', '-a'].includes(t)) { i += 1; continue; }
    if (t.startsWith('-')) continue;
    break;
  }
  const rest = args.slice(i);
  if (!rest.length) return null;
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

function classifyInvocation(words, cmd, ctx) {
  const prog = programName(words[0]);
  if (prog === null) return ctx.strict ? unresolvable('the program is a variable or substitution') : null;
  const args = words.slice(1);
  if (EVALUATORS.has(prog)) return unresolvable(`${prog} runs text the classifier cannot see`);
  if (prog === 'env') {
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
      if (m) { const v = checkEnvName(m[1]); if (v) return v; continue; }
      break;
    }
    return args.length > i ? classifyInvocation(args.slice(i), cmd, ctx) : null;
  }
  if (Object.hasOwn(WRAPPERS, prog)) {
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
      const p = inner && programName(inner.words[0]);
      if (p && (['git', 'gh', 'env', 'sudo', 'xargs', 'hub', ...EVALUATORS, ...SHELLS, ...HTTP_CLIENTS].includes(p) || INTERPRETERS.some((s) => s.test.test(p)))) {
        return outward('shell-alias', `alias ${m[1]} runs ${p}`);
      }
    }
    return null;
  }
  if (prog === 'xargs') return classifyXargs(args, ctx);
  if (prog === 'find') {
    const k = args.findIndex((w) => ['-exec', '-execdir', '-ok', '-okdir'].includes(nameOf(w)));
    if (k === -1) return null;
    const end = args.findIndex((w, j) => j > k && [';', '+'].includes(nameOf(w)));
    if (end === k + 1 || k + 1 >= args.length) return null;
    return classifyInvocation(args.slice(k + 1, end === -1 ? undefined : end), { words: [], stdin: null, heredocs: [], herestrings: [] }, ctx);
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

function classifySimple(cmd, ctx) {
  const all = [...cmd.words, ...cmd.redirects, ...cmd.herestrings];
  // Substitutions run before the command itself.
  for (const w of all) {
    for (const sub of w.subs) {
      const v = classifyScript(sub, ctx.deeper(ctx.strict));
      if (v) return v;
    }
  }
  // Safety net: text that looks like a command (a quoted argument, a here-document) is checked too.
  if (ctx.depth < 4) {
    for (const w of all) {
      if (/\s/.test(w.value)) { const v = classifyScript(w.value, ctx.deeper(false)); if (v) return v; }
    }
    for (const h of cmd.heredocs) { const v = classifyScript(h.text, ctx.deeper(false)); if (v) return v; }
  }
  let i = 0;
  while (i < cmd.words.length) {
    const w = cmd.words[i];
    const t = nameOf(w);
    if (!w.quoted && KEYWORDS.has(t)) { i += 1; continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(t);
    if (m) { const v = checkEnvName(m[1]); if (v) return v; i += 1; continue; }
    break;
  }
  if (i < cmd.words.length) {
    const v = classifyInvocation(cmd.words.slice(i), cmd, ctx);
    if (v) return v;
  }
  // A git or gh word anywhere later in the command (sudo -u x git push, find -exec, echo ... | sh).
  for (let k = i + 1; k < cmd.words.length; k += 1) {
    const w = cmd.words[k];
    if (isDynamic(w)) continue;
    const b = base(nameOf(w));
    const lenient = ctx.deeper(false);
    const v = b === 'git' ? classifyGit(cmd.words.slice(k + 1), lenient) : b === 'gh' ? classifyGh(cmd.words.slice(k + 1), lenient) : null;
    if (v) return v;
  }
  return null;
}

function makeCtx(depth, strict, budget) {
  return { depth, strict, budget, deeper: (s) => makeCtx(depth + 1, s, budget) };
}

function classifyScript(text, ctx) {
  const s = String(text);
  ctx.budget.used += s.length;
  if (ctx.depth > MAX_DEPTH || ctx.budget.used > MAX_WORK) {
    return ctx.strict ? unresolvable('the command nests too deeply to check') : null;
  }
  const { commands, incomplete } = lex(s);
  if (incomplete && ctx.strict) return unresolvable('the command has an unterminated quote, substitution or here-document');
  for (const cmd of commands) {
    const v = classifySimple(cmd, ctx);
    if (v) return v;
  }
  return null;
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

export function classifyCommand(command, { trustedLauncher = [], platform = process.platform } = {}) {
  const text = String(command ?? '');
  if (text.length > MAX_INPUT) return unresolvable('the command is too long to check');
  if (isTrustedPublish(text.trim(), trustedLauncher, platform)) return { outward: false, riverwrightPublish: true };
  return classifyScript(text, makeCtx(0, true, { used: 0 })) ?? { outward: false };
}
