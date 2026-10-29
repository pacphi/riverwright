import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { RECEIPT_SCHEMA, RECEIPT_TTL_MS, buildReceipt, findValidReceipt, receiptBytes, signReceipt, verifyReceipt, verifyReceipts, markConsumed } from '../scripts/lib/receipt.mjs';
import { appendChained, eventsFile, readEvents } from '../scripts/lib/events.mjs';
import { NOW, NOW_MS, issueReceipt, makeTestVault, runDirIn } from './receipt-helpers.mjs';
import { ledgerDirFor } from '../scripts/lib/ledger.mjs';
import { tmpDir } from './helpers.mjs';

const RUN = 'ruvnet/ruflo#3509';
const A = 'a'.repeat(40);
const base = { gate: 'submit-gate', run: RUN, binding: { kind: 'sha', value: A }, branch: 'riverwright/3509-codex', ledgerHead: `sha256:${'1'.repeat(64)}`, seq: 4, at: NOW, nonce: 'n'.repeat(32) };
const keysOf = () => { const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'); return { privateKey, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }; };

test('a signed receipt verifies, and changing any signed field breaks it', () => {
  const k = keysOf();
  const r = signReceipt(buildReceipt(base), k.privateKey);
  assert.equal(r.schema, RECEIPT_SCHEMA);
  assert.equal(verifyReceipt(r, k.publicKey), true);
  const edits = { gate: 'post-comment', run: 'ruvnet/ruflo#1', binding: { kind: 'sha', value: 'b'.repeat(40) }, branch: 'riverwright/1-x', ledgerHead: `sha256:${'2'.repeat(64)}`, seq: 5, at: '2026-10-02T14:03:12.000Z', nonce: 'm'.repeat(32) };
  for (const [key, value] of Object.entries(edits)) assert.equal(verifyReceipt({ ...r, [key]: value }, k.publicKey), false, key);
  assert.equal(verifyReceipt(r, keysOf().publicKey), false);
  assert.equal(verifyReceipt({ ...r, signature: 'not base64 !!' }, k.publicKey), false);
  assert.equal(verifyReceipt(null, k.publicKey), false);
});

test('the signed bytes are a fixed-order JSON array, so no field can slide into its neighbour', () => {
  const r = buildReceipt(base);
  const [tag, body] = receiptBytes(r).toString('utf8').split('\n');
  assert.equal(tag, RECEIPT_SCHEMA);
  assert.deepEqual(JSON.parse(body), [r.gate, r.run, r.binding.kind, r.binding.value, r.branch, r.ledgerHead, r.seq, r.at, r.nonce]);
  const tricky = buildReceipt({ ...base, run: 'a","b' });
  assert.equal(JSON.parse(receiptBytes(tricky).toString('utf8').split('\n')[1])[1], 'a","b');
});

test('only the three public gates get receipts, with a full SHA or a content hash', () => {
  assert.throws(() => buildReceipt({ ...base, gate: 'checkpoint-1' }), /public gate/);
  assert.throws(() => buildReceipt({ ...base, binding: { kind: 'sha', value: 'abc' } }), /binding/);
  assert.throws(() => buildReceipt({ ...base, binding: { kind: 'content', value: 'hello' } }), /binding/);
  assert.throws(() => buildReceipt({ ...base, gate: 'post-comment', branch: 'riverwright/1-x' }), /branch/);
  assert.throws(() => buildReceipt({ ...base, gate: 'submit-gate', branch: null }), /branch/);
  assert.doesNotThrow(() => buildReceipt({ ...base, gate: 'post-comment', branch: null, binding: { kind: 'content', value: `sha256:${'c'.repeat(64)}` } }));
});

function setup() {
  const home = tmpDir();
  const runDir = runDirIn(home);
  const keys = makeTestVault(home);
  return { home, runDir, keys, ledgerDir: ledgerDirFor(runDir) };
}
const find = (s, extra = {}) => findValidReceipt({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey, gate: 'submit-gate', run: RUN, nowMs: NOW_MS + 1000, ...extra });

test('a fresh, signed, unconsumed receipt for the gate and run is found, with its binding and branch', () => {
  const s = setup();
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  const found = find(s);
  assert.equal(found.ok, true, found.reason);
  assert.equal(found.receipt.binding.value, A);
  assert.equal(found.receipt.branch, 'riverwright/3509-codex');
});

test('the receipt commits to the ledger head and seq of its own event', () => {
  const s = setup();
  appendChained(s.ledgerDir, () => ({ event: 'note', at: NOW, actor: { type: 'agent' } }));
  const written = issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.equal(written.record.data.receipt.seq, 2);
  assert.equal(written.record.data.receipt.ledgerHead, written.record.prev);
});

test('nothing is found without a receipt, for another gate or run, or from another key', () => {
  const s = setup();
  assert.match(find(s).reason, /no receipt/);
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.match(find(s, { gate: 'post-comment' }).reason, /no receipt/);
  assert.match(find(s, { run: 'ruvnet/ruflo#1' }).reason, /no receipt/);
  assert.match(find(s, { publicKey: keysOf().publicKey }).reason, /signature/);
});

test('a consumed receipt cannot be used again', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  markConsumed({ ledgerDir: s.ledgerDir, nonce: w.record.data.receipt.nonce, outcome: 'succeeded', at: NOW });
  assert.match(find(s).reason, /already used/);
});

