// Signed receipts for public actions (ADR-0010). An unlock signs one and appends it to the ledger as an
// `approved` event. The receipt commits to the ledger head and seq its own event takes, so rewriting any
// earlier history breaks it: the human's signature anchors the chain.
import crypto from 'node:crypto';
import { RiverwrightError } from './errors.mjs';
import { normalizeBranch } from './approvals.mjs';
import { appendChained, readEvents } from './events.mjs';

export const RECEIPT_SCHEMA = 'riverwright-receipt/1';
export const PUBLIC_GATES = ['submit-gate', 'post-issue', 'post-comment'];
export const RECEIPT_TTL_MS = 10 * 60 * 1000;
const FUTURE_SKEW_MS = 60_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTENT = /^sha256:[0-9a-f]{64}$/;
const HEAD = /^sha256:[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9]{16,64}$/;

const bad = (msg) => new RiverwrightError('BAD_RECEIPT', msg);

export function buildReceipt({ gate, run, binding, branch = null, ledgerHead, seq, at, nonce = crypto.randomBytes(16).toString('hex') }) {
  if (!PUBLIC_GATES.includes(gate)) throw bad(`"${gate}" is not a public gate (${PUBLIC_GATES.join(', ')})`);
  if (typeof run !== 'string' || !run) throw bad('a receipt names its run');
  const okBinding = (binding?.kind === 'sha' && SHA.test(binding.value)) || (binding?.kind === 'content' && CONTENT.test(binding.value));
  if (!okBinding) throw bad('binding must be a full commit SHA or a sha256: content hash');
  if (gate === 'submit-gate') branch = normalizeBranch(branch);
  else if (branch !== null) throw bad('only the submit gate names a branch');
  if (!HEAD.test(ledgerHead ?? '')) throw bad('ledgerHead must be sha256:<64 hex>');
  if (!Number.isInteger(seq) || seq < 1) throw bad('seq must be a positive integer');
  if (typeof at !== 'string' || !at) throw bad('a receipt needs "at"');
  if (!NONCE.test(nonce)) throw bad('nonce must be 16 to 64 letters or digits');
  return { schema: RECEIPT_SCHEMA, gate, run, binding: { kind: binding.kind, value: binding.value }, branch, ledgerHead, seq, at, nonce };
}

// A JSON array in fixed order, so no field can be moved into its neighbour without changing the bytes.
export function receiptBytes(r) {
  return Buffer.from(`${RECEIPT_SCHEMA}\n${JSON.stringify([r.gate, r.run, r.binding.kind, r.binding.value, r.branch, r.ledgerHead, r.seq, r.at, r.nonce])}`, 'utf8');
}

export function signReceipt(receipt, privateKey) {
  return { ...receipt, signature: crypto.sign(null, receiptBytes(receipt), privateKey).toString('base64') };
}

export function verifyReceipt(receipt, publicKey) {
  try {
    if (receipt?.schema !== RECEIPT_SCHEMA || typeof receipt.signature !== 'string') return false;
    const { signature, ...rest } = receipt;
    const rebuilt = buildReceipt(rest);
    return crypto.verify(null, receiptBytes(rebuilt), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

// Signs and appends in one step, under the ledger lock, so the receipt names the exact head and seq it gets.
export function appendReceipt({ ledgerDir, privateKey, gate, run, binding, branch = null, at, nonce }) {
  return appendChained(ledgerDir, ({ prev, seq }) => ({
    event: 'approved',
    at,
    run,
    actor: { type: 'human' },
    data: { receipt: signReceipt(buildReceipt({ gate, run, binding, branch, ledgerHead: prev, seq, at, nonce }), privateKey) },
  }));
}

export function markConsumed({ ledgerDir, nonce, outcome, at }) {
  if (!['succeeded', 'failed'].includes(outcome)) throw bad('outcome must be succeeded or failed');
  return appendChained(ledgerDir, () => ({ event: 'receipt-consumed', at, actor: { type: 'human' }, data: { nonce, outcome } }));
}

function checkOne(event, publicKey) {
  const r = event.data.receipt;
  if (!verifyReceipt(r, publicKey)) return 'the receipt signature does not verify against the vault key';
  if (r.seq !== event.seq) return `the receipt names seq ${r.seq} but sits at seq ${event.seq}`;
  if (r.ledgerHead !== event.prev) return 'the ledger head the receipt signed is not the head before it: history before this receipt was changed';
  return null;
}

// The newest receipt for this gate and run that is signed, in place, unused, current and (if asked) bound
// to the requested SHA or content. Returns { ok: true, receipt, seq } or { ok: false, reason }.
export function findValidReceipt({ ledgerDir, publicKey, gate, run, nowMs, binding = null }) {
  const events = readEvents(ledgerDir);
  const used = new Set(events.filter((e) => e.event === 'receipt-consumed').map((e) => e.data?.nonce));
  const candidates = events.filter((e) => e.event === 'approved' && e.data?.receipt?.gate === gate && e.data.receipt.run === run);
  if (!candidates.length) return { ok: false, reason: 'no receipt for this gate and run: unlock through "riverwright submit" or "riverwright post"' };
  let first = null;
  for (const e of [...candidates].reverse()) {
    const r = e.data.receipt;
    let reason = checkOne(e, publicKey);
    if (!reason && used.has(r.nonce)) reason = 'this receipt was already used';
    if (!reason) {
      const age = nowMs - Date.parse(r.at);
      if (Number.isNaN(age)) reason = 'the clock or the receipt time could not be read';
      else if (age < -FUTURE_SKEW_MS) reason = 'the receipt is dated in the future';
      else if (age > RECEIPT_TTL_MS) reason = 'the receipt expired';
    }
    if (!reason && binding && (binding.kind !== r.binding.kind || binding.value !== r.binding.value)) reason = 'the receipt binding does not match what is being published';
    if (!reason) return { ok: true, receipt: r, seq: e.seq };
    first ??= reason;
  }
  return { ok: false, reason: first };
}

// For `riverwright ledger verify`: every approved event's signature, position and nonce.
export function verifyReceipts({ ledgerDir, publicKey }) {
  const problems = [];
  const seen = new Map();
  for (const e of readEvents(ledgerDir)) {
    if (e.event !== 'approved' || !e.data?.receipt) continue;
    const reason = checkOne(e, publicKey);
    if (reason) problems.push({ line: e.seq, reason });
    const n = e.data.receipt.nonce;
    if (seen.has(n)) problems.push({ line: e.seq, reason: `nonce ${n} appears more than once (first at seq ${seen.get(n)})` });
    else seen.set(n, e.seq);
  }
  return problems;
}
