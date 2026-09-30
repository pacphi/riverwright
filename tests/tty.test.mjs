import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openTerminal, confirmTyped } from '../scripts/lib/tty.mjs';
import { fakeTerminal, tmpDir } from './helpers.mjs';

test('confirmTyped accepts only the expected answer', async () => {
  assert.equal(await confirmTyped({ terminal: fakeTerminal('abc1234'), question: 'Type it: ', expected: 'abc1234' }), true);
  assert.equal(await confirmTyped({ terminal: fakeTerminal('yes'), question: 'Type it: ', expected: 'abc1234' }), false);
});

test('openTerminal reports a missing terminal clearly', () => {
  const missing = path.join(tmpDir(), 'no-tty');
  assert.throws(() => openTerminal({ paths: [missing, missing] }), /needs a real terminal/);
});
