import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { appendReceipt } from '../scripts/lib/receipt.mjs';
import { RECEIPT_SCHEMA, RECEIPT_TTL_MS, buildReceipt, consumeReceipt, findValidReceipt, receiptBytes, signReceipt, verifyReceipt, verifyReceipts, verifyConsumptions, markConsumed } from '../scripts/lib/receipt.mjs';
import { GENESIS, appendChained, eventsFile, lineHash, readEvents, verifyChain } from '../scripts/lib/events.mjs';
import { FORK_KEY, NOW, NOW_MS, issueReceipt, makeTestVault, runDirIn } from './receipt-helpers.mjs';
import { ledgerDirFor } from '../scripts/lib/ledger.mjs';
import { tmpDir } from './helpers.mjs';

const RUN = 'ruvnet/ruflo#3509';
const A = 'a'.repeat(40);
const base = { gate: 'submit-gate', run: RUN, binding: { kind: 'sha', value: A }, branch: 'riverwright/3509-codex', fork: FORK_KEY, ledgerHead: `sha256:${'1'.repeat(64)}`, seq: 4, at: NOW, nonce: '0123456789abcdef0123456789abcdef' };
const keysOf = () => { const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'); return { privateKey, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }; };

test('a signed receipt verifies, and changing any signed field breaks it', () => {
  const k = keysOf();
  const r = signReceipt(buildReceipt(base), k.privateKey);
  assert.equal(r.schema, RECEIPT_SCHEMA);
  assert.equal(verifyReceipt(r, k.publicKey), true);
  const edits = { gate: 'post-comment', run: 'ruvnet/ruflo#1', binding: { kind: 'sha', value: 'b'.repeat(40) }, branch: 'riverwright/1-x', fork: 'github.com/someone/ruflo', lease: 'c'.repeat(40), ledgerHead: `sha256:${'2'.repeat(64)}`, seq: 5, at: '2026-10-02T14:03:12.000Z', nonce: 'fedcba9876543210fedcba9876543210' };
  for (const [key, value] of Object.entries(edits)) assert.equal(verifyReceipt({ ...r, [key]: value }, k.publicKey), false, key);
  assert.equal(verifyReceipt(r, keysOf().publicKey), false);
  assert.equal(verifyReceipt({ ...r, signature: 'not base64 !!' }, k.publicKey), false);
  assert.equal(verifyReceipt(null, k.publicKey), false);
});

test('the signed bytes are a fixed-order JSON array, so no field can slide into its neighbour', () => {
  const r = buildReceipt(base);
  const [tag, body] = receiptBytes(r).toString('utf8').split('\n');
  assert.equal(tag, RECEIPT_SCHEMA);
  assert.deepEqual(JSON.parse(body), [r.gate, r.run, r.binding.kind, r.binding.value, r.branch, r.fork, r.lease, r.ledgerHead, r.seq, r.at, r.nonce]);
  const tricky = buildReceipt({ ...base, run: 'a","b' });
  assert.equal(JSON.parse(receiptBytes(tricky).toString('utf8').split('\n')[1])[1], 'a","b');
});

// Finding M-2: JSON.stringify writes an undefined array element as null, so the signed bytes alone cannot tell a
// missing field from null. receiptBytes refuses a missing field instead of signing or checking such bytes.
test('the signed bytes refuse a receipt with a field missing rather than read it as null', () => {
  const r = buildReceipt(base);
  for (const key of ['fork', 'lease', 'branch', 'run', 'nonce']) {
    const { [key]: _gone, ...rest } = r;
    assert.throws(() => receiptBytes(rest), /BAD_RECEIPT|missing/, key);
  }
  assert.doesNotThrow(() => receiptBytes(r));
});

test('only the three public gates get receipts, with a full SHA or a content hash', () => {
  assert.throws(() => buildReceipt({ ...base, gate: 'checkpoint-1' }), /public gate/);
  assert.throws(() => buildReceipt({ ...base, binding: { kind: 'sha', value: 'abc' } }), /binding/);
  assert.throws(() => buildReceipt({ ...base, binding: { kind: 'content', value: 'hello' } }), /binding/);
  assert.throws(() => buildReceipt({ ...base, gate: 'post-comment', branch: 'riverwright/1-x', fork: null }), /branch/);
  assert.throws(() => buildReceipt({ ...base, gate: 'submit-gate', branch: null }), /branch/);
  assert.doesNotThrow(() => buildReceipt({ ...base, gate: 'post-comment', branch: null, fork: null, binding: { kind: 'content', value: `sha256:${'c'.repeat(64)}` } }));
});

function setup() {
  const home = tmpDir();
  const runDir = runDirIn(home);
  const keys = makeTestVault(home);
  return { home, runDir, keys, ledgerDir: ledgerDirFor(runDir) };
}
const find = (s, extra = {}) => findValidReceipt({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey, gate: 'submit-gate', run: RUN, nowMs: NOW_MS + 1000, binding: { kind: 'sha', value: A }, ...extra });

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

test('a truncated history before a receipt is detected, even when every line is renumbered and re-chained', () => {
  const s = setup();
  for (const n of [1, 2]) appendChained(s.ledgerDir, () => ({ event: 'note', at: NOW, actor: { type: 'agent' }, data: { n } }));
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.equal(find(s).ok, true);
  // Drop the first line, then renumber and rebuild the whole chain from genesis: a full rewrite an agent could do.
  const file = eventsFile(s.ledgerDir);
  const kept = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map((l) => JSON.parse(l));
  let prev = GENESIS;
  const out = kept.map((e, i) => {
    const line = JSON.stringify({ ...e, seq: i + 1, prev });
    prev = lineHash(line);
    return line;
  });
  fs.writeFileSync(file, `${out.join('\n')}\n`);
  assert.equal(verifyChain(s.ledgerDir).ok, true);
  assert.match(find(s).reason, /names seq 3 but sits at seq 2/);
  assert.deepEqual(verifyReceipts({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey }).map((p) => p.reason), ['the receipt names seq 3 but sits at seq 2']);
});

test('an approved event with a forged receipt is rejected', () => {
  const s = setup();
  const attacker = keysOf();
  appendChained(s.ledgerDir, ({ prev, seq }) => ({ event: 'approved', at: NOW, actor: { type: 'human' }, data: { receipt: signReceipt(buildReceipt({ ...base, ledgerHead: prev, seq, nonce: 'f0e1d2c3b4a59687f0e1d2c3b4a59687' }), attacker.privateKey) } }));
  assert.match(find(s).reason, /signature/);
});

test('verifyReceipts reports a repeated nonce and a receipt that names the wrong seq', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  appendChained(s.ledgerDir, () => ({ event: 'approved', at: NOW, actor: { type: 'human' }, data: { receipt: w.record.data.receipt } }));
  const problems = [...verifyReceipts({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey }), ...verifyConsumptions({ ledgerDir: s.ledgerDir })];
  assert.match(problems.map((p) => p.reason).join(' | '), /nonce.*more than once/);
  assert.match(problems.map((p) => p.reason).join(' | '), /seq/);
  assert.equal(readEvents(s.ledgerDir).length, 2);
});

