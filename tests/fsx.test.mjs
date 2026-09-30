import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detectEol, toLf, fromLf, readTextIfExists, writeFileAtomic } from '../scripts/lib/fsx.mjs';
import { tmpDir } from './helpers.mjs';

test('EOL helpers round-trip CRLF', () => {
  const crlf = 'a\r\nb\r\n';
  assert.equal(detectEol(crlf), '\r\n');
  assert.equal(detectEol('a\nb'), '\n');
  assert.equal(fromLf(toLf(crlf), detectEol(crlf)), crlf);
});

test('readTextIfExists returns null for a missing file', () => {
  assert.equal(readTextIfExists(path.join(tmpDir(), 'nope.txt')), null);
});

test('writeFileAtomic writes and leaves no temp files', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'sub', 'a.txt');
  writeFileAtomic(f, 'hello\r\n');
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello\r\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sub')), ['a.txt']);
});

test('writeFileAtomic keeps the existing file mode', { skip: process.platform === 'win32' }, () => {
  const f = path.join(tmpDir(), 'x.sh');
  fs.writeFileSync(f, 'old');
  fs.chmodSync(f, 0o750);
  writeFileAtomic(f, 'new');
  assert.equal(fs.statSync(f).mode & 0o777, 0o750);
});

test('writeFileAtomic writes through a symlink and keeps the link', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir();
  const target = path.join(dir, 'AGENTS.md');
  const link = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(target, 'one\n');
  fs.symlinkSync('AGENTS.md', link);
  writeFileAtomic(link, 'two\n');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'two\n');
});
