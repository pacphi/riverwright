// Installs Lock 1 into a clone (core spec §7.1): every push URL disabled, the local credential helper
// emptied, and the pre-push hook that runs "riverwright guard pre-push". Everything is validated before
// anything is changed, and a hook that is not ours is never overwritten (ADR-0008).
//
// Error codes: NOT_A_REPO, NOT_CLONE_ROOT (cloneDir is not the top of its own work tree), HOOKS_PATH_SET (any
// core.hooksPath, even an empty one), HOOK_EXISTS (a hook that is not ours, or any symbolic link or non-regular
// file; links are never followed), REMOTE_OUTSIDE_CLONE (a remote or push URL that lives outside the clone's own
// config), BAD_HOME, BAD_SCRIPT, GIT_FAILED.
//
// Order of changes (M5): validate everything, then (1) the hook, (2) the empty credential helper, (3) each
// remote's push URL in one write, (4) verify. The hook comes first, so no mid-way failure leaves the
// credential helper reachable while pushes are unchecked; the helper is cleared before the remotes, so a
// failure while disabling URLs does not leave credentials reachable either.
//
// Effective credential helpers (I4): `git config --includes -z --get-regexp '^credential\..*helper$'` lists the
// helpers of every scope (system, global, local, worktree, environment, includes) in the order git applies them.
// An empty plain `credential.helper` resets the list, so only entries after the last reset are live. URL-scoped
// keys (credential.<url>.helper) are counted as live too, whatever the URL, because the remote may be any host.
import fs from 'node:fs';
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

async function gitOut(cloneDir, args, what) {
  const r = await git(cloneDir, args);
  if (r.code !== 0) throw new RiverwrightError('GIT_FAILED', `${what}: ${printable(r.stderr.trim())}`);
  return r.stdout;
}

const real = (p) => fs.realpathSync.native(p);

// cloneDir must be the top of its own work tree, so a subdirectory of someone else's repository is never edited (I3).
async function assertCloneRoot(cloneDir) {
  let want;
  try { want = real(cloneDir); } catch { throw new RiverwrightError('NOT_A_REPO', `${printable(cloneDir)} is not a git repository`); }
  const top = await git(cloneDir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout.trim()) throw new RiverwrightError('NOT_A_REPO', `${printable(cloneDir)} is not a git repository`);
  let got;
  try { got = real(top.stdout.trim()); } catch { throw new RiverwrightError('NOT_A_REPO', `${printable(cloneDir)} is not a git repository`); }
  const same = process.platform === 'win32' || process.platform === 'darwin' ? got.toLowerCase() === want.toLowerCase() : got === want;
  if (!same) throw new RiverwrightError('NOT_CLONE_ROOT', `${printable(cloneDir)} is inside the work tree of ${printable(got)}, not a clone of its own, so nothing was changed`);
}

async function hooksDir(cloneDir) {
  // In a linked worktree (.git is a file) this is the shared hooks directory of the main repository.
  const out = await gitOut(cloneDir, ['rev-parse', '--git-path', 'hooks'], `could not find the hooks directory of ${printable(cloneDir)}`);
  if (!out.trim()) throw new RiverwrightError('GIT_FAILED', `could not find the hooks directory of ${printable(cloneDir)}`);
  return path.resolve(cloneDir, out.trim());
}

// core.hooksPath in any scope, set to anything at all (an empty value makes git look in the work tree and run nothing).
async function hooksPathValue(cloneDir) {
  const r = await git(cloneDir, ['config', '--get-all', 'core.hooksPath']);
  if (r.code === 1) return null;
  if (r.code !== 0) throw new RiverwrightError('GIT_FAILED', `could not read core.hooksPath: ${printable(r.stderr.trim())}`);
  return r.stdout.split('\n').filter((l, i, a) => i < a.length - 1).pop() ?? '';
}
const hooksPathProblem = (v) => `core.hooksPath is set (${v.trim() ? printable(v.trim()) : 'empty'}), so the pre-push hook does not run`;