// ---- Fix round 1 ----

const editLine = (s, i, fn) => {
  const file = eventsFile(s.ledgerDir);
  const ls = fs.readFileSync(file, 'utf8').trim().split('\n');
  ls[i] = fn(ls[i]);
  fs.writeFileSync(file, `${ls.join('\n')}\n`);
};

test('I1: editing an earlier line WITHOUT repairing prev is rejected by find and by verifyReceipts', () => {
  const s = setup();
  appendChained(s.ledgerDir, () => ({ event: 'note', at: NOW, actor: { type: 'agent' }, data: { n: 1 } }));
  appendChained(s.ledgerDir, () => ({ event: 'note', at: NOW, actor: { type: 'agent' }, data: { n: 2 } }));
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.equal(find(s).ok, true);
  editLine(s, 0, (l) => JSON.stringify({ ...JSON.parse(l), data: { n: 999 } }));
  const found = find(s);
  assert.equal(found.ok, false);
  assert.match(found.reason, /ledger head/);
  assert.ok(verifyReceipts({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey }).length > 0);
});

test('I1: a receipt at seq 1 must have signed the genesis head', () => {
  const s = setup();
  appendChained(s.ledgerDir, ({ seq }) => ({ event: 'approved', at: NOW, actor: { type: 'human' }, data: { receipt: signReceipt(buildReceipt({ ...base, ledgerHead: `sha256:${'1'.repeat(64)}`, seq }), s.keys.privateKey) } }));
  assert.match(find(s).reason, /ledger head/);
});

