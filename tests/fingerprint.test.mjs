import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { collectFingerprint } from '../scripts/lib/fingerprint.mjs';
import { callMain, tmpDir } from './helpers.mjs';

const fakeRunner = (versions) => async (file, args) => {
  const key = `${file} ${args.join(' ')}`;
  return key in versions ? { code: 0, stdout: `${versions[key]}\n`, stderr: '', error: null } : { code: null, stdout: '', stderr: '', error: 'not-found' };
};

test('records OS, node, tools and hashed lockfiles', async () => {
  const repo = tmpDir();
  fs.writeFileSync(path.join(repo, 'Cargo.lock'), 'lock');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}');
  const fp = await collectFingerprint({
    repo,
    now: '2026-09-29T00:00:00Z',
    runner: fakeRunner({ 'git --version': 'git version 2.54.0', 'rustc --version': 'rustc 1.95.0', 'cargo --version': 'cargo 1.95.0' }),
  });
  assert.equal(fp.schema, 'upf-fingerprint/1');
  assert.equal(fp.os.platform, process.platform);
  assert.equal(fp.node, process.versions.node);
  assert.deepEqual(Object.keys(fp.tools).sort(), ['cargo', 'docker', 'gh', 'git', 'rustc']);
  assert.equal(fp.tools.git, 'git version 2.54.0');
  assert.equal(fp.tools.gh, null);
  assert.deepEqual(fp.lockfiles, [
    { path: 'Cargo.lock', sha256: crypto.createHash('sha256').update('lock').digest('hex') },
    { path: 'package-lock.json', sha256: crypto.createHash('sha256').update('{}').digest('hex') },
  ]);
});

test('java reports its version on stderr and is still captured', async () => {
  const repo = tmpDir();
  fs.writeFileSync(path.join(repo, 'gradle.lockfile'), 'x');
  const runner = async (file) => (file === 'java'
    ? { code: 0, stdout: '', stderr: 'openjdk version "25" 2025-09-16\n', error: null }
    : { code: null, stdout: '', stderr: '', error: 'not-found' });
  const fp = await collectFingerprint({ repo, now: 't', runner });
  assert.equal(fp.tools.java, 'openjdk version "25" 2025-09-16');
});

test('upf fingerprint --out writes the file', async () => {
  const repo = tmpDir();
  const out = path.join(tmpDir(), 'fingerprint.json');
  const r = await callMain(['fingerprint', '--repo', repo, '--out', out], { env: { UPF_NOW: 't' } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).schema, 'upf-fingerprint/1');
});