test('an old receipt, a receipt from the future, and an unreadable clock are all refused', () => {
  const s = setup();
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.match(find(s, { nowMs: NOW_MS + RECEIPT_TTL_MS + 1 }).reason, /expired/);
  assert.match(find(s, { nowMs: NOW_MS - 120_000 }).reason, /future/);
  assert.match(find(s, { nowMs: Number.NaN }).reason, /clock/);
  assert.equal(find(s, { nowMs: NOW_MS + RECEIPT_TTL_MS }).ok, true);
});

test('the requested binding must match the receipt when one is given', () => {
  const s = setup();
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.equal(find(s, { binding: { kind: 'sha', value: A } }).ok, true);
  assert.match(find(s, { binding: { kind: 'sha', value: 'b'.repeat(40) } }).reason, /binding/);
});

test('rewriting the history before a receipt is detected, because the receipt signed the head it saw', () => {
  const s = setup();
  appendChained(s.ledgerDir, () => ({ event: 'note', at: NOW, actor: { type: 'agent' }, data: { n: 1 } }));
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  const file = eventsFile(s.ledgerDir);
  const ls = fs.readFileSync(file, 'utf8').trim().split('\n');
  const first = JSON.parse(ls[0]);
  first.data = { n: 999 };
  ls[0] = JSON.stringify(first);
  const second = JSON.parse(ls[1]);
  second.prev = `sha256:${crypto.createHash('sha256').update(ls[0]).digest('hex')}`;
  ls[1] = JSON.stringify(second);
  fs.writeFileSync(file, `${ls.join('\n')}\n`);
  assert.match(find(s).reason, /ledger head/);
  assert.ok(verifyReceipts({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey }).length > 0);
});

test('an approved event with a forged receipt is rejected', () => {
  const s = setup();
  const attacker = keysOf();
  appendChained(s.ledgerDir, ({ prev, seq }) => ({ event: 'approved', at: NOW, actor: { type: 'human' }, data: { receipt: signReceipt(buildReceipt({ ...base, ledgerHead: prev, seq, nonce: 'f'.repeat(32) }), attacker.privateKey) } }));
  assert.match(find(s).reason, /signature/);
});

test('verifyReceipts reports a repeated nonce and a receipt that names the wrong seq', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  appendChained(s.ledgerDir, () => ({ event: 'approved', at: NOW, actor: { type: 'human' }, data: { receipt: w.record.data.receipt } }));
  const problems = verifyReceipts({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey });
  assert.match(problems.map((p) => p.reason).join(' | '), /nonce.*more than once/);
  assert.match(problems.map((p) => p.reason).join(' | '), /seq/);
  assert.equal(readEvents(s.ledgerDir).length, 2);
});