const consume = (s, extra = {}) => consumeReceipt({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey, gate: 'submit-gate', run: RUN, nowMs: NOW_MS + 1000, binding: { kind: 'sha', value: A }, outcome: 'claimed', at: NOW, ...extra });

test('I3: consumeReceipt re-verifies and consumes once; a second consume of the same nonce fails', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  const got = consume(s);
  assert.equal(got.receipt.nonce, w.record.data.receipt.nonce);
  const events = readEvents(s.ledgerDir);
  assert.equal(events.at(-1).event, 'receipt-consumed');
  assert.equal(events.at(-1).data.nonce, w.record.data.receipt.nonce);
  assert.throws(() => consume(s), /already used/);
  assert.equal(readEvents(s.ledgerDir).length, 2);
});

test('I3: consumeReceipt refuses (and writes nothing) when no valid receipt exists or the binding differs', () => {
  const s = setup();
  assert.throws(() => consume(s), /no receipt/);
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.throws(() => consume(s, { binding: { kind: 'sha', value: 'b'.repeat(40) } }), /binding/);
  assert.equal(readEvents(s.ledgerDir).length, 1);
});

test('I3: consumeReceipt takes the ledger lock, so a held lock blocks it', () => {
  const s = setup();
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  fs.writeFileSync(`${s.ledgerDir}/events.lock`, '');
  assert.throws(() => consume(s), (e) => e.code === 'LEDGER_BUSY');
  fs.rmSync(`${s.ledgerDir}/events.lock`);
  assert.doesNotThrow(() => consume(s));
});

test('I3: markConsumed checks the nonce shape, that the receipt exists and that it is not already consumed', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.throws(() => markConsumed({ ledgerDir: s.ledgerDir, nonce: '../../x', outcome: 'succeeded', at: NOW }), /nonce/);
  assert.throws(() => markConsumed({ ledgerDir: s.ledgerDir, nonce: 'a1'.repeat(16), outcome: 'succeeded', at: NOW }), /no receipt/);
  assert.throws(() => markConsumed({ ledgerDir: s.ledgerDir, nonce: w.record.data.receipt.nonce, outcome: 'bogus', at: NOW }), /outcome/);
  markConsumed({ ledgerDir: s.ledgerDir, nonce: w.record.data.receipt.nonce, outcome: 'succeeded', at: NOW });
  assert.throws(() => markConsumed({ ledgerDir: s.ledgerDir, nonce: w.record.data.receipt.nonce, outcome: 'succeeded', at: NOW }), /already/);
});

// ---- P1 (Task 3 re-review N1): a claim's final outcome can be recorded, exactly once ----

const outcomes = (s, nonce) => readEvents(s.ledgerDir).filter((e) => e.event === 'receipt-consumed' && e.data.nonce === nonce).map((e) => e.data.outcome);

test('P1: a claimed receipt moves once to succeeded, and nothing can be recorded after that', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  const nonce = w.record.data.receipt.nonce;
  consume(s);
  markConsumed({ ledgerDir: s.ledgerDir, nonce, outcome: 'succeeded', at: NOW });
  assert.deepEqual(outcomes(s, nonce), ['claimed', 'succeeded']);
  for (const outcome of ['succeeded', 'failed']) {
    assert.throws(() => markConsumed({ ledgerDir: s.ledgerDir, nonce, outcome, at: NOW }), /already/, outcome);
  }
  assert.throws(() => consume(s), /already used/);
  assert.deepEqual(outcomes(s, nonce), ['claimed', 'succeeded']);
});

test('P1: a claimed receipt moves once to failed, and a failed receipt is never usable again', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  const nonce = w.record.data.receipt.nonce;
  consume(s);
  markConsumed({ ledgerDir: s.ledgerDir, nonce, outcome: 'failed', at: NOW });
  assert.deepEqual(outcomes(s, nonce), ['claimed', 'failed']);
  assert.throws(() => markConsumed({ ledgerDir: s.ledgerDir, nonce, outcome: 'succeeded', at: NOW }), /already/);
  assert.match(find(s).reason, /already used/);
  assert.throws(() => consume(s), /already used/);
});

