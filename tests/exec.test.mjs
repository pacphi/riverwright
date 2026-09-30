import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runFile, quoteCmdArg, cmdShimCommandLine, parseNpmCmdShim, resolveHostLaunch, buildHookCommand, launcherHookCommand } from '../scripts/lib/exec.mjs';
import { HOSTS } from '../scripts/lib/hosts.mjs';
import { spawnSync } from 'node:child_process';
import { ROOT, tmpDir } from './helpers.mjs';

test('HOSTS matches the story contract', () => {
  assert.deepEqual(HOSTS, ['claude-code', 'codex', 'gemini-cli', 'cursor', 'grok-build', 'hermes-agent']);
});

test('runFile runs a program without a shell and captures output', async () => {
  const r = await runFile(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a b; echo pwned']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'a b; echo pwned');
});

test('runFile reports a missing program instead of throwing', async () => {
  const r = await runFile('definitely-not-a-real-program-riverwright', ['--version']);
  assert.equal(r.code, null);
  assert.equal(r.error, 'not-found');
});

test('quoteCmdArg double-escapes cmd.exe metacharacters', () => {
  assert.equal(quoteCmdArg('a b'), '^^^"a^^^ b^^^"');
  assert.equal(quoteCmdArg('x&y|z'), '^^^"x^^^&y^^^|z^^^"');
  assert.equal(quoteCmdArg('C:\\dir\\'), '^^^"C:\\dir\\\\^^^"');
});

test('quoteCmdArg refuses characters cmd.exe cannot carry safely', () => {
  for (const bad of ['50%', 'hi!', 'say "x"', 'a\nb']) assert.throws(() => quoteCmdArg(bad), /cannot be passed safely/);
});

test('cmdShimCommandLine escapes the program path', () => {
  assert.equal(cmdShimCommandLine('C:\\Program Files\\nodejs\\codex.cmd', ['--version']), 'C:\\Program^ Files\\nodejs\\codex.cmd ^^^"--version^^^"');
});

const SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

test('parseNpmCmdShim finds the JavaScript entry', () => {
  const shimPath = path.join('C:', 'npm', 'codex.cmd');
  assert.equal(parseNpmCmdShim(SHIM, shimPath), path.join(path.dirname(shimPath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  assert.equal(parseNpmCmdShim('@echo off\r\nfoo.exe %*', shimPath), null);
});

test('resolveHostLaunch runs an npm shim with node on Windows', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'codex.cmd'), SHIM);
  const r = resolveHostLaunch('codex', { platform: 'win32', env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' } });
  assert.equal(r.kind, 'node');
  assert.equal(r.file, process.execPath);
  assert.equal(r.prefixArgs[0], path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
});

test('resolveHostLaunch leaves POSIX programs to execFile', () => {
  assert.deepEqual(resolveHostLaunch('codex', { platform: 'darwin', env: {} }), { kind: 'plain', file: 'codex', prefixArgs: [] });
});

test('buildHookCommand quotes paths with spaces and refuses unsafe paths', () => {
  assert.equal(
    buildHookCommand('/Users/Jane Doe/Library/Application Support/riverwright/scripts/riverwright.mjs', 'claude-code'),
    'node "/Users/Jane Doe/Library/Application Support/riverwright/scripts/riverwright.mjs" hook claude-code',
  );
  assert.equal(buildHookCommand('C:\\Program Files\\riverwright\\scripts\\riverwright.mjs', 'cursor'), 'node "C:\\Program Files\\riverwright\\scripts\\riverwright.mjs" hook cursor');
  for (const bad of ['relative/riverwright.mjs', '/a"b/riverwright.mjs', '/a$HOME/riverwright.mjs', '/a`x`/riverwright.mjs', 'C:\\50%\\riverwright.mjs']) {
    assert.throws(() => buildHookCommand(bad, 'codex'), /path|absolute/, bad);
  }
  assert.throws(() => buildHookCommand('/a/riverwright.mjs', 'notahost'), /unknown host/);
});

const posixOnly = { skip: process.platform === 'win32' };

test('launcherHookCommand goes through the launcher, which denies (exit 2) when node is missing', posixOnly, () => {
  const cmd = launcherHookCommand(ROOT, 'claude-code', { platform: 'darwin' });
  const r = spawnSync('/bin/sh', ['-c', cmd], { input: '{}', encoding: 'utf8', env: { PATH: '/nonexistent' } });
  assert.equal(r.status, 2, `${cmd}\n${r.stderr}`);
  assert.match(r.stderr, /needs Node\.js 24/);
});

test('launcherHookCommand runs the hook when node is present', posixOnly, () => {
  const cmd = launcherHookCommand(ROOT, 'codex', { platform: 'linux', home: tmpDir('riverwright-home-') });
  const r = spawnSync('/bin/sh', ['-c', cmd], { input: '{}', encoding: 'utf8', env: process.env, cwd: tmpDir() });
  assert.equal(r.status, 0, r.stderr);
});

test('launcherHookCommand quotes paths with spaces for sh, cmd and PowerShell', () => {
  assert.equal(
    launcherHookCommand('/Users/Jane Doe/Library/Application Support/riverwright', 'claude-code', { platform: 'darwin' }),
    '/bin/sh "/Users/Jane Doe/Library/Application Support/riverwright/bin/riverwright" hook claude-code',
  );
  assert.equal(
    launcherHookCommand('C:\\Program Files\\riverwright', 'cursor', { platform: 'win32' }),
    '"C:\\Program Files\\riverwright\\bin\\riverwright.cmd" hook cursor',
  );
  assert.equal(
    launcherHookCommand('C:\\Program Files\\riverwright', 'codex', { platform: 'win32', shell: 'powershell' }),
    '& "C:\\Program Files\\riverwright\\bin\\riverwright.cmd" hook codex; exit $LASTEXITCODE',
  );
  assert.equal(
    launcherHookCommand('C:\\Program Files\\riverwright', 'claude-code', { platform: 'win32', shell: 'sh' }),
    '/bin/sh "C:/Program Files/riverwright/bin/riverwright" hook claude-code',
  );
});

test('launcherHookCommand refuses relative and unquotable roots, unknown hosts and shells', () => {
  for (const bad of ['relative/riverwright', '/a"b/riverwright', '/a$HOME/riverwright', '/a`x`/riverwright', 'C:\\50%\\riverwright', '/a\nb', '/a\u201Cb']) {
    assert.throws(() => launcherHookCommand(bad, 'codex', { platform: 'linux' }), /UNSAFE_PATH|path|absolute/, JSON.stringify(bad));
  }
  assert.throws(() => launcherHookCommand('/a/riverwright', 'notahost', { platform: 'linux' }), /unknown host/);
  assert.throws(() => launcherHookCommand('/a/riverwright', 'codex', { platform: 'linux', shell: 'fish' }), /unknown shell/);
});

test('Windows launcher hook command denies (exit 2) under cmd when node is missing', { skip: process.platform !== 'win32' }, () => {
  const cmd = launcherHookCommand(ROOT, 'claude-code', { platform: 'win32' });
  const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], {
    input: '{}', encoding: 'utf8', windowsVerbatimArguments: true, env: { PATH: 'C:\\nonexistent', SystemRoot: process.env.SystemRoot },
  });
  assert.equal(r.status, 2, r.stderr);
});

test('Windows launcher hook command denies (exit 2) under PowerShell when node is missing', { skip: process.platform !== 'win32' }, () => {
  const cmd = launcherHookCommand(ROOT, 'codex', { platform: 'win32', shell: 'powershell' });
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // PowerShell starts a .cmd through cmd.exe, which it finds via ComSpec; node stays absent.
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    input: '{}', encoding: 'utf8', env: { PATH: 'C:\\nonexistent', SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec },
  });
  assert.equal(r.status, 2, r.stderr);
});