async function remoteNames(cloneDir) {
  const out = await gitOut(cloneDir, ['remote'], 'could not list the remotes');
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Every remote must live in the clone's own config with no push URL from an outer scope (M4), or we cannot disable it.
async function assertRemotesLocal(cloneDir, names) {
  for (const name of names) {
    const label = JSON.stringify(printable(name));
    const url = await git(cloneDir, ['config', '--local', '--get', `remote.${name}.url`]);
    if (url.code !== 0) throw new RiverwrightError('REMOTE_OUTSIDE_CLONE', `remote ${label} is not defined in the clone's own config (it comes from global or system config), so its push URL cannot be disabled here. Nothing was changed.`);
    const r = await git(cloneDir, ['config', '--show-scope', '-z', '--get-all', `remote.${name}.pushurl`]);
    if (r.code !== 0) continue;
    const parts = r.stdout.split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      if (parts[i] !== 'local') throw new RiverwrightError('REMOTE_OUTSIDE_CLONE', `remote ${label} has a push URL in ${printable(parts[i])} config, which this clone cannot override. Remove it there. Nothing was changed.`);
    }
  }
}

// Live credential helpers, in git's order: [{ key, value, local }]. See the header comment.
async function credentialEntries(cloneDir, extra = []) {
  const r = await git(cloneDir, ['config', ...extra, '--includes', '-z', '--get-regexp', '^credential\\..*helper$']);
  if (r.code === 1) return [];
  if (r.code !== 0) throw new RiverwrightError('GIT_FAILED', `could not read the credential helpers: ${printable(r.stderr.trim())}`);
  return r.stdout.split('\0').filter(Boolean).map((rec) => {
    const nl = rec.indexOf('\n');
    return nl < 0 ? { key: rec, value: '' } : { key: rec.slice(0, nl), value: rec.slice(nl + 1) };
  });
}

async function credentialProblems(cloneDir) {
  const all = await credentialEntries(cloneDir);
  let reset = -1;
  all.forEach((e, i) => { if (e.key === 'credential.helper' && e.value === '') reset = i; });
  const problems = [];
  const localList = await credentialEntries(cloneDir, ['--local']);
  if (!localList.some((e) => e.key === 'credential.helper' && e.value === '')) problems.push('the local git credential helper list is not reset (no empty credential.helper in the clone config)');
  const live = all.slice(reset + 1).filter((e) => e.value !== '');
  if (live.length > 0) problems.push(`a git credential helper is still active after the reset (${live.map((e) => printable(e.key)).join(', ')})`);
  return problems;
}

// Ours only when it has exactly the shape renderPrePushHook produces: the shebang, comment lines starting with
// the marker, and the single exec line. A user hook that merely mentions the marker, or that has anything else
// added to it, is theirs and is never replaced. The paths exclude the characters renderPrePushHook refuses.
function isOurs(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  if (lines.length < 3 || lines[0] !== '#!/bin/sh') return false;
  if (!lines[1].startsWith(`# ${HOOK_MARKER}.`)) return false;
  const last = lines.length - 1;
  for (let i = 1; i < last; i++) if (!lines[i].startsWith('#')) return false;
  return /^exec node "[^"$`%\r\n]+" guard pre-push( --home "[^"$`%\r\n]+")? -- "\$@"$/.test(lines[last]);
}

// { state: 'absent' } | { state: 'file', text, mode } | { state: 'other', why }. A link is never followed (M2).
function readHook(hookFile) {
  let st;
  try { st = fs.lstatSync(hookFile); } catch (e) { return e.code === 'ENOENT' ? { state: 'absent' } : { state: 'other', why: 'cannot be inspected' }; }
  if (st.isSymbolicLink()) return { state: 'other', why: 'is a symbolic link' };
  if (!st.isFile()) return { state: 'other', why: 'is not a regular file' };
  try {
    const text = readBounded(hookFile, HOOK_MAX);
    return text === null ? { state: 'absent' } : { state: 'file', text, mode: st.mode };
  } catch {
    return { state: 'other', why: 'cannot be read as a regular file under 16 KiB' };
  }
}
// Git skips a hook that is not executable. On Windows git does not use the mode at all, so the bit is not checked there.
const executable = (mode) => process.platform === 'win32' || (mode & 0o100) !== 0;

function wantedHook(scriptPath, home) {
  if (home === undefined || home === null || home === '') throw new RiverwrightError('BAD_HOME', 'the workspace home is required, so the hook can carry --home');
  if (typeof scriptPath !== 'string' || !scriptPath) throw new RiverwrightError('BAD_SCRIPT', 'the script path is required');
  let isFile = false;
  try { isFile = fs.statSync(scriptPath).isFile(); } catch { /* reported below */ }
  if (!isFile) throw new RiverwrightError('BAD_SCRIPT', `the script ${printable(scriptPath)} does not exist, so a hook pointing at it would block every push`);
  return renderPrePushHook(scriptPath, { home: workspaceHomeFromArg(home) });
}