test('P1: a claimed receipt already counts as used, and a claim cannot be claimed again', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  consume(s);
  assert.match(find(s).reason, /already used/);
  assert.throws(() => consume(s), /already used/);
  assert.throws(() => markConsumed({ ledgerDir: s.ledgerDir, nonce: w.record.data.receipt.nonce, outcome: 'claimed', at: NOW }), /outcome/);
});

test('P1: a receipt recorded as succeeded or failed directly is final', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  const nonce = w.record.data.receipt.nonce;
  markConsumed({ ledgerDir: s.ledgerDir, nonce, outcome: 'succeeded', at: NOW });
  assert.throws(() => markConsumed({ ledgerDir: s.ledgerDir, nonce, outcome: 'failed', at: NOW }), /already/);
  assert.deepEqual(outcomes(s, nonce), ['succeeded']);
});

test('P1: the final outcome is recorded under the ledger lock', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  consume(s);
  fs.writeFileSync(`${s.ledgerDir}/events.lock`, '');
  assert.throws(() => markConsumed({ ledgerDir: s.ledgerDir, nonce: w.record.data.receipt.nonce, outcome: 'succeeded', at: NOW }), (e) => e.code === 'LEDGER_BUSY');
  fs.rmSync(`${s.ledgerDir}/events.lock`);
  markConsumed({ ledgerDir: s.ledgerDir, nonce: w.record.data.receipt.nonce, outcome: 'succeeded', at: NOW });
});

test('P1: a stray consumption line with an unknown outcome makes the receipt used and blocks any final outcome', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  const nonce = w.record.data.receipt.nonce;
  appendChained(s.ledgerDir, () => ({ event: 'receipt-consumed', at: NOW, actor: { type: 'agent' }, data: { nonce, outcome: 'whatever' } }));
  assert.match(find(s).reason, /already used/);
  assert.throws(() => markConsumed({ ledgerDir: s.ledgerDir, nonce, outcome: 'succeeded', at: NOW }), /already/);
});

test('M1: a receipt with unknown extra fields, top-level or inside binding, or an unnormalized branch, is rejected', () => {
  const k = keysOf();
  const r = signReceipt(buildReceipt(base), k.privateKey);
  assert.equal(verifyReceipt({ ...r, extra: 1 }, k.publicKey), false);
  assert.equal(verifyReceipt({ ...r, binding: { ...r.binding, extra: 1 } }, k.publicKey), false);
  assert.equal(verifyReceipt({ ...r, branch: `refs/heads/${r.branch}` }, k.publicKey), false);
});

test('M2: the signature must be strict canonical base64 of 64 bytes', () => {
  const k = keysOf();
  const r = signReceipt(buildReceipt(base), k.privateKey);
  assert.equal(verifyReceipt(r, k.publicKey), true);
  assert.equal(verifyReceipt({ ...r, signature: `${r.signature}\n  ` }, k.publicKey), false);
  assert.equal(verifyReceipt({ ...r, signature: r.signature.replace(/==$/, '') }, k.publicKey), false);
  assert.equal(verifyReceipt({ ...r, signature: Buffer.alloc(63).toString('base64') }, k.publicKey), false);
});

test('M2: a public key that is not Ed25519 never verifies', () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const r = signReceipt(buildReceipt(base), keysOf().privateKey);
  assert.equal(verifyReceipt(r, rsa.publicKey.export({ type: 'spki', format: 'pem' })), false);
});

test('M3: "at" must be a strict ISO-8601 UTC string', () => {
  for (const at of ['Oct 2 2026 14:03:11', '2026-10-02', '2026-10-02T14:03:11', '2026-10-02T14:03:11+02:00', '2026-13-45T99:99:99Z']) {
    assert.throws(() => buildReceipt({ ...base, at }), /at/, at);
  }
  assert.doesNotThrow(() => buildReceipt({ ...base, at: '2026-10-02T14:03:11Z' }));
  assert.doesNotThrow(() => buildReceipt({ ...base, at: NOW }));
});

