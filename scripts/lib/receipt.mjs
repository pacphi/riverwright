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
//
// A receipt's life, read from the `receipt-consumed` lines that name its nonce (every write is under the
// ledger lock, and every transition appends; nothing is ever edited):
//
//   unused --consumeReceipt(claimed)-------> claimed --markConsumed(succeeded|failed)--> final
//   unused --consumeReceipt/markConsumed(succeeded|failed)--------------------------> final
//
// - unused: no line names the nonce. Only an unused receipt can authorize anything (findValidReceipt).
// - claimed: exactly one line, outcome "claimed". Already USED: no second claim, no second action. The one
//   thing it allows is recording its final outcome, once.
// - final: a line with "succeeded" or "failed" (after a claim, or directly). Nothing more may be recorded.
// - Any other set of lines (a stray or unknown outcome) also counts as used, and no outcome can follow it.
// A failed receipt is never reusable: the bounded retry in the gate (ADR-0010) happens inside one process,
// on the receipt it already holds in memory, and a new run needs a new unlock and a new receipt.
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { RiverwrightError } from './errors.mjs';
import { normalizeBranch } from './approvals.mjs';
import { shown } from './printable.mjs';
import { normalizeRemoteUrl } from './giturl.mjs';
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
const FIELDS = ['schema', 'gate', 'run', 'binding', 'branch', 'fork', 'lease', 'ledgerHead', 'seq', 'at', 'nonce', 'signature'];
const nonceOk = (n) => typeof n === 'string' && NONCE.test(n) && !/^(.)\1+$/.test(n);
const isObject = (e) => e !== null && typeof e === 'object' && !Array.isArray(e);

const bad = (msg) => new RiverwrightError('BAD_RECEIPT', msg);

// The fork a push may go to, as host/owner/repo: the key normalizeRemoteUrl gives an https, ssh or scp-style URL
// of it. Only that exact canonical text is a fork key (lowercase, no scheme, user, port or ".git").
export const isForkKey = (fork) => typeof fork === 'string' && normalizeRemoteUrl(`https://${fork}`) === fork;

// The fields a receipt signs. `fork` (ruling R16(b)) and `lease` (ADR-0012) belong to the submit gate:
// - fork: required on every submit-gate receipt, null on the others. The pre-push guard allows a push only to this
//   repository, so a forged fork.url in state.json cannot send the approved commit anywhere else.
// - lease: null, or (submit gate, bound to a commit) the full SHA of the remote branch tip the human approved
//   replacing. The guard then allows only that one replacement.
// A receipt signed before these fields existed has neither key: verifyReceipt refuses it (it cannot say which fork
// it approved), so it fails closed and the human unlocks again.
export function buildReceipt({ gate, run, binding, branch = null, fork = null, lease = null, ledgerHead, seq, at, nonce = crypto.randomBytes(16).toString('hex') }) {
  if (!PUBLIC_GATES.includes(gate)) throw bad(`"${gate}" is not a public gate (${PUBLIC_GATES.join(', ')})`);
  if (typeof run !== 'string' || !run) throw bad('a receipt names its run');
  const okBinding = (binding?.kind === 'sha' && SHA.test(binding.value)) || (binding?.kind === 'content' && CONTENT.test(binding.value));
  if (!okBinding) throw bad('binding must be a full commit SHA or a sha256: content hash');
  if (gate === 'submit-gate') branch = normalizeBranch(branch);
  else if (branch !== null) throw bad('only the submit gate names a branch');
  if (gate === 'submit-gate' ? !isForkKey(fork) : fork !== null) throw bad('a submit-gate receipt names its fork as host/owner/repo (for example github.com/you/repo), and no other gate names a fork');
  if (lease !== null && !(gate === 'submit-gate' && binding.kind === 'sha' && typeof lease === 'string' && SHA.test(lease))) throw bad('a lease is the full lowercase SHA of the remote tip, and only a submit-gate receipt for a commit has one');
  if (!HEAD.test(ledgerHead ?? '')) throw bad('ledgerHead must be sha256:<64 hex>');
  if (!Number.isInteger(seq) || seq < 1) throw bad('seq must be a positive integer');
  if (typeof at !== 'string' || !AT.test(at) || Number.isNaN(Date.parse(at))) throw bad('"at" must be an ISO-8601 UTC time such as 2026-10-02T14:03:11.000Z');
  if (!nonceOk(nonce)) throw bad('nonce must be 32 lowercase hex characters, not one repeated character');
  return { schema: RECEIPT_SCHEMA, gate, run, binding: { kind: binding.kind, value: binding.value }, branch, fork, lease, ledgerHead, seq, at, nonce };
}

