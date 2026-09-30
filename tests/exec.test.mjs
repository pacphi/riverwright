import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runFile, quoteCmdArg, cmdShimCommandLine, parseNpmCmdShim, resolveHostLaunch, buildHookCommand } from '../scripts/lib/exec.mjs';
import { HOSTS } from '../scripts/lib/hosts.mjs';
import { tmpDir } from './helpers.mjs';

test('HOSTS matches the story contract', () => {
  assert.deepEqual(HOSTS, ['claude-code', 'codex', 'gemini-cli', 'cursor', 'grok-build', 'hermes-agent']);
});

test('runFile runs a program without a shell and captures output', async () => {
  const r = await runFile(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a b; echo pwned']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'a b; echo pwned');
});

test('runFile reports a missing program instead of throwing', async () => {
  const r = await runFile('definitely-not-a-real-program-upf', ['--version']);
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
    buildHookCommand('/Users/Jane Doe/Library/Application Support/upf/scripts/upf.mjs', 'claude-code'),
    'node "/Users/Jane Doe/Library/Application Support/upf/scripts/upf.mjs" hook claude-code',
  );
  assert.equal(buildHookCommand('C:\\Program Files\\upf\\scripts\\upf.mjs', 'cursor'), 'node "C:\\Program Files\\upf\\scripts\\upf.mjs" hook cursor');
  for (const bad of ['relative/upf.mjs', '/a"b/upf.mjs', '/a$HOME/upf.mjs', '/a`x`/upf.mjs', 'C:\\50%\\upf.mjs']) {
    assert.throws(() => buildHookCommand(bad, 'codex'), /path|absolute/, bad);
  }
  assert.throws(() => buildHookCommand('/a/upf.mjs', 'notahost'), /unknown host/);
});
