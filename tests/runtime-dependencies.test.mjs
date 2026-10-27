import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

// ADR-0003: the runtime has no npm dependencies. Development tools may be devDependencies.

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.mjs') ? [p] : [];
  });
}

test('package.json declares no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
});

test('everything under scripts/ imports only node: modules or relative files', () => {
  const bad = [];
  for (const file of walk(path.join(ROOT, 'scripts'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!(spec.startsWith('node:') || spec.startsWith('.'))) bad.push(`${path.relative(ROOT, file)} imports "${spec}"`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the bin launchers do not depend on installed packages', () => {
  for (const f of ['riverwright', 'rw']) {
    const text = fs.readFileSync(path.join(ROOT, 'bin', f), 'utf8');
    assert.doesNotMatch(text, /node_modules|npx |npm /);
  }
});
