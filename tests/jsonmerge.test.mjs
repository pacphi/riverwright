import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonStrict, addAbsentKeys, removeAddedKeys, formatJsonLike } from '../scripts/lib/jsonmerge.mjs';

const TEAM = {
  extraKnownMarketplaces: { 'upstream-pr-filer': { source: { source: 'github', repo: 'agentic-incubator/upstream-pr-filer' } } },
  enabledPlugins: { 'upstream-pr-filer@upstream-pr-filer': true },
};

test('comments make a file unparseable, so it is never edited', () => {
  assert.throws(() => parseJsonStrict('{\n  // note\n  "a": 1\n}'), /not strict JSON/);
  assert.deepEqual(parseJsonStrict('﻿{"a":1}'), { a: 1 });
});

test('only absent keys are added; existing values are never changed', () => {
  const target = { enabledPlugins: { 'other@x': true, 'upstream-pr-filer@upstream-pr-filer': false }, model: 'x' };
  const { result, added } = addAbsentKeys(target, TEAM);
  assert.equal(result.enabledPlugins['upstream-pr-filer@upstream-pr-filer'], false);
  assert.equal(result.enabledPlugins['other@x'], true);
  assert.deepEqual(result.extraKnownMarketplaces, TEAM.extraKnownMarketplaces);
  assert.deepEqual(added, [['extraKnownMarketplaces']]);
  assert.deepEqual(target.extraKnownMarketplaces, undefined);
});

test('removing added keys restores the original object', () => {
  const original = { enabledPlugins: { 'other@x': true } };
  const { result, added } = addAbsentKeys(original, TEAM);
  assert.deepEqual(removeAddedKeys(result, added, TEAM).result, original);
});

test('a value the user changed after we added it is left alone', () => {
  const { result, added } = addAbsentKeys({}, TEAM);
  result.enabledPlugins['upstream-pr-filer@upstream-pr-filer'] = false;
  result.enabledPlugins['mine@y'] = true;
  const back = removeAddedKeys(result, added, TEAM).result;
  assert.deepEqual(back.enabledPlugins, { 'upstream-pr-filer@upstream-pr-filer': false, 'mine@y': true });
  assert.equal(back.extraKnownMarketplaces, undefined);
});

test('formatJsonLike keeps indent, CRLF, BOM and a missing final newline', () => {
  const original = '﻿{\r\n    "a": 1\r\n}';
  const out = formatJsonLike(original, { a: 1, b: 2 });
  assert.equal(out, '﻿{\r\n    "a": 1,\r\n    "b": 2\r\n}');
});
