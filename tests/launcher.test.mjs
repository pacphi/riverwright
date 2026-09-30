import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, tmpDir } from './helpers.mjs';

const posix = process.platform !== 'win32';
const launcher = path.join(ROOT, 'bin', 'riverwright');
const cmdLauncher = path.join(ROOT, 'bin', 'riverwright.cmd');

test('POSIX launcher runs riverwright through node', { skip: !posix }, () => {
  const r = spawnSync('/bin/sh', [launcher, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

test('POSIX launcher works through a symlink (setup may link it into ~/.local/bin)', { skip: !posix }, () => {
  const dir = tmpDir();
  const link = path.join(dir, 'riverwright');
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

test('Windows launcher runs riverwright through node', { skip: posix }, () => {
  const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cmdLauncher}" --version"`], { encoding: 'utf8', windowsVerbatimArguments: true });
  assert.equal(r.status, 0, r.stderr);
});

test('Windows launcher denies hook calls when node is missing', { skip: posix }, () => {
  const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cmdLauncher}" hook claude-code"`], {
    encoding: 'utf8', windowsVerbatimArguments: true, env: { PATH: 'C:\\nonexistent', SystemRoot: process.env.SystemRoot },
  });
  assert.equal(r.status, 2);
});

const alias = path.join(ROOT, 'bin', 'rw');
const cmdAlias = path.join(ROOT, 'bin', 'rw.cmd');

test('POSIX rw alias runs riverwright through node', { skip: !posix }, () => {
  const r = spawnSync('/bin/sh', [alias, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

test('POSIX rw alias works through a symlink', { skip: !posix }, () => {
  const dir = tmpDir();
  const link = path.join(dir, 'rw');
  fs.symlinkSync(alias, link);
  const r = spawnSync('/bin/sh', [link, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('POSIX rw alias denies hook and guard calls when node is missing', { skip: !posix }, () => {
  for (const args of [['hook', 'claude-code'], ['guard', 'pre-push']]) {
    const r = spawnSync('/bin/sh', [alias, ...args], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /needs Node\.js 24/);
  }
});

test('POSIX rw alias exits 1 for ordinary commands when node is missing', { skip: !posix }, () => {
  const r = spawnSync('/bin/sh', [alias, 'doctor'], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
  assert.equal(r.status, 1);
});

test('Windows rw alias runs riverwright through node', { skip: posix }, () => {
  const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cmdAlias}" --version"`], { encoding: 'utf8', windowsVerbatimArguments: true });
  assert.equal(r.status, 0, r.stderr);
});

test('Windows rw alias denies hook calls when node is missing', { skip: posix }, () => {
  const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cmdAlias}" hook claude-code"`], {
    encoding: 'utf8', windowsVerbatimArguments: true, env: { PATH: 'C:\\nonexistent', SystemRoot: process.env.SystemRoot },
  });
  assert.equal(r.status, 2);
});
