import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UpfError } from './errors.mjs';
import { HOSTS } from './hosts.mjs';

export function runFile(file, args = [], { cwd, env, timeoutMs = 30000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { cwd, env, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
          resolve({ code: null, stdout: '', stderr: '', error: error.code === 'ENOENT' ? 'not-found' : 'not-executable' });
        } else if (error && error.killed) {
          resolve({ code: null, stdout, stderr, error: 'timeout' });
        } else {
          resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr, error: null });
        }
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

// cmd.exe metacharacters (the set cross-spawn escapes). Arguments are double-escaped because npm
// .cmd shims pass %* through a second round of parsing.
const META = /([()\][%!^"`<>&|;, *?])/g;

export function quoteCmdArg(arg) {
  const s = String(arg);
  if (/[%!"\r\n\0]/.test(s)) {
    throw new UpfError('UNSAFE_ARG', `argument ${JSON.stringify(s)} cannot be passed safely through cmd.exe`);
  }
  const inner = s.replace(/(\\+)$/, '$1$1');
  return `"${inner}"`.replace(META, '^$1').replace(META, '^$1');
}

export function cmdShimCommandLine(file, args) {
  const f = String(file);
  if (/[%!"\r\n\0]/.test(f)) throw new UpfError('UNSAFE_PATH', `program path ${JSON.stringify(f)} cannot be passed safely through cmd.exe`);
  return [f.replace(META, '^$1'), ...args.map(quoteCmdArg)].join(' ');
}

export function parseNpmCmdShim(text, shimPath) {
  const m = /"%dp0%\\([^"]+?\.(?:c|m)?js)"/i.exec(String(text));
  if (!m) return null;
  return path.join(path.dirname(shimPath), ...m[1].split('\\'));
}

export function resolveHostLaunch(bin, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { kind: 'plain', file: bin, prefixArgs: [] };
  const dirs = String(env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const exts = String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase());
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${bin}${ext}`);
      if (!fs.existsSync(candidate)) continue;
      if (ext === '.exe' || ext === '.com') return { kind: 'exe', file: candidate, prefixArgs: [] };
      if (ext === '.cmd' || ext === '.bat') {
        const js = parseNpmCmdShim(fs.readFileSync(candidate, 'utf8'), candidate);
        if (js) return { kind: 'node', file: process.execPath, prefixArgs: [js] };
        return { kind: 'cmd', file: candidate, prefixArgs: [] };
      }
    }
  }
  return { kind: 'plain', file: bin, prefixArgs: [] };
}

// Characters no quoting survives in every shell: sh expands $ and `, cmd expands %, PowerShell treats
// typographic quotes as quotes.
const UNQUOTABLE = /["$`%\r\n\0“”„‘’]/;

function assertQuotablePath(p, what) {
  if (!(path.posix.isAbsolute(p) || path.win32.isAbsolute(p))) throw new UpfError('UNSAFE_PATH', `${what} must be absolute`);
  if (UNQUOTABLE.test(p)) throw new UpfError('UNSAFE_PATH', `path ${JSON.stringify(p)} cannot be quoted safely in every shell`);
}

// Fails OPEN when node is missing (the shell exits 127, which most hosts treat as "allow").
// Host adapters must use launcherHookCommand instead.
export function buildHookCommand(scriptPath, host) {
  if (!HOSTS.includes(host)) throw new UpfError('UNKNOWN_HOST', `unknown host "${host}"`);
  const p = String(scriptPath);
  assertQuotablePath(p, 'hook script path');
  return `node "${p}" hook ${host}`;
}

export const HOOK_SHELLS = ['sh', 'cmd', 'powershell'];

// The hook command a host runs. It goes through bin/upf or bin/upf.cmd, which exit 2 (deny) when node
// is missing. `shell` is the shell the host runs hook commands with: sh (POSIX, Git Bash), cmd, or
// PowerShell (whose -Command turns native exit codes other than 0/1 into 1 unless passed through).
export function launcherHookCommand(root, host, { platform = process.platform, shell } = {}) {
  if (!HOSTS.includes(host)) throw new UpfError('UNKNOWN_HOST', `unknown host "${host}"`);
  const r = String(root);
  assertQuotablePath(r, 'plugin root');
  const sh = shell ?? (platform === 'win32' ? 'cmd' : 'sh');
  if (!HOOK_SHELLS.includes(sh)) throw new UpfError('UNKNOWN_SHELL', `unknown shell "${sh}" (use ${HOOK_SHELLS.join(', ')})`);
  if (sh === 'sh') {
    // /bin/sh runs the launcher even if the plugin cache dropped its executable bit.
    const launcher = `${r.replace(/\\/g, '/').replace(/\/+$/, '')}/bin/upf`;
    return `/bin/sh "${launcher}" hook ${host}`;
  }
  const launcher = `${r.replace(/\//g, '\\').replace(/\\+$/, '')}\\bin\\upf.cmd`;
  if (sh === 'cmd') return `"${launcher}" hook ${host}`;
  return `& "${launcher}" hook ${host}; exit $LASTEXITCODE`;
}
