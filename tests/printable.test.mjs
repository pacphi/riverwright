import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendEvent, ledgerFile } from '../scripts/lib/ledger.mjs';
import { verifyChain } from '../scripts/lib/events.mjs';
import { printable, printableLines, jsonPrintable } from '../scripts/lib/printable.mjs';
import { callMain, tmpDir } from './helpers.mjs';

// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/;

function tamper(dir, mutate) {
  appendEvent(dir, { type: 'note', at: 't' });
  appendEvent(dir, { type: 'note', at: 't' });
  const ls = fs.readFileSync(ledgerFile(dir), 'utf8').trim().split('\n');
  ls[1] = JSON.stringify(mutate(JSON.parse(ls[1])));
  fs.writeFileSync(ledgerFile(dir), `${ls.join('\n')}\n`);
}

test('printable replaces C0, DEL, C1 and line separators; jsonPrintable keeps JSON valid', () => {
  assert.equal(printable('a\u001b[2Jb\u009bc\nd\u2028'), 'a?[2Jb?c?d?');
  const text = JSON.stringify({ v: 'x\u009by\u2028z' });
  assert.ok(RAW_CONTROL.test(text));
  const safe = jsonPrintable(text);
  assert.ok(!RAW_CONTROL.test(safe));
  assert.deepEqual(JSON.parse(safe), { v: 'x\u009by\u2028z' });
});

test('verifyChain reasons never contain a raw control character, even for a forged seq', () => {
  for (const seq of ['\u001b[2J\u001b[1;1HLedger intact', 'x\nLedger intact: 9 events', '\u009b31m']) {
    const dir = tmpDir();
    tamper(dir, (e) => ({ ...e, seq }));
    const r = verifyChain(dir);
    assert.equal(r.ok, false);
    for (const p of r.problems) assert.ok(!RAW_CONTROL.test(p.reason) && !p.reason.includes('\n'), JSON.stringify(p.reason));
  }
});

test('ledger verify output has no raw control characters for a forged seq and still fails', async () => {
  for (const seq of ['\u001b[2J\u001b[1;1HLedger intact', 'x\nLedger intact: 2 events, seq 2, head sha256:00']) {
    const dir = tmpDir();
    tamper(dir, (e) => ({ ...e, seq }));
    const r = await callMain(['ledger', 'verify', '--run', dir]);
    assert.notEqual(r.code, 0);
    assert.ok(!RAW_CONTROL.test(r.stderr + r.stdout), JSON.stringify(r.stderr));
    assert.equal(r.stderr.split('\n').filter((l) => l.startsWith('Ledger intact')).length, 0);
  }
});

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

test('printable replaces bidi, zero-width, isolate, BOM and separator characters', () => {
  const bad = ['\u202e', '\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u2066', '\u2067', '\u2068', '\u2069', '\u2060', '\ufeff', '\u2028', '\u2029', '\u0085', '\u001b'];
  for (const c of bad) assert.equal(printable(`a${c}b`), 'a?b', `U+${c.charCodeAt(0).toString(16)}`);
  assert.equal(printable('ab\u202eFAKE\u200b\u2066x'), 'ab?FAKE??x');
  assert.equal(printable('a\u{e0041}b'), 'a?b');
});

test('printable leaves accented letters, CJK and emoji alone', () => {
  const ok = 'caf\u00e9 na\u00efve \u65e5\u672c\u8a9e \u0627\u0644\u0639\u0631\u0628\u064a\u0629 \u{1f600}';
  assert.equal(printable(ok), ok);
});

test('printableLines keeps newline and tab but replaces every other unsafe character', () => {
  assert.equal(printableLines('a\nb\tc\u202ed\u200be\u001bf\rg\u2028h'), 'a\nb\tc?d?e?f?g?h');
  assert.ok(!UNSAFE.test(printableLines('x\u2066y\u{e0001}\ufeff').replace(/[\n\t]/g, '')));
});

test('jsonPrintable escapes format characters and the JSON stays valid and equal', () => {
  const value = { v: 'ab\u202eFAKE\u200b\u2066x\ufeff\u2028\u009b\u{e0041}', ok: 'caf\u00e9 \u65e5\u672c \u{1f600}' };
  const safe = jsonPrintable(JSON.stringify(value, null, 2));
  assert.ok(!UNSAFE.test(safe.replace(/\n/g, '')));
  assert.deepEqual(JSON.parse(safe), value);
  assert.match(safe, /\\u202e/);
});
