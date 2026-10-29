// Finds credential routes an agent in this account could use without Riverwright (ADR-0010). It reports
// names, counts and file names, never a value. The only file content it reads is the first line of each
// file in ~/.ssh, to see whether it is a private key; the rest of the file is never read.
// An audit must never read as "safe" when it simply could not tell: every probe that cannot decide
// (tool missing, timeout, unexpected exit code, unreadable path) reports an "unchecked:" finding.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFile } from './exec.mjs';

const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
const KNOWN_HELPERS = new Set(['osxkeychain', 'manager', 'manager-core', 'store', 'cache', 'libsecret', 'wincred']);
const KEY_HEADER = /^(?:﻿)?(?:-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|PuTTY-User-Key-File-\d+:)/;
const SAFE_NAME = /^[A-Za-z0-9._@+-]{1,64}$/;
const PROBE_MS = 10000;

const WHY = {
  env: 'Anything running as this account with this variable set can use it to act on GitHub.',
  ghLogin: 'While this login is active, anything running as this account can use the gh command to act on GitHub.',
  ghConfig: 'This file may hold a token that anything running as this account could read. It may also be empty if the login lives in the system keyring.',
  helper: 'When git asks for a password, this helper may supply a saved one, so a push may work without Riverwright. It may hold nothing for github.com.',
  agent: 'Anything running as this account that can reach this agent can sign in with these keys.',
  keyFile: 'If this key is unprotected and registered with GitHub, anything running as this account could use it. A passphrase or hardware key prevents that.',
  unchecked: 'Riverwright could not tell, so this is not a sign that you are safe.',
};
const finding = (id, what, why, fix) => ({ id, what, why, fix });

const REASON = {
  'not-found': 'is not installed or is not on the PATH',
  'not-executable': 'could not be run',
  timeout: 'did not answer in time',
};
const unchecked = (id, subject, reason, fix) => finding(`unchecked:${id}`, `Riverwright could not check ${subject}: ${reason}.`, WHY.unchecked, fix);
const whyUnknown = (r) => (r.error ? (REASON[r.error] ?? 'failed') : 'gave an unexpected result');