export async function installGuard({ cloneDir, scriptPath, home }) {
  const wanted = wantedHook(scriptPath, home);
  await assertCloneRoot(cloneDir);
  const hooksPath = await hooksPathValue(cloneDir);
  if (hooksPath !== null) {
    throw new RiverwrightError('HOOKS_PATH_SET', `${hooksPathProblem(hooksPath)}; a hook written to the clone's own hooks directory would not run. Unset it or install the guard yourself.`);
  }
  const dir = await hooksDir(cloneDir);
  const hookFile = path.join(dir, 'pre-push');
  const existing = readHook(hookFile);
  let hook = 'installed';
  if (existing.state === 'other') {
    throw new RiverwrightError('HOOK_EXISTS', `${printable(hookFile)} ${existing.why}, so it was left alone (links are never followed) and nothing was changed. Move it aside or add "riverwright guard pre-push" to your own hook.`);
  }
  if (existing.state === 'file') {
    if (!isOurs(existing.text)) {
      throw new RiverwrightError('HOOK_EXISTS', `${printable(hookFile)} is a pre-push hook Riverwright did not write, so it was left alone and nothing was changed. Add "riverwright guard pre-push" to it yourself, or move it aside.`);
    }
    hook = existing.text === wanted && executable(existing.mode) ? 'unchanged' : 'updated';
  }
  const remotes = await remoteNames(cloneDir);
  await assertRemotesLocal(cloneDir, remotes);

  // 1. The hook first: if a later step fails, pushes are already checked.
  if (hook !== 'unchanged') writeFileAtomic(hookFile, wanted, { mode: 0o755 });
  // 2. The credential helper next: drop local helpers (URL-scoped ones too), then append the empty reset, so the
  //    reset is the last local entry and nothing configured elsewhere (earlier scopes) applies.
  for (const e of await credentialEntries(cloneDir, ['--local'])) {
    const cleared = await git(cloneDir, ['config', '--local', '--unset-all', e.key]);
    if (cleared.code !== 0 && cleared.code !== 5) throw new RiverwrightError('GIT_FAILED', `could not clear ${printable(e.key)}: ${printable(cleared.stderr.trim())}`);
  }
  await gitOut(cloneDir, ['config', '--local', '--add', 'credential.helper', ''], 'could not clear the credential helper');
  // 3. Each remote's push URLs in one write (replace-all collapses several into the one disabled value).
  for (const name of remotes) {
    await gitOut(cloneDir, ['config', '--local', '--replace-all', `remote.${name}.pushurl`, DISABLED_PUSH_URL], `could not disable the push URL of remote ${JSON.stringify(printable(name))}`);
  }
  // 4. Verify what git now resolves (insteadOf rewrites, helpers from the environment or a worktree config).
  const problems = await pushUrlProblems(cloneDir, remotes);
  problems.push(...await credentialProblems(cloneDir));
  if (problems.length) throw new RiverwrightError('GIT_FAILED', `the guard was installed but git still resolves it differently: ${problems.join('; ')}`);
  return { remotesDisabled: remotes, credentialHelperCleared: true, hook, hookFile };
}

async function pushUrlProblems(cloneDir, names) {
  const problems = [];
  for (const name of names) {
    const r = await git(cloneDir, ['remote', 'get-url', '--push', '--all', name]);
    const urls = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (r.code !== 0 || urls.length !== 1 || urls[0] !== DISABLED_PUSH_URL) problems.push(`the push URL of remote ${JSON.stringify(printable(name))} is not disabled`);
  }
  return problems;
}

// Read-only: what is still true of an installed guard. `doctor` prints these problems.
export async function checkGuard({ cloneDir, scriptPath, home }) {
  const wanted = wantedHook(scriptPath, home);
  await assertCloneRoot(cloneDir);
  const problems = await pushUrlProblems(cloneDir, await remoteNames(cloneDir));
  problems.push(...await credentialProblems(cloneDir));
  const hooksPath = await hooksPathValue(cloneDir);
  if (hooksPath !== null) {
    problems.push(hooksPathProblem(hooksPath));
    return { ok: false, problems };
  }
  const hookFile = path.join(await hooksDir(cloneDir), 'pre-push');
  const h = readHook(hookFile);
  if (h.state === 'absent') problems.push('the pre-push hook is missing');
  else if (h.state === 'other') problems.push(`the pre-push hook ${h.why}`);
  else if (h.text !== wanted) problems.push('the pre-push hook is not the one Riverwright installs for this workspace');
  else if (!executable(h.mode)) problems.push('the pre-push hook is not executable, so git skips it');
  return { ok: problems.length === 0, problems };
}