test('M4: the nonce must be exactly 32 lowercase hex characters and not one repeated character', () => {
  for (const nonce of ['n'.repeat(32), 'a'.repeat(32), '0'.repeat(32), 'abc', 'A1'.repeat(16), `${'a1'.repeat(15)}zz`, 'a1'.repeat(17)]) {
    assert.throws(() => buildReceipt({ ...base, nonce }), /nonce/, nonce);
  }
  assert.doesNotThrow(() => buildReceipt({ ...base, nonce: undefined }));
});

test('M4: appending a receipt with a nonce already in the ledger is refused', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.throws(() => appendReceipt({ ledgerDir: s.ledgerDir, privateKey: s.keys.privateKey, gate: 'submit-gate', run: RUN, binding: { kind: 'sha', value: A }, branch: 'riverwright/3509-codex', fork: FORK_KEY, at: NOW, nonce: w.record.data.receipt.nonce }), /nonce/);
});

test('M5: a non-object ledger line (null) does not crash find; verifyReceipts reports it', () => {
  const s = setup();
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  fs.appendFileSync(eventsFile(s.ledgerDir), 'null\n');
  let found;
  assert.doesNotThrow(() => { found = find(s); });
  assert.equal(found.ok, false);
  assert.equal(typeof found.reason, 'string');
  let problems;
  assert.doesNotThrow(() => { problems = verifyReceipts({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey }); });
  assert.match(problems.map((p) => p.reason).join(' | '), /not a JSON object/);
});

test('M6: binding is required to find or consume a receipt', () => {
  const s = setup();
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.throws(() => find(s, { binding: undefined }), /binding/);
  assert.throws(() => consume(s, { binding: undefined }), /binding/);
});

test('KNOWN LIMITATION (ADR-0010, I2): dropping the tail line that records consumption revives the receipt', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  markConsumed({ ledgerDir: s.ledgerDir, nonce: w.record.data.receipt.nonce, outcome: 'succeeded', at: NOW });
  assert.match(find(s).reason, /already used/);
  const file = eventsFile(s.ledgerDir);
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8').trim().split('\n').slice(0, -1).join('\n')}\n`);
  // Tamper-evident, not tamper-proof: without an anchor outside the agent-writable ledger this cannot be seen.
  assert.equal(find(s).ok, true);
});

// ADR-0012: a lease is the remote tip a re-submit replaces. It is signed, and only a submit-gate receipt for a
// commit carries one.
test('a lease names the remote tip a re-submit replaces, is signed, and belongs to the submit gate and a commit only', () => {
  const k = keysOf();
  const C = 'c'.repeat(40);
  const r = signReceipt(buildReceipt({ ...base, lease: C }), k.privateKey);
  assert.equal(r.lease, C);
  assert.equal(verifyReceipt(r, k.publicKey), true);
  assert.equal(verifyReceipt({ ...r, lease: 'd'.repeat(40) }, k.publicKey), false);
  assert.equal(verifyReceipt({ ...r, lease: null }, k.publicKey), false);
  assert.equal(verifyReceipt(signReceipt(buildReceipt(base), k.privateKey), k.publicKey), true);
  assert.equal(verifyReceipt({ ...signReceipt(buildReceipt(base), k.privateKey), lease: C }, k.publicKey), false, 'a lease cannot be added to a signed receipt');
  assert.equal(buildReceipt(base).lease, null);
  for (const lease of ['abc', C.toUpperCase(), `${C} `, 'g'.repeat(40), 42, '']) assert.throws(() => buildReceipt({ ...base, lease }), /lease/, String(lease));
  assert.doesNotThrow(() => buildReceipt({ ...base, binding: { kind: 'sha', value: 'f'.repeat(64) }, lease: 'e'.repeat(64) }));
  // Finding M-1: a lease that can never be a real replacement is refused, so the human is never shown one.
  for (const lease of ['0'.repeat(40), base.binding.value, 'e'.repeat(64)]) assert.throws(() => buildReceipt({ ...base, lease }), /lease/, lease);
  assert.throws(() => buildReceipt({ ...base, gate: 'post-comment', branch: null, fork: null, binding: { kind: 'content', value: `sha256:${'c'.repeat(64)}` }, lease: C }), /lease/);
  assert.throws(() => buildReceipt({ ...base, binding: { kind: 'content', value: `sha256:${'c'.repeat(64)}` }, lease: C }), /lease/);
});

