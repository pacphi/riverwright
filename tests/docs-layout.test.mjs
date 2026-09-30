import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

// The documentation taxonomy (ADR-0001). These checks keep every kind of document in its place.

const DOCS = path.join(ROOT, 'docs');
const TOP_LEVEL = ['README.md', 'ROADMAP.md', 'adr', 'ddd', 'specs', 'plans', 'research', 'guides', 'reference', 'story', 'archive'];
const ADR_STATUS = /^(Proposed|Accepted|Deprecated|Superseded by ADR-\d{4})$/;

const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'missing frontmatter');
  return Object.fromEntries(m[1].split('\n').filter((l) => /^[a-z]+:/.test(l)).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i), l.slice(i + 1).trim()];
  }));
}

test('docs/ has only the documented top-level entries', () => {
  const extra = list(DOCS).filter((e) => !TOP_LEVEL.includes(e));
  assert.deepEqual(extra, [], `unexpected entries in docs/: ${extra.join(', ')}`);
});

test('nothing lives under a tool-owned docs folder such as docs/superpowers', () => {
  assert.equal(fs.existsSync(path.join(DOCS, 'superpowers')), false);
});

test('specs are living documents with plain names', () => {
  for (const f of list(path.join(DOCS, 'specs'))) assert.match(f, /^[a-z0-9-]+\.md$/, `spec "${f}" should be lowercase-kebab.md with no date`);
});

test('plans are dated snapshots, plus one README index', () => {
  for (const f of list(path.join(DOCS, 'plans'))) {
    assert.ok(f === 'README.md' || /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/.test(f), `plan "${f}" should be YYYY-MM-DD-name.md`);
  }
});

test('ADRs are numbered, have the required frontmatter, and are all indexed', () => {
  const dir = path.join(DOCS, 'adr');
  const files = list(dir).filter((f) => f !== 'README.md');
  assert.ok(files.length >= 8, `ADR count: ${files.length}`);
  const index = read('docs', 'adr', 'README.md');
  const seen = new Set();
  for (const f of files) {
    if (f === '0000-template.md') continue;
    assert.match(f, /^\d{4}-[a-z0-9-]+\.md$/, `ADR "${f}" should be NNNN-kebab-title.md`);
    const fm = frontmatter(read('docs', 'adr', f));
    assert.equal(fm.id, `ADR-${f.slice(0, 4)}`, `${f}: id must match the file number`);
    assert.ok(fm.title, `${f}: title`);
    assert.match(fm.status, ADR_STATUS, `${f}: status "${fm.status}"`);
    assert.match(fm.date, /^\d{4}-\d{2}-\d{2}$/, `${f}: date`);
    assert.ok(!seen.has(fm.id), `${f}: duplicate id`);
    seen.add(fm.id);
    assert.ok(index.includes(`(${f})`), `${f} is not listed in docs/adr/README.md`);
  }
});

test('the domain model has a language, a context map and an index', () => {
  for (const f of ['README.md', 'ubiquitous-language.md', 'context-map.md']) {
    assert.ok(fs.existsSync(path.join(DOCS, 'ddd', f)), `docs/ddd/${f} is missing`);
  }
});

test('docs/README.md maps every top-level folder that exists', () => {
  const map = read('docs', 'README.md');
  for (const e of list(DOCS)) {
    if (fs.statSync(path.join(DOCS, e)).isDirectory()) assert.ok(map.includes(`(${e}/`) || map.includes(`(${e})`), `docs/README.md does not link ${e}/`);
  }
});

test('AGENTS.md declares the layout and overrides the superpowers default; CLAUDE.md and GEMINI.md defer to it', () => {
  const agents = read('AGENTS.md');
  assert.match(agents, /## Documentation layout/);
  assert.match(agents, /docs\/specs\//);
  assert.match(agents, /docs\/plans\//);
  assert.match(agents, /superpowers/i);
  assert.match(agents, /never .*docs\/superpowers/is);
  assert.match(read('CLAUDE.md'), /@AGENTS\.md/);
  assert.match(read('GEMINI.md'), /@\.?\/?AGENTS\.md/);
});

test('relative links in the indexed documents resolve', () => {
  const files = ['docs/README.md', 'docs/plans/README.md', 'AGENTS.md']
    .concat(list(path.join(DOCS, 'adr')).map((f) => `docs/adr/${f}`))
    .concat(list(path.join(DOCS, 'ddd')).map((f) => `docs/ddd/${f}`))
    .concat(list(path.join(DOCS, 'specs')).map((f) => `docs/specs/${f}`));
  const broken = [];
  for (const rel of files) {
    const file = path.join(ROOT, rel);
    const body = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const m of body.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^[a-z]+:/.test(target)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), target))) broken.push(`${rel} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});
