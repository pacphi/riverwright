import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff } from '../scripts/lib/diff.mjs';

test('identical texts produce no diff', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n', { fromFile: 'a/x', toFile: 'b/x' }), '');
});

test('a changed line shows as - and + with a hunk header', () => {
  const d = unifiedDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\n', { fromFile: 'a/x', toFile: 'b/x' });
  assert.match(d, /^--- a\/x\n\+\+\+ b\/x\n@@ -1,3 \+1,3 @@\n/);
  assert.match(d, /\n-two\n\+TWO\n/);
});

test('a new file shows every line as added', () => {
  const d = unifiedDiff('', 'x\ny\n', { fromFile: '/dev/null', toFile: 'b/new' });
  assert.match(d, /\+x\n\+y\n/);
});
