import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readVersion, version } from '../scripts/lib/version.mjs';
import { ROOT, tmpDir } from './helpers.mjs';

// The generated plugin/ folder never carries package.json (ADR-0011), so the runtime must find its version
// in plugin/.claude-plugin/plugin.json, which the generator writes from package.json.
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

test('in a checkout the version is package.json\'s', () => {
  assert.equal(readVersion(ROOT), pkgVersion);
  assert.equal(version(), pkgVersion);
});

test('without package.json the version comes from .claude-plugin/plugin.json', () => {
  const dir = tmpDir('rw-version-');
  writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), { name: 'riverwright', version: '1.2.3' });
  assert.equal(readVersion(dir), '1.2.3');
});

test('package.json wins when both are present', () => {
  const dir = tmpDir('rw-version-');
  writeJson(path.join(dir, 'package.json'), { version: '2.0.0' });
  writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), { version: '1.2.3' });
  assert.equal(readVersion(dir), '2.0.0');
});

test('no version anywhere is an error, not undefined', () => {
  assert.throws(() => readVersion(tmpDir('rw-version-')), /NO_VERSION|no version/);
});

test('scripts/ copied without package.json still answers `version`', () => {
  const dir = tmpDir('rw-version-');
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), { name: 'riverwright', version: '3.4.5' });
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'riverwright.mjs'), 'version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '3.4.5');
});
