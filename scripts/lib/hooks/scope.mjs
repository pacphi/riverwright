// Decides whether a command reaches into the upstream-pr-filer workspace. Paths are resolved the way the
// shell would see them: ~, $HOME, ${HOME}, $UPF_HOME, %USERPROFILE% and $env:USERPROFILE are expanded,
// relative paths are resolved against the payload cwd (following cd/pushd), and symlinks are resolved.
import os from 'node:os';
import path from 'node:path';
import { isInside, realish } from '../paths.mjs';
import { lex } from './shell.mjs';

const KNOWN_VAR = /\$\{(HOME|UPF_HOME|PWD|USERPROFILE)\}|\$env:(HOME|UPF_HOME|PWD|USERPROFILE)\b|\$(HOME|UPF_HOME|PWD|USERPROFILE)\b|%(HOME|UPF_HOME|USERPROFILE)%/gi;

function expand(value, vars) {
  let v = String(value);
  if (v === '~' || v.startsWith('~/') || v.startsWith('~\\')) v = `${vars.HOME}${v.slice(1)}`;
  return v.replace(KNOWN_VAR, (m, a, b, c, d) => vars[String(a || b || c || d).toUpperCase()] ?? m);
}

function resolvePath(value, vars, cwd) {
  const v = expand(value, vars);
  if (!v || /[$`%]/.test(v)) return null;
  return path.isAbsolute(v) ? v : path.resolve(cwd, v);
}

// Every value a word could hand to a program as a path: the word, and what follows "=" (--git-dir=X).
function candidates(word) {
  const out = [word.value];
  const eq = word.value.indexOf('=');
  if (eq > 0) out.push(word.value.slice(eq + 1));
  return out;
}

function walk(text, ctx, depth) {
  const { commands } = lex(text);
  let cwd = ctx.cwd;
  for (const cmd of commands) {
    const words = [...cmd.words, ...cmd.redirects, ...cmd.herestrings];
    const vars = { ...ctx.vars, PWD: cwd };
    for (const w of words) {
      for (const c of candidates(w)) {
        const p = resolvePath(c, vars, cwd);
        if (p && isInside(p, ctx.home)) return true;
      }
      if (depth < 4) {
        for (const sub of w.subs) if (walk(sub, { ...ctx, cwd }, depth + 1)) return true;
        if (/\s/.test(w.value) && walk(w.value, { ...ctx, cwd }, depth + 1)) return true;
      }
    }
    if (depth < 4) for (const h of cmd.heredocs) if (walk(h.text, { ...ctx, cwd }, depth + 1)) return true;
    const prog = cmd.words[0]?.value;
    if ((prog === 'cd' || prog === 'pushd') && cmd.words[1]) {
      const next = resolvePath(cmd.words[1].value, vars, cwd);
      if (next) cwd = next;
    }
  }
  return false;
}

export function mentionsHome(command, home, platform) {
  const fold = (s) => {
    const t = String(s).replace(/\\/g, '/');
    return platform === 'win32' || platform === 'darwin' ? t.toLowerCase() : t;
  };
  const text = fold(command);
  return [home, realish(home)].some((h) => text.includes(fold(h)));
}

export function touchesHome(command, { home, cwd, env = {}, platform = process.platform }) {
  const userHome = env.HOME || env.USERPROFILE || os.homedir();
  const vars = { HOME: userHome, USERPROFILE: env.USERPROFILE || userHome, UPF_HOME: home, PWD: cwd };
  // cmd.exe and PowerShell paths use backslashes, which a POSIX lexer would read as escapes.
  const text = platform === 'win32' ? String(command).replace(/\\/g, '/') : String(command);
  return mentionsHome(command, home, platform) || walk(text, { home, cwd, vars }, 0);
}
