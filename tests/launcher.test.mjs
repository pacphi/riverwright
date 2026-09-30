import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, tmpDir } from './helpers.mjs';

const posix = process.platform !== 'win32';
const launcher = path.join(ROOT, 'bin', 'upf');
const cmdLauncher = path.join(ROOT, 'bin', 'upf.cmd');

test('POSIX launcher runs upf through node', { skip: !posix }, () => {
  const r = spawnSync('/bin/sh', [launcher, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

test('POSIX launcher works through a symlink (setup may link it into ~/.local/bin)', { skip: !posix }, () => {
  const dir = tmpDir();
  const link = path.join(dir, 'upf');
  fs.symlinkSync(launcher, link);
  const r = spawnSync('/bin/sh', [link, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('POSIX launcher denies hook calls when node is missing', { skip: !posix }, () => {
  const r = spawnSync('/bin/sh', [launcher, 'hook', 'claude-code'], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs Node\.js 24/);
});

test('POSIX launcher exits 1 for ordinary commands when node is missing', { skip: !posix }, () => {
  const r = spawnSync('/bin/sh', [launcher, 'doctor'], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
  assert.equal(r.status, 1);
});

test('Windows launcher runs upf through node', { skip: posix }, () => {
  const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cmdLauncher}" --version"`], { encoding: 'utf8', windowsVerbatimArguments: true });
  assert.equal(r.status, 0, r.stderr);
});

test('Windows launcher denies hook calls when node is missing', { skip: posix }, () => {
  const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cmdLauncher}" hook claude-code"`], {
    encoding: 'utf8', windowsVerbatimArguments: true, env: { PATH: 'C:\\nonexistent', SystemRoot: process.env.SystemRoot },
  });
  assert.equal(r.status, 2);
});
