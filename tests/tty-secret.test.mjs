import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readSecret } from '../scripts/lib/tty.mjs';
import { fakeSecretTerminal } from './helpers.mjs';

test('readSecret returns what was typed, prints the prompt, and never echoes the secret', async () => {
  const t = fakeSecretTerminal(['hunter2 is not a passphrase']);
  const value = await readSecret({ terminal: t, question: 'Passphrase: ' });
  assert.equal(value, 'hunter2 is not a passphrase');
  const shown = t.written.join('');
  assert.match(shown, /Passphrase: /);
  assert.equal(shown.includes('hunter2'), false);
});

test('backspace edits, carriage return ends the line, and arrow-key escape sequences are ignored', async () => {
  const t = fakeSecretTerminal([]);
  t.input.end('abcx\u007f\u001b[Ad\u001b[B\u001b[1;5Cef\r');
  assert.equal(await readSecret({ terminal: t, question: '> ' }), 'abcdef');
});

test('Ctrl-C and an early end of input abort without returning anything', async () => {
  const t = fakeSecretTerminal([]);
  t.input.end('abc\u0003');
  await assert.rejects(readSecret({ terminal: t, question: '> ' }), (e) => e.code === 'ABORTED');
  const u = fakeSecretTerminal([]);
  u.input.end('partial');
  await assert.rejects(readSecret({ terminal: u, question: '> ' }), (e) => e.code === 'ABORTED');
});

test('two secrets can be read in turn from one terminal, even when they arrive in a single chunk', async () => {
  const t = fakeSecretTerminal(['first passphrase', 'second passphrase']);
  assert.equal(await readSecret({ terminal: t, question: 'a: ' }), 'first passphrase');
  assert.equal(await readSecret({ terminal: t, question: 'b: ' }), 'second passphrase');
  await assert.rejects(readSecret({ terminal: t, question: 'c: ' }), (e) => e.code === 'ABORTED');
});

test('a terminal that cannot hide what is typed is refused', async () => {
  const t = { input: new PassThrough(), output: new PassThrough() };
  t.input.end('secret\n');
  await assert.rejects(readSecret({ terminal: t, question: '> ' }), (e) => e.code === 'NO_ECHO_CONTROL' && /hide/.test(e.message));
});

test('a real terminal is put in raw mode for the read and restored afterwards', async () => {
  const input = new PassThrough();
  const modes = [];
  input.setRawMode = (on) => modes.push(on);
  const t = { input, output: new PassThrough() };
  const pending = readSecret({ terminal: t, question: '> ' });
  input.write('pass');
  input.write('word\r');
  assert.equal(await pending, 'password');
  assert.deepEqual(modes, [true, false]);
});

test('the passphrase is normalized by the caller, not here: multi-byte characters survive', async () => {
  const t = fakeSecretTerminal(['pässwörd ✓ 密码']);
  assert.equal(await readSecret({ terminal: t, question: '> ' }), 'pässwörd ✓ 密码');
});