// A JSON array in fixed order, so no field can be moved into its neighbour without changing the bytes.
export function receiptBytes(r) {
  return Buffer.from(`${RECEIPT_SCHEMA}\n${JSON.stringify([r.gate, r.run, r.binding.kind, r.binding.value, r.branch, r.fork, r.lease, r.ledgerHead, r.seq, r.at, r.nonce])}`, 'utf8');
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
export function appendReceipt({ ledgerDir, privateKey, gate, run, binding, branch = null, fork = null, lease = null, at, nonce }) {
  return appendChained(ledgerDir, ({ prev, seq }) => {
    const receipt = buildReceipt({ gate, run, binding, branch, fork, lease, ledgerHead: prev, seq, at, nonce });
    if (readEvents(ledgerDir).some((e) => isObject(e) && e.data?.receipt?.nonce === receipt.nonce)) throw bad('that nonce is already in the ledger');
    return { event: 'approved', at, run, actor: { type: 'human' }, data: { receipt: signReceipt(receipt, privateKey) } };
  });
}

const consumedNonces = (events) => new Set(events.filter((e) => isObject(e) && e.event === 'receipt-consumed').map((e) => e.data?.nonce));

// The outcomes recorded for one nonce, in ledger order.
const outcomesOf = (events, nonce) => events.filter((e) => isObject(e) && e.event === 'receipt-consumed' && e.data?.nonce === nonce).map((e) => e.data?.outcome);

// Records the final outcome (succeeded or failed) of a receipt that is unused or claimed, once (see the state
// machine above). It does not re-verify the signature: the caller holds the receipt it signed or claimed.
export function markConsumed({ ledgerDir, nonce, outcome, at }) {
  if (!['succeeded', 'failed'].includes(outcome)) throw bad('outcome must be succeeded or failed');
  if (!nonceOk(nonce)) throw bad('nonce must be 32 lowercase hex characters, not one repeated character');
  return appendChained(ledgerDir, () => {
    const events = readEvents(ledgerDir);
    if (!events.some((e) => isObject(e) && e.event === 'approved' && e.data?.receipt?.nonce === nonce)) throw bad('no receipt with that nonce is in the ledger');
    const seen = outcomesOf(events, nonce);
    const claimedOnly = seen.length === 1 && seen[0] === 'claimed';
    if (seen.length && !claimedOnly) throw bad('this receipt was already used and its outcome is already recorded');
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
  if (isObject(r) && r.schema === RECEIPT_SCHEMA && !('fork' in r && 'lease' in r)) return 'the receipt was signed before receipts named their fork and lease, so it cannot authorize anything: unlock again';
  if (!verifyReceipt(r, publicKey)) return 'the receipt signature does not verify against the vault key';
  if (r.seq !== event.seq) return `the receipt names seq ${r.seq} but sits at seq ${event.seq}`;
  if (r.ledgerHead !== event.prev) return 'the ledger head the receipt signed is not the head before it: history before this receipt was changed';
  return anchorReason(ledgerDir, r);
}

// The newest receipt for this gate and run that is signed, anchored to the ledger, unused, current and bound
// to the requested SHA or content (and, when `nonce` is given, only that one receipt; when `seq` is given, only the
// event at that ledger position, which a copied receipt cannot fake because checkOne compares the signed seq). `binding` is required: a forgotten argument must not accept any binding.
// Returns { ok: true, receipt, seq } or { ok: false, reason }.
export function findValidReceipt({ ledgerDir, publicKey, gate, run, nowMs, binding, nonce = null, seq = null }) {
  if (!isObject(binding)) throw bad('findValidReceipt needs the binding ({ kind, value }) being published');
  const events = readEvents(ledgerDir).filter(isObject);
  const used = consumedNonces(events);
  const candidates = events.filter((e) => e.event === 'approved' && e.data?.receipt?.gate === gate && e.data.receipt.run === run && (nonce === null || e.data.receipt.nonce === nonce) && (seq === null || e.seq === seq));
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

// The newest `approved` event (by ledger position) for this gate and run, or undefined. Not verified.
export function newestReceiptEvent(ledgerDir, gate, run) {
  return readEvents(ledgerDir)
    .filter((e) => isObject(e) && e.event === 'approved' && e.data?.receipt?.gate === gate && e.data.receipt.run === run)
    .at(-1);
}

// Whether the NEWEST receipt for this gate and run (by ledger position) is signed, anchored, unused, current and
// bound to `binding`. An older receipt never stands in for a newer one that failed (ruling R17). Same result
// shape as findValidReceipt.
export function findNewestValidReceipt({ ledgerDir, publicKey, gate, run, nowMs, binding }) {
  const newest = newestReceiptEvent(ledgerDir, gate, run);
  if (!newest) return { ok: false, reason: 'no receipt for this gate and run: unlock through "riverwright submit" or "riverwright post"' };
  return findValidReceipt({ ledgerDir, publicKey, gate, run, nowMs, binding, seq: newest.seq });
}

// The atomic claim. Under the ledger lock it finds and re-verifies the receipt, checks it is unconsumed, and
// appends `receipt-consumed`; a second caller (or a second process) then finds it used. Call it BEFORE the
// network action, with outcome "claimed", so a crash cannot leave the receipt reusable, then record the final
// outcome with markConsumed. Throws RECEIPT_REFUSED with the reason when no receipt qualifies.
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

// For `riverwright ledger verify`: every approved event's signature, position and anchor. Repeated nonces are
// reported by verifyConsumptions, which needs no key.
export function verifyReceipts({ ledgerDir, publicKey }) {
  const problems = [];
  readEvents(ledgerDir).forEach((e, i) => {
    if (!isObject(e)) {
      problems.push({ line: i + 1, reason: 'the line is not a JSON object' });
      return;
    }
    if (e.event !== 'approved' || !e.data?.receipt) return;
    const reason = checkOne(e, publicKey, ledgerDir);
    if (reason) problems.push({ line: e.seq, reason });
  });
  return problems;
}

// For `riverwright ledger verify`: the `receipt-consumed` lines must follow the state machine above. Each must
// name a nonce of an earlier `approved` receipt, carry a known outcome, and per nonce be one of
// [claimed], [claimed, final] or [final] (final = succeeded | failed). Also flags an `approved` event with no
// receipt and a nonce that appears in two `approved` events. Needs no key.
export function verifyConsumptions({ ledgerDir }) {
  const problems = [];
  const approvedAt = new Map();
  const state = new Map(); // nonce -> { claimed, final }
  readEvents(ledgerDir).forEach((e) => {
    if (!isObject(e)) return;
    const line = e.seq;
    if (e.event === 'approved') {
      if (!e.data?.receipt) return void problems.push({ line, reason: 'an approved event carries no receipt' });
      const n = e.data.receipt.nonce;
      if (approvedAt.has(n)) problems.push({ line, reason: `nonce ${shown(n)} appears more than once (first at seq ${approvedAt.get(n)})` });
      else approvedAt.set(n, e.seq);
      return;
    }
    if (e.event !== 'receipt-consumed') return;
    const nonce = e.data?.nonce;
    const outcome = e.data?.outcome;
    if (typeof nonce !== 'string') return void problems.push({ line, reason: 'a receipt-consumed line does not name a nonce' });
    if (!['claimed', 'succeeded', 'failed'].includes(outcome)) return void problems.push({ line, reason: outcome === undefined ? `missing outcome for nonce ${shown(nonce)}` : `unknown outcome ${shown(outcome)} for nonce ${shown(nonce)}` });
    if (!approvedAt.has(nonce)) {
      const reason = readEvents(ledgerDir).some((x) => isObject(x) && x.event === 'approved' && x.data?.receipt?.nonce === nonce)
        ? `nonce ${shown(nonce)} was consumed before its receipt was approved`
        : `no receipt with nonce ${shown(nonce)} exists in the ledger`;
      problems.push({ line, reason });
      return;
    }
    const s = state.get(nonce) ?? { claimed: false, final: false };
    if (s.final) problems.push({ line, reason: outcome === 'claimed' ? `nonce ${shown(nonce)} was claimed after its final outcome` : `nonce ${shown(nonce)} has more than one final outcome (an outcome is already recorded)` });
    else if (outcome === 'claimed') {
      if (s.claimed) problems.push({ line, reason: `nonce ${shown(nonce)} was claimed more than once` });
      s.claimed = true;
    } else s.final = true;
    state.set(nonce, s);
  });
  return problems;
}
