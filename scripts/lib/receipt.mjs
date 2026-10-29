// Signed receipts for public actions (ADR-0010). An unlock signs one and appends it to the ledger as an
// `approved` event. The receipt commits to the ledger head and seq its own event takes, so rewriting any
// earlier history breaks it: the human's signature anchors the chain.
//
// Residual risk (ADR-0010): the ledger is a file the agent can write. Rewriting or editing history is
// detected, because every receipt anchors the head it saw. Removing the TAIL is not: if the agent drops the
// last line(s), for example the `receipt-consumed` event, the shorter chain still verifies and a used
// receipt looks unused again until it expires (10 minutes). Nothing outside the ledger remembers the newer
// head, so this is tamper-evident, not tamper-proof. Only an anchor the agent cannot write (a signed
// consumption marker, or a head kept elsewhere) would close it. See the test named KNOWN LIMITATION.
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { RiverwrightError } from './errors.mjs';
import { normalizeBranch } from './approvals.mjs';
import { GENESIS, appendChained, readEvents, verifyChain } from './events.mjs';

export const RECEIPT_SCHEMA = 'riverwright-receipt/1';
export const PUBLIC_GATES = ['submit-gate', 'post-issue', 'post-comment'];
export const RECEIPT_TTL_MS = 10 * 60 * 1000;
const FUTURE_SKEW_MS = 60_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTENT = /^sha256:[0-9a-f]{64}$/;
const HEAD = /^sha256:[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const FIELDS = ['schema', 'gate', 'run', 'binding', 'branch', 'ledgerHead', 'seq', 'at', 'nonce', 'signature'];
const nonceOk = (n) => typeof n === 'string' && NONCE.test(n) && !/^(.)\1+$/.test(n);
const isObject = (e) => e !== null && typeof e === 'object' && !Array.isArray(e);

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
  if (typeof at !== 'string' || !AT.test(at) || Number.isNaN(Date.parse(at))) throw bad('"at" must be an ISO-8601 UTC time such as 2026-10-02T14:03:11.000Z');
  if (!nonceOk(nonce)) throw bad('nonce must be 32 lowercase hex characters, not one repeated character');
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
    if (!isObject(receipt) || !isObject(receipt.binding)) return false;
    if (Object.keys(receipt).some((k) => !FIELDS.includes(k)) || Object.keys(receipt.binding).sort().join() !== 'kind,value') return false;
    if (!SIGNATURE.test(signature)) return false;
    const sig = Buffer.from(signature, 'base64');
    if (sig.length !== 64 || sig.toString('base64') !== signature) return false;
    const key = crypto.createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const rebuilt = buildReceipt(rest);
    if (!isDeepStrictEqual(rebuilt, rest)) return false;
    return crypto.verify(null, receiptBytes(rebuilt), key, sig);
  } catch {
    return false;
  }
}

// Signs and appends in one step, under the ledger lock, so the receipt names the exact head and seq it gets.
export function appendReceipt({ ledgerDir, privateKey, gate, run, binding, branch = null, at, nonce }) {
  return appendChained(ledgerDir, ({ prev, seq }) => {
    const receipt = buildReceipt({ gate, run, binding, branch, ledgerHead: prev, seq, at, nonce });
    if (readEvents(ledgerDir).some((e) => isObject(e) && e.data?.receipt?.nonce === receipt.nonce)) throw bad('that nonce is already in the ledger');
    return { event: 'approved', at, run, actor: { type: 'human' }, data: { receipt: signReceipt(receipt, privateKey) } };
  });
}

const consumedNonces = (events) => new Set(events.filter((e) => isObject(e) && e.event === 'receipt-consumed').map((e) => e.data?.nonce));

// Records an outcome for a receipt that exists and is not yet consumed. Normal callers use consumeReceipt.
export function markConsumed({ ledgerDir, nonce, outcome, at }) {
  if (!['succeeded', 'failed'].includes(outcome)) throw bad('outcome must be succeeded or failed');
  if (!nonceOk(nonce)) throw bad('nonce must be 32 lowercase hex characters, not one repeated character');
  return appendChained(ledgerDir, () => {
    const events = readEvents(ledgerDir);
    if (!events.some((e) => isObject(e) && e.event === 'approved' && e.data?.receipt?.nonce === nonce)) throw bad('no receipt with that nonce is in the ledger');
    if (consumedNonces(events).has(nonce)) throw bad('this receipt was already used');
    return { event: 'receipt-consumed', at, actor: { type: 'human' }, data: { nonce, outcome } };
  });
}

