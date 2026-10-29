import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { readSecret } from '../scripts/lib/tty.mjs';
import { RiverwrightError } from '../scripts/lib/errors.mjs';
import { fakeSecretTerminal } from './helpers.mjs';

function rawTerminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  const modes = [];
  input.setRawMode = (on) => modes.push(on);
  return { input, output, modes };
}

test('I1: a multi-byte character split across two chunks survives', async () => {
  const t = rawTerminal();
  const pending = readSecret({ terminal: t, question: '> ' });
  const bytes = Buffer.from('pä\r', 'utf8');
  t.input.write(bytes.subarray(0, 2));
  await new Promise((r) => setImmediate(r));
  t.input.write(bytes.subarray(2));
  assert.equal(await pending, 'pä');
});

test('I2: an input error rejects with a Riverwright error, restores raw mode, removes listeners', async () => {
  const t = rawTerminal();
  const pending = readSecret({ terminal: t, question: '> ' });
  t.input.write('secretpart');
  await new Promise((r) => setImmediate(r));
  t.input.emit('error', new Error('boom'));
  await assert.rejects(pending, (e) => e instanceof RiverwrightError && !/secretpart/.test(e.message));
  assert.deepEqual(t.modes, [true, false]);
  assert.equal(t.input.listenerCount('data'), 0);
  assert.equal(t.input.listenerCount('error'), 1); // only the permanent no-op (N1)
  assert.equal(t.input.listenerCount('close'), 0);
});

test('I2: close without end does not leave the promise pending, and raw mode is restored', async () => {
  const t = rawTerminal();
  const pending = readSecret({ terminal: t, question: '> ' });
  t.input.destroy();
  await assert.rejects(pending, (e) => e.code === 'ABORTED');
  assert.deepEqual(t.modes, [true, false]);
});

test('I2: an output error rejects and restores raw mode', async () => {
  const t = rawTerminal();
  const pending = readSecret({ terminal: t, question: '> ' });
  t.output.emit('error', new Error('EIO'));
  await assert.rejects(pending, (e) => e instanceof RiverwrightError);
  assert.deepEqual(t.modes, [true, false]);
  assert.equal(t.output.listenerCount('error'), 1); // only the permanent no-op (N1)
});

test('I2: Ctrl-C and end restore raw mode', async () => {
  const a = rawTerminal();
  const pa = readSecret({ terminal: a, question: '> ' });
  a.input.write('abc\u0003');
  await assert.rejects(pa, (e) => e.code === 'ABORTED');
  assert.deepEqual(a.modes, [true, false]);
  const b = rawTerminal();
  const pb = readSecret({ terminal: b, question: '> ' });
  b.input.end('x');
  await assert.rejects(pb, (e) => e.code === 'ABORTED');
  assert.deepEqual(b.modes, [true, false]);
});

test('M2: a CRLF paste is one terminator and does not empty the next read', async () => {
  const t = rawTerminal();
  const first = readSecret({ terminal: t, question: 'a: ' });
  t.input.write('abc\r\n');
  assert.equal(await first, 'abc');
  const second = readSecret({ terminal: t, question: 'b: ' });
  t.input.write('def\r\n');
  assert.equal(await second, 'def');
});

test('M2: CRLF split across chunks, and in one chunk with a second secret', async () => {
  const t = rawTerminal();
  const first = readSecret({ terminal: t, question: 'a: ' });
  t.input.write('abc\r');
  assert.equal(await first, 'abc');
  const second = readSecret({ terminal: t, question: 'b: ' });
  t.input.write('\ndef\r\n');
  assert.equal(await second, 'def');
  const u = fakeSecretTerminal([]);
  u.input.end('one\r\ntwo\r\n');
  assert.equal(await readSecret({ terminal: u, question: '1' }), 'one');
  assert.equal(await readSecret({ terminal: u, question: '2' }), 'two');
});

test('M3: lone ESC and SS3 / CSI sequences are dropped without leaking letters', async () => {
  const t = fakeSecretTerminal([]);
  t.input.end('ab\u001bOHcd\u001b[1;5Fef\u001b[3~g\u001b\r');
  assert.equal(await readSecret({ terminal: t, question: '> ' }), 'abcdefg');
  const u = fakeSecretTerminal([]);
  u.input.end('ab\u001bcd\r');
  assert.equal(await readSecret({ terminal: u, question: '> ' }), 'abcd');
});

test('M4: Ctrl-D aborts, even after text was typed', async () => {
  const t = rawTerminal();
  const pending = readSecret({ terminal: t, question: '> ' });
  t.input.write('abc\u0004');
  await assert.rejects(pending, (e) => e.code === 'ABORTED');
  assert.deepEqual(t.modes, [true, false]);
});

test('M1: noEcho is not honoured on a terminal backed by a real file stream', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rw-tty-')), 'in');
  fs.writeFileSync(file, 'secret\n');
  const input = fs.createReadStream(file);
  const t = { input, output: new PassThrough(), noEcho: true };
  await assert.rejects(readSecret({ terminal: t, question: '> ' }), (e) => e.code === 'NO_ECHO_CONTROL');
  input.destroy();
});

test('N1: a failing write of the trailing newline after finish does not crash the process', async () => {
  const t = rawTerminal();
  const pending = readSecret({ terminal: t, question: '> ' });
  t.input.write('abc\r');
  assert.equal(await pending, 'abc');
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    t.output.emit('error', new Error('EPIPE'));
    t.input.emit('error', new Error('late'));
    await new Promise((r) => setImmediate(r));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  assert.deepEqual(uncaught, []);
});

test('N1: the trailing newline is written while the error listener is still attached', async () => {
  const t = rawTerminal();
  let listenersAtNewline = -1;
  const realWrite = t.output.write.bind(t.output);
  t.output.write = (chunk, ...rest) => {
    if (chunk === '\n') listenersAtNewline = t.output.listenerCount('error');
    return realWrite(chunk, ...rest);
  };
  const pending = readSecret({ terminal: t, question: '> ' });
  t.input.write('x\r');
  await pending;
  assert.ok(listenersAtNewline >= 1);
});

test('N2: Enter inside an unfinished CSI sequence still submits', async () => {
  const t = rawTerminal();
  const pending = readSecret({ terminal: t, question: '> ' });
  t.input.write('ab\u001b[\r');
  assert.equal(await pending, 'ab');
});

test('N2: Enter inside an unfinished SS3 sequence still submits', async () => {
  const t = rawTerminal();
  const pending = readSecret({ terminal: t, question: '> ' });
  t.input.write('ab\u001bO\n');
  assert.equal(await pending, 'ab');
});

test('N2: Ctrl-C and Ctrl-D inside a sequence abort', async () => {
  for (const [prefix, key] of [['\u001b[', '\u0003'], ['\u001bO', '\u0004'], ['\u001b[1;', '\u0003']]) {
    const t = rawTerminal();
    const pending = readSecret({ terminal: t, question: '> ' });
    t.input.write(`ab${prefix}${key}`);
    await assert.rejects(pending, (e) => e.code === 'ABORTED');
    assert.deepEqual(t.modes, [true, false]);
  }
});

test('N2: a new ESC inside a sequence starts a fresh sequence', async () => {
  const t = fakeSecretTerminal([]);
  t.input.end('ab\u001b[\u001b[Acd\r');
  assert.equal(await readSecret({ terminal: t, question: '> ' }), 'abcd');
});
