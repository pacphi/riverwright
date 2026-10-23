import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

// The project uses pnpm for development tools (ADR-0009). The runtime installs nothing.

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const exists = (f) => fs.existsSync(path.join(ROOT, f));

test('package.json pins an exact pnpm version', () => {
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
});

test('the lockfile is pnpm-lock.yaml and no other package manager has one', () => {
  assert.ok(exists('pnpm-lock.yaml'), 'pnpm-lock.yaml is missing');
  for (const f of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb', 'bun.lock']) {
    assert.equal(exists(f), false, `${f} should not exist`);
  }
});

test('CI installs with pnpm and a frozen lockfile, and never with npm', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /pnpm\/action-setup@/);
  assert.match(ci, /pnpm install --frozen-lockfile/);
  assert.doesNotMatch(ci, /\bnpm (ci|install)\b/);
});

test('the documented commands use pnpm', () => {
  for (const f of ['AGENTS.md', '.github/pull_request_template.md', 'docs/ROADMAP.md']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(text, /npm run /, `${f} still says "npm run"`);
  }
});

test('engines require Node 24 or newer', () => {
  assert.equal(pkg.engines.node, '>=24');
});
