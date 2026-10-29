// Installs Lock 1 into a clone (core spec §7.1): every push URL disabled, the local credential helper
// emptied, and the pre-push hook that runs "riverwright guard pre-push". Everything is validated before
// anything is changed, and a hook that is not ours is never overwritten (ADR-0008).
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';
import { runFile } from './exec.mjs';
import { readBounded, writeFileAtomic } from './fsx.mjs';
import { renderPrePushHook } from './guard.mjs';
import { workspaceHomeFromArg } from './paths.mjs';
import { printable } from './printable.mjs';

export const DISABLED_PUSH_URL = 'DISABLED_BY_RIVERWRIGHT';
export const HOOK_MARKER = 'Installed by Riverwright';

// A hook this size is not ours; it is never read in full.
const HOOK_MAX = 16 * 1024;

// Variables that move git to a different repository or index than the clone we were asked about.
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM'];

function gitEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (REPO_ENV.includes(k.toUpperCase())) delete env[k];
  return env;
}

const git = (cloneDir, args) => runFile('git', args, { cwd: cloneDir, env: gitEnv() });

async function hooksDir(cloneDir) {
  const inside = await git(cloneDir, ['rev-parse', '--git-dir']);
  if (inside.code !== 0) throw new RiverwrightError('NOT_A_REPO', `${printable(cloneDir)} is not a git repository`);
  // In a linked worktree (.git is a file) this is the shared hooks directory of the main repository.
  const r = await git(cloneDir, ['rev-parse', '--git-path', 'hooks']);
  if (r.code !== 0 || !r.stdout.trim()) throw new RiverwrightError('GIT_FAILED', `could not find the hooks directory of ${printable(cloneDir)}: ${printable(r.stderr.trim())}`);
  return path.resolve(cloneDir, r.stdout.trim());
}

async function remoteNames(cloneDir) {
  const r = await git(cloneDir, ['remote']);
  if (r.code !== 0) throw new RiverwrightError('GIT_FAILED', `could not list the remotes: ${printable(r.stderr.trim())}`);
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Ours only when it has exactly the shape renderPrePushHook produces: the shebang, comment lines starting with
// the marker, and the single exec line. A user hook that merely mentions the marker, or that has anything else
// added to it, is theirs and is never replaced.
function isOurs(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (lines.length < 3 || lines[0] !== '#!/bin/sh') return false;
  if (!lines[1].startsWith(`# ${HOOK_MARKER}.`)) return false;
  const last = lines.length - 1;
  for (let i = 1; i < last; i++) if (!lines[i].startsWith('#')) return false;
  return /^exec node "[^"]+" guard pre-push( --home "[^"]+")? -- "\$@"$/.test(lines[last]);
}

// 'absent', or the text of a regular file, or null when something is there that is not safe to read.
function readHook(hookFile) {
  try {
    const text = readBounded(hookFile, HOOK_MAX);
    return text === null ? 'absent' : text;
  } catch {
    return null;
  }
}

function wantedHook(scriptPath, home) {
  const h = home === undefined || home === null ? home : workspaceHomeFromArg(home);
  return renderPrePushHook(scriptPath, { home: h });
}

export async function installGuard({ cloneDir, scriptPath, home }) {
  const dir = await hooksDir(cloneDir);
  const hooksPath = await git(cloneDir, ['config', '--get', 'core.hooksPath']);
  if (hooksPath.code === 0 && hooksPath.stdout.trim()) {
    throw new RiverwrightError('HOOKS_PATH_SET', `core.hooksPath is set (${printable(hooksPath.stdout.trim())}), so a hook written to ${printable(dir)} would not run. Unset it or install the guard yourself.`);
  }
  const hookFile = path.join(dir, 'pre-push');
  const wanted = wantedHook(scriptPath, home);
  const existing = readHook(hookFile);
  let hook = 'installed';
  if (existing !== 'absent') {
    if (existing === null || !isOurs(existing)) {
      throw new RiverwrightError('HOOK_EXISTS', `${printable(hookFile)} is a pre-push hook Riverwright did not write, so it was left alone and nothing was changed. Add "riverwright guard pre-push" to it yourself, or move it aside.`);
    }
    hook = existing === wanted ? 'unchanged' : 'updated';
  }
  const remotes = await remoteNames(cloneDir);
  // The hook goes in first: if a later step fails, pushes are already checked.
  if (hook !== 'unchanged') writeFileAtomic(hookFile, wanted, { mode: 0o755 });
  for (const name of remotes) {
    // A remote with several push URLs cannot be set in one step; clear them first (exit 5 means there were none).
    const cleared = await git(cloneDir, ['config', '--local', '--unset-all', `remote.${name}.pushurl`]);
    if (cleared.code !== 0 && cleared.code !== 5) throw new RiverwrightError('GIT_FAILED', `could not clear the push URLs of remote ${JSON.stringify(printable(name))}: ${printable(cleared.stderr.trim())}`);
    const r = await git(cloneDir, ['remote', 'set-url', '--push', name, DISABLED_PUSH_URL]);
    if (r.code !== 0) throw new RiverwrightError('GIT_FAILED', `could not disable the push URL of remote ${JSON.stringify(printable(name))}: ${printable(r.stderr.trim())}`);
  }
  // An empty value resets git's list of credential helpers, so nothing configured elsewhere applies here.
  const helper = await git(cloneDir, ['config', '--local', '--replace-all', 'credential.helper', '']);
  if (helper.code !== 0) throw new RiverwrightError('GIT_FAILED', `could not clear the credential helper: ${printable(helper.stderr.trim())}`);
  return { remotesDisabled: remotes, credentialHelperCleared: true, hook, hookFile };
}

// Read-only: what is still true of an installed guard. `doctor` prints these problems.
export async function checkGuard({ cloneDir, scriptPath, home }) {
  const problems = [];
  for (const name of await remoteNames(cloneDir)) {
    const r = await git(cloneDir, ['remote', 'get-url', '--push', '--all', name]);
    const urls = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (r.code !== 0 || urls.length !== 1 || urls[0] !== DISABLED_PUSH_URL) problems.push(`the push URL of remote ${JSON.stringify(printable(name))} is not disabled`);
  }
  const helpers = await git(cloneDir, ['config', '--local', '--get-all', 'credential.helper']);
  const listed = helpers.code === 0 ? helpers.stdout.split('\n').slice(0, -1) : null;
  if (!listed || listed.length !== 1 || listed[0] !== '') problems.push('the local git credential helper list is not empty');
  const hooksPath = await git(cloneDir, ['config', '--get', 'core.hooksPath']);
  if (hooksPath.code === 0 && hooksPath.stdout.trim()) problems.push('core.hooksPath is set, so the pre-push hook does not run');
  const hookFile = path.join(await hooksDir(cloneDir), 'pre-push');
  const text = readHook(hookFile);
  if (text === 'absent') problems.push('the pre-push hook is missing');
  else if (text === null) problems.push('the pre-push hook cannot be read as a regular file');
  else if (text !== wantedHook(scriptPath, home)) problems.push('the pre-push hook is not the one Riverwright installs for this workspace');
  return { ok: problems.length === 0, problems };
}