// Why a receipt's anchor does not hold: the chain must verify, and the line before the receipt must hash to
// the head the human signed. Returns null when it holds.
function anchorReason(ledgerDir, r) {
  const head = 'the ledger head the receipt signed does not match the ledger';
  try {
    if (r.seq === 1) {
      if (r.ledgerHead !== GENESIS) return `${head}: a first receipt must sign the genesis head`;
      const c = verifyChain(ledgerDir);
      return c.ok ? null : `${head}: ${c.problems[0].reason}`;
    }
    const c = verifyChain(ledgerDir, { expectHead: r.ledgerHead, expectSeq: r.seq - 1 });
    return c.ok ? null : `${head}: ${c.problems[0].reason}`;
  } catch {
    return `${head}: the ledger could not be verified`;
  }
}

function checkOne(event, publicKey, ledgerDir) {
  const r = event.data.receipt;
  if (!verifyReceipt(r, publicKey)) return 'the receipt signature does not verify against the vault key';
  if (r.seq !== event.seq) return `the receipt names seq ${r.seq} but sits at seq ${event.seq}`;
  if (r.ledgerHead !== event.prev) return 'the ledger head the receipt signed is not the head before it: history before this receipt was changed';
  return anchorReason(ledgerDir, r);
}

// The newest receipt for this gate and run that is signed, anchored to the ledger, unused, current and bound
// to the requested SHA or content. `binding` is required: a forgotten argument must not accept any binding.
// Returns { ok: true, receipt, seq } or { ok: false, reason }.
export function findValidReceipt({ ledgerDir, publicKey, gate, run, nowMs, binding }) {
  if (!isObject(binding)) throw bad('findValidReceipt needs the binding ({ kind, value }) being published');
  const events = readEvents(ledgerDir).filter(isObject);
  const used = consumedNonces(events);
  const candidates = events.filter((e) => e.event === 'approved' && e.data?.receipt?.gate === gate && e.data.receipt.run === run);
  if (!candidates.length) return { ok: false, reason: 'no receipt for this gate and run: unlock through "riverwright submit" or "riverwright post"' };
  let first = null;
  for (const e of [...candidates].reverse()) {
    const r = e.data.receipt;
    let reason = checkOne(e, publicKey, ledgerDir);
    if (!reason && used.has(r.nonce)) reason = 'this receipt was already used';
    if (!reason) {
      const age = nowMs - Date.parse(r.at);
      if (Number.isNaN(age)) reason = 'the clock or the receipt time could not be read';
      else if (age < -FUTURE_SKEW_MS) reason = 'the receipt is dated in the future';
      else if (age > RECEIPT_TTL_MS) reason = 'the receipt expired';
    }
    if (!reason && (binding.kind !== r.binding.kind || binding.value !== r.binding.value)) reason = 'the receipt binding does not match what is being published';
    if (!reason) return { ok: true, receipt: r, seq: e.seq };
    first ??= reason;
  }
  return { ok: false, reason: first };
}

// The atomic claim. Under the ledger lock it finds and re-verifies the receipt, checks it is unconsumed, and
// appends `receipt-consumed`; a second caller (or a second process) then finds it used. Call it BEFORE the
// network action, with outcome "claimed", so a crash cannot leave the receipt reusable. Throws
// RECEIPT_REFUSED with the reason when no receipt qualifies.
export function consumeReceipt({ ledgerDir, publicKey, gate, run, nowMs, binding, at, outcome = 'claimed' }) {
  if (!['claimed', 'succeeded', 'failed'].includes(outcome)) throw bad('outcome must be claimed, succeeded or failed');
  let receipt;
  const appended = appendChained(ledgerDir, () => {
    const found = findValidReceipt({ ledgerDir, publicKey, gate, run, nowMs, binding });
    if (!found.ok) throw new RiverwrightError('RECEIPT_REFUSED', found.reason);
    receipt = found.receipt;
    return { event: 'receipt-consumed', at, actor: { type: 'human' }, data: { nonce: receipt.nonce, outcome } };
  });
  return { ok: true, receipt, seq: appended.seq };
}

// For `riverwright ledger verify`: every approved event's signature, position, anchor and nonce.
export function verifyReceipts({ ledgerDir, publicKey }) {
  const problems = [];
  const seen = new Map();
  readEvents(ledgerDir).forEach((e, i) => {
    if (!isObject(e)) {
      problems.push({ line: i + 1, reason: 'the line is not a JSON object' });
      return;
    }
    if (e.event !== 'approved' || !e.data?.receipt) return;
    const reason = checkOne(e, publicKey, ledgerDir);
    if (reason) problems.push({ line: e.seq, reason });
    const n = e.data.receipt.nonce;
    if (seen.has(n)) problems.push({ line: e.seq, reason: `nonce ${n} appears more than once (first at seq ${seen.get(n)})` });
    else seen.set(n, e.seq);
  });
  return problems;
}