// On Windows a bare name is searched for in the current directory first, so a planted gh.exe in a
// cloned repository could run. Resolve against PATH ourselves and skip relative entries.
export function resolveProgram(name, { env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return name;
  const dirs = String(env.PATH ?? env.Path ?? '').split(';').filter((d) => d && path.win32.isAbsolute(d));
  for (const dir of dirs) {
    for (const ext of ['.exe', '.com']) {
      const candidate = path.win32.join(dir, `${name}${ext}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

// Reduces one credential.helper value to a kind name from a fixed list, or "custom". Arguments, paths and
// any URL with user:token@ in them are dropped here and never reach a finding.
export function helperKind(value) {
  let v = String(value ?? '').trim();
  if (!v) return null; // an empty value only resets the list
  const shell = v.startsWith('!');
  if (shell) v = v.slice(1).trim();
  const m = /^("[^"]*"|'[^']*'|\S+)(?:\s+([\s\S]*))?$/.exec(v);
  if (!m) return 'custom';
  const token = m[1].replace(/^["']|["']$/g, '');
  const rest = m[2] ?? '';
  const hasPath = /[\\/]/.test(token);
  const base = token.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  if (shell) return base === 'gh' && /^auth\s+git-credential\b/.test(rest) ? 'gh' : 'custom';
  if (hasPath) return base.startsWith('git-credential-') && KNOWN_HELPERS.has(base.slice(15)) ? base.slice(15) : 'custom';
  const name = base.startsWith('git-credential-') ? base.slice(15) : base;
  return KNOWN_HELPERS.has(name) ? name : 'custom';
}

function ghHostsCandidates({ env, home, platform }) {
  const dirs = [];
  if (env.GH_CONFIG_DIR) dirs.push(env.GH_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME) dirs.push(path.join(env.XDG_CONFIG_HOME, 'gh'));
  if (platform === 'win32') dirs.push(path.join(env.AppData || path.join(home, 'AppData', 'Roaming'), 'GitHub CLI'));
  dirs.push(path.join(home, '.config', 'gh'));
  return dirs.map((d) => path.join(d, 'hosts.yml'));
}

function firstLine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(100);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('latin1', 0, n).split(/\r?\n/)[0];
  } finally {
    fs.closeSync(fd);
  }
}

export async function auditAmbient({ env = process.env, userHome, homedir = os.homedir, platform = process.platform, run = runFile } = {}) {
  const out = [];
  const probe = async (name, args) => {
    const file = resolveProgram(name, { env, platform });
    if (file === null) return { code: null, stdout: '', stderr: '', error: 'not-found' };
    return run(file, args, { env, timeoutMs: PROBE_MS });
  };

  for (const name of TOKEN_VARS) {
    if (typeof env[name] === 'string' && env[name] !== '') out.push(finding(`env:${name}`, `The environment variable ${name} is set.`, WHY.env, `Unset ${name} in the shell that starts your agent.`));
  }

  // gh: exit status only. Any success means a login is present, even if another account is stale.
  const gh = await probe('gh', ['auth', 'status']);
  if (gh.code === 0) out.push(finding('gh-login', 'The GitHub CLI (gh) is logged in.', WHY.ghLogin, 'Run "gh auth logout" on the machine that runs the agent, or use a separate account for it.'));
  else if (gh.code !== 1) out.push(unchecked('gh', 'whether the GitHub CLI (gh) is logged in', `gh ${whyUnknown(gh)}`, 'Run "gh auth status" yourself to see.'));

  // git: every scope (system, global, local, includes) and URL-scoped keys. Only the helper value is
  // used, and only to pick a name from a fixed list.
  const git = await probe('git', ['config', '--show-origin', '--get-regexp', '^credential\\..*helper$']);
  if (git.code === 0) {
    const names = new Set();
    for (const line of git.stdout.split('\n')) {
      if (!line.trim()) continue;
      const rest = line.includes('\t') ? line.slice(line.indexOf('\t') + 1) : line;
      const value = rest.replace(/^\S+\s*/, '');
      const kind = helperKind(value);
      if (kind) names.add(kind);
    }
    for (const n of [...names].sort()) {
      const what = n === 'custom' ? 'A custom git credential helper (a program or shell command) is configured.'
        : n === 'gh' ? 'git is set to use the GitHub CLI login as its credential helper (gh auth git-credential).'
          : `The git credential helper "${n}" is configured.`;
      out.push(finding(`git-helper:${n}`, what, WHY.helper, 'Run "git config --show-origin --get-regexp \'^credential\\..*helper$\'" to see which file sets it, and remove it there, or scope it to hosts other than github.com.'));
    }
  } else if (git.code !== 1) {
    out.push(unchecked('git-config', 'which git credential helpers are configured', `git ${whyUnknown(git)}`, 'Run "git config --show-origin --get-regexp \'^credential\\..*helper$\'" yourself to see.'));
  }

  // ssh-add: 0 = keys loaded, 1 = agent has none, 2 = no agent reachable. Those are answers.
  const agent = await probe('ssh-add', ['-l']);
  if (agent.code === 0) {
    const count = agent.stdout.split('\n').filter((l) => l.trim()).length;
    out.push(finding('ssh-agent', `An SSH agent holds ${count} key${count === 1 ? '' : 's'}.`, WHY.agent, 'If the agent runs on this machine, remove keys you do not need with "ssh-add -d <key file>", or add them with "ssh-add -c" so each use needs a confirmation. If it is forwarded from another machine, end the forwarding (ForwardAgent no, or ssh -a) instead of unloading keys.'));
  } else if (agent.code !== 1 && agent.code !== 2) {
    out.push(unchecked('ssh-add', 'whether an SSH agent holds keys', `ssh-add ${whyUnknown(agent)}`, 'Run "ssh-add -l" yourself to see.'));
  }

  const home = userHome || homedir();
  // ~/.ssh: a file counts as a private key when its first line is a private-key header. The rest is never read.
  const sshDir = path.join(home, '.ssh');
  let names = [];
  try {
    names = fs.readdirSync(sshDir).sort();
  } catch (e) {
    if (e?.code !== 'ENOENT') out.push(unchecked('ssh-dir', 'the private key files in ~/.ssh', 'the folder could not be read', 'Check the permissions of ~/.ssh and look for private key files yourself.'));
  }
  let unreadable = 0;
  let oddNames = 0;
  for (const f of names) {
    const full = path.join(sshDir, f);
    try {
      if (!fs.statSync(full).isFile()) continue;
      if (!KEY_HEADER.test(firstLine(full))) continue;
    } catch (e) {
      if (e?.code !== 'ENOENT') unreadable += 1;
      continue;
    }
    const fix = 'Protect it with a passphrase, or keep it on a hardware key.';
    if (SAFE_NAME.test(f)) out.push(finding(`ssh-key-file:${f}`, `The private key file ~/.ssh/${f} exists.`, WHY.keyFile, fix));
    else out.push(finding(`ssh-key-file:unusual-name-${++oddNames}`, 'A private key file with an unusual name exists in ~/.ssh.', WHY.keyFile, fix));
  }
  if (unreadable > 0) out.push(unchecked('ssh-key-files', 'some files in ~/.ssh', `${unreadable} of them could not be read`, 'Check their permissions and look for private key files yourself.'));

  // gh config: presence only, in every place gh may keep it.
  let ghConfig = false;
  let ghUnreadable = false;
  for (const file of ghHostsCandidates({ env, home, platform })) {
    try {
      if (fs.statSync(file).isFile()) ghConfig = true;
    } catch (e) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') ghUnreadable = true;
    }
  }
  if (ghConfig) out.push(finding('gh-config', 'A GitHub CLI config file (hosts.yml) exists.', WHY.ghConfig, 'Run "gh auth logout", or store the login in the system keyring.'));
  if (ghUnreadable) out.push(unchecked('gh-config', 'the GitHub CLI config file', 'its folder could not be read', 'Check the permissions of your gh config folder.'));
  return out;
}
