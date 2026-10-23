import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { STATIONS } from '../scripts/lib/state.mjs';
import { HOSTS } from '../scripts/lib/hosts.mjs';
import { parseIssueRef } from '../scripts/lib/paths.mjs';
import { ROOT } from './helpers.mjs';

const story = fs.readFileSync(path.join(ROOT, 'docs', 'story', 'paddling-upstream.html'), 'utf8');
const values = (attr) => [...new Set([...story.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((m) => m[1]))].sort();

test('the story badges use exactly the station names', () => {
  assert.deepEqual(values('data-station'), [...STATIONS].sort());
});

test('the story meters use exactly the host ids', () => {
  assert.deepEqual(values('data-host'), [...HOSTS].sort());
});

test('the story run cards name runs as owner/repo#n', () => {
  for (const id of values('data-run')) assert.doesNotThrow(() => parseIssueRef(id), id);
});

test('the story reads the fields the export writes', () => {
  assert.match(story, /h\.level >= 1 && h\.level <= 3/);
  assert.match(story, /run\.kind === 'real'/);
  assert.match(story, /st\[name\]\.status !== 'passed'/);
  assert.match(story, /fetch\('evidence\.json'/);
});

test('the published evidence seed is valid input for the story', () => {
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'story', 'evidence.json'), 'utf8'));
  assert.ok(Array.isArray(seed.runs));
  for (const [id, h] of Object.entries(seed.hosts)) {
    assert.ok(HOSTS.includes(id), id);
    assert.ok([1, 2, 3].includes(h.level), id);
  }
});
