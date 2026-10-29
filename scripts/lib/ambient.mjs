// Finds credential routes an agent in this account could use without Riverwright (ADR-0010). It reports
// names, counts and file names, never a value, and it never reads a credential file. Riverwright cannot
// remove the user's own login; it can tell them plainly that it exists.
import fs from 'node:fs';
import path from 'node:path';
import { runFile } from './exec.mjs';

const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
const KNOWN_HELPERS = new Set(['osxkeychain', 'manager', 'manager-core', 'store', 'cache', 'libsecret', 'wincred', 'gh']);
const WHY = 'An agent running as this account can use it to publish without Riverwright.';

const finding = (id, what, fix) => ({ id, what, why: WHY, fix });

export async function auditAmbient({ env = process.env, userHome, run = runFile } = {}) {
  const out = [];
  for (const name of TOKEN_VARS) {
    if (typeof env[name] === 'string' && env[name] !== '') out.push(finding(`env:${name}`, `The environment variable ${name} is set.`, `Unset ${name} in the shell that starts your agent.`));
  }
  const gh = await run('gh', ['auth', 'status'], { timeoutMs: 10000 });
  if (gh.code === 0) out.push(finding('gh-login', 'The GitHub CLI (gh) is logged in.', 'Run "gh auth logout" on the machine that runs the agent, or use a separate account for it.'));
  const helpers = await run('git', ['config', '--global', '--get-all', 'credential.helper'], { timeoutMs: 10000 });
  if (helpers.code === 0) {
    const names = new Set();
    for (const line of helpers.stdout.split('\n')) {
      const first = line.trim().split(/\s+/)[0];
      if (!first) continue;
      names.add(KNOWN_HELPERS.has(first) ? first : 'custom');
    }
    for (const n of names) out.push(finding(`git-helper:${n}`, n === 'custom' ? 'A custom git credential helper is configured.' : `The git credential helper "${n}" is configured.`, 'Remove it from your global git config on the machine that runs the agent, or scope it to hosts other than github.com.'));
  }
  const agent = await run('ssh-add', ['-l'], { timeoutMs: 10000 });
  if (agent.code === 0) {
    const count = agent.stdout.split('\n').filter((l) => l.trim()).length;
    out.push(finding('ssh-agent', `An SSH agent holds ${count} key${count === 1 ? '' : 's'}.`, 'Run "ssh-add -D", or add keys with "ssh-add -c" so each use needs a confirmation.'));
  }
  if (userHome) {
    try {
      for (const f of fs.readdirSync(path.join(userHome, '.ssh')).sort()) {
        if (/^id_[A-Za-z0-9_]+$/.test(f)) out.push(finding(`ssh-key-file:${f}`, `The private key file ~/.ssh/${f} exists.`, 'Protect it with a passphrase, or keep it on a hardware key.'));
      }
    } catch { /* no ~/.ssh */ }
    if (fs.existsSync(path.join(userHome, '.config', 'gh', 'hosts.yml'))) {
      out.push(finding('gh-config', 'A GitHub CLI config file (~/.config/gh/hosts.yml) exists and may hold a token.', 'Run "gh auth logout", or store the login in the system keyring.'));
    }
  }
  return out;
}
