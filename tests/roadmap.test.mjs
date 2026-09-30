import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

// docs/ROADMAP.md is the living product requirements and roadmap. These checks keep it honest:
// only known status words, links that resolve, and evidence for anything called built or proven.

const FILE = path.join(ROOT, 'docs', 'ROADMAP.md');
const text = fs.readFileSync(FILE, 'utf8');

const STATUSES = ['proposed', 'designed', 'planned', 'in-progress', 'implemented', 'verified', 'released', 'deferred', 'dropped'];
const RANK = Object.fromEntries(STATUSES.map((s, i) => [s, i]));

function rows(idPattern) {
  return text.split('\n')
    .filter((l) => new RegExp(`^\\| ${idPattern} \\|`).test(l))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim().replace(/^`([^`]*)`$/, '$1')));
}

const milestones = rows('M\\d+');
const features = rows('[A-Z]{1,2}-\\d{2}');
const useCases = rows('UC-\\d+');

const links = (cell) => [...cell.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);

test('the roadmap has milestones, use cases and features', () => {
  assert.ok(milestones.length >= 6, `milestones: ${milestones.length}`);
  assert.ok(useCases.length >= 6, `use cases: ${useCases.length}`);
  assert.ok(features.length >= 30, `features: ${features.length}`);
});

test('ids are unique', () => {
  const ids = [...milestones, ...features, ...useCases].map((r) => r[0]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test('every status is one of the documented keywords', () => {
  for (const r of [...milestones, ...features]) {
    assert.ok(STATUSES.includes(r[2]), `${r[0]} has unknown status "${r[2]}"`);
  }
  for (const r of useCases) assert.ok(STATUSES.includes(r[4]), `${r[0]} has unknown status "${r[4]}"`);
  for (const s of STATUSES) assert.ok(text.includes(`\`${s}\``), `status "${s}" is not explained in the document`);
});

test('every feature belongs to a known milestone', () => {
  const known = new Set(milestones.map((r) => r[0]));
  for (const r of features) assert.ok(known.has(r[3]), `${r[0]} names unknown milestone "${r[3]}"`);
});

test('every use case points at features that exist', () => {
  const known = new Set(features.map((r) => r[0]));
  for (const r of useCases) {
    const ids = r[3].split(/[ ,]+/).filter(Boolean);
    assert.ok(ids.length > 0, `${r[0]} lists no features`);
    for (const id of ids) assert.ok(known.has(id), `${r[0]} names unknown feature "${id}"`);
  }
});

test('every relative link resolves to a file in the repository', () => {
  const broken = [];
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1].split('#')[0];
    if (!target || /^https?:/.test(target)) continue;
    if (!fs.existsSync(path.resolve(path.dirname(FILE), target))) broken.push(target);
  }
  assert.deepEqual(broken, []);
});

test('implemented or later needs a link to code, tests or CI', () => {
  const code = /(^|\/)(scripts|tests|bin|templates|\.github)\//;
  for (const r of features) {
    if (RANK[r[2]] >= RANK.implemented && RANK[r[2]] <= RANK.released) {
      assert.ok(links(r[4]).some((l) => code.test(l.replace(/^(\.\.\/)+/, ''))), `${r[0]} is ${r[2]} but links no code, test or workflow`);
    }
  }
});

test('verified or released needs external evidence (a CI run, pull request or release URL)', () => {
  for (const r of features) {
    if (r[2] === 'verified' || r[2] === 'released') {
      assert.ok(links(r[4]).some((l) => /^https:\/\//.test(l)), `${r[0]} is ${r[2]} but links no https evidence`);
    }
  }
});

test('the document states when it was last updated', () => {
  assert.match(text, /\*\*Last updated:\*\* \d{4}-\d{2}-\d{2}/);
});