// R16(b): the fork the commit goes to is signed, as the normalized host/owner/repo key, so a forged state.json
// fork.url cannot send the approved commit anywhere else.
test('a submit-gate receipt signs its fork as a normalized host/owner/repo key; other gates name none', () => {
  const k = keysOf();
  const r = signReceipt(buildReceipt(base), k.privateKey);
  assert.equal(r.fork, FORK_KEY);
  assert.equal(verifyReceipt({ ...r, fork: 'github.com/attacker/ruflo' }, k.publicKey), false);
  assert.equal(verifyReceipt({ ...r, fork: null }, k.publicKey), false);
  assert.throws(() => buildReceipt({ ...base, fork: null }), /fork/);
  assert.throws(() => buildReceipt({ ...base, fork: undefined }), /fork/);
  for (const fork of ['https://github.com/pacphi/ruflo.git', 'github.com/PacPhi/ruflo', 'github.com/pacphi/ruflo.git', 'github.com/pacphi', 'github.com/pacphi/ruflo/x',
    'git@github.com:pacphi/ruflo', 'x@github.com/pacphi/ruflo', 'github.com:443/pacphi/ruflo', 'localhost/pacphi/ruflo', 'github.com/../ruflo', ' github.com/pacphi/ruflo', 42]) {
    assert.throws(() => buildReceipt({ ...base, fork }), /fork/, String(fork));
  }
  assert.throws(() => buildReceipt({ ...base, gate: 'post-comment', branch: null, binding: { kind: 'content', value: `sha256:${'c'.repeat(64)}` } }), /fork/);
  assert.equal(buildReceipt({ ...base, gate: 'post-comment', branch: null, fork: null, binding: { kind: 'content', value: `sha256:${'c'.repeat(64)}` } }).fork, null);
  assert.doesNotThrow(() => buildReceipt({ ...base, binding: { kind: 'content', value: `sha256:${'c'.repeat(64)}` } }));
});

// A receipt signed before the fork and the lease were bound (no `fork` or `lease` keys) is refused: it cannot say
// which fork it approved, so it fails closed.
test('a receipt in the shape signed before fork and lease binding never verifies', () => {
  const k = keysOf();
  const { fork, lease, ...old } = buildReceipt(base);
  assert.equal(fork, FORK_KEY);
  assert.equal(lease, null);
  const oldBytes = Buffer.from(`${RECEIPT_SCHEMA}\n${JSON.stringify([old.gate, old.run, old.binding.kind, old.binding.value, old.branch, old.ledgerHead, old.seq, old.at, old.nonce])}`, 'utf8');
  const signedOld = { ...old, signature: crypto.sign(null, oldBytes, k.privateKey).toString('base64') };
  assert.equal(verifyReceipt(signedOld, k.publicKey), false);
  assert.equal(verifyReceipt({ ...signedOld, fork: FORK_KEY, lease: null }, k.publicKey), false);
  const s = setup();
  appendChained(s.ledgerDir, ({ prev, seq }) => {
    const r = { ...old, ledgerHead: prev, seq };
    const bytes = Buffer.from(`${RECEIPT_SCHEMA}\n${JSON.stringify([r.gate, r.run, r.binding.kind, r.binding.value, r.branch, r.ledgerHead, r.seq, r.at, r.nonce])}`, 'utf8');
    return { event: 'approved', at: NOW, run: RUN, actor: { type: 'human' }, data: { receipt: { ...r, signature: crypto.sign(null, bytes, s.keys.privateKey).toString('base64') } } };
  });
  assert.equal(find(s).ok, false);
  assert.equal(verifyReceipts({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey }).length, 1);
});

test('appendReceipt signs the fork and the lease, and ledger verification accepts the result', () => {
  const s = setup();
  const C = 'c'.repeat(40);
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys, lease: C });
  assert.equal(w.record.data.receipt.fork, FORK_KEY);
  assert.equal(w.record.data.receipt.lease, C);
  assert.deepEqual(verifyReceipts({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey }), []);
  assert.deepEqual(verifyConsumptions({ ledgerDir: s.ledgerDir }), []);
  const found = find(s);
  assert.equal(found.ok, true, found.reason);
  assert.equal(found.receipt.lease, C);
  assert.equal(found.receipt.fork, FORK_KEY);
});
