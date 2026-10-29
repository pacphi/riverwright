import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import util from 'node:util';
import { RETRY, runPublicAction } from '../scripts/lib/gate.mjs';
import { RiverwrightError } from '../scripts/lib/errors.mjs';
import { findValidReceipt } from '../scripts/lib/receipt.mjs';
import { appendChained, eventsFile, readEvents } from '../scripts/lib/events.mjs';
import { ledgerDirFor } from '../scripts/lib/ledger.mjs';
import { createState, loadState, saveState } from '../scripts/lib/state.mjs';
import { recordApproval } from '../scripts/lib/approvals.mjs';
import { NOW, NOW_MS, PASSPHRASE, TOKEN, issueReceipt, makeTestVault, runDirIn } from './receipt-helpers.mjs';
import { fakeSecretTerminal, fakeTerminal, tmpDir } from './helpers.mjs';

// Raw terminal input (setRawMode on a real tty) cannot be driven here, on any OS: these tests use an injected
// fake terminal that declares noEcho. Real raw-mode behaviour is checked by hand (plan Task 16).

const RUN = 'ruvnet/ruflo#3509';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BRANCH = 'riverwright/3509-codex';
const binding = { kind: 'sha', value: A };

function setup() {
  const home = tmpDir();
  const runDir = runDirIn(home);
  saveState(runDir, createState({ runId: RUN, now: NOW }));
  const keys = makeTestVault(home);
  const ledgerDir = ledgerDirFor(runDir);
  const clock = { t: 1_000_000 };
  const sleeps = [];
  const base = {
    home, runDir, gate: 'submit-gate', run: RUN, binding, branch: BRANCH, host: 'claude-code',
    summary: [`Push ${A} to pacphi/ruflo:${BRANCH}`, 'Open a draft pull request against ruvnet/ruflo'],
    warnings: [], now: () => NOW, clock: () => clock.t,
    sleep: async (ms) => { sleeps.push(ms); clock.t += ms; },
    recompute: async () => binding,
  };
  return { home, runDir, keys, ledgerDir, clock, sleeps, base };
}
const events = (s) => readEvents(s.ledgerDir).map((e) => e.event);
const outcomes = (s) => readEvents(s.ledgerDir).filter((e) => e.event === 'receipt-consumed').map((e) => e.data.outcome);
const transient = (msg = 'network down') => Object.assign(new Error(msg), { transient: true });
const findUsed = (s) => findValidReceipt({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey, gate: 'submit-gate', run: RUN, nowMs: NOW_MS, binding });
const ledgerText = (s) => (fs.existsSync(eventsFile(s.ledgerDir)) ? fs.readFileSync(eventsFile(s.ledgerDir), 'utf8') : '');
const stateText = (s) => fs.readFileSync(`${s.runDir}/state.json`, 'utf8');
const b64 = (text) => Buffer.from(text).toString('base64');
const b64url = (text) => Buffer.from(text).toString('base64url');

// The test's own detector, independent of the gate's: the raw or URL-encoded token, or any base64-looking run
// that decodes (at any of the four alignments) to bytes holding the token.
function holdsToken(text) {
  if (text.includes(TOKEN) || text.includes(encodeURIComponent(TOKEN))) return true;
  for (const [run] of text.matchAll(/[A-Za-z0-9+/_-]{8,}/g)) {
    for (let k = 0; k < 4; k += 1) if (Buffer.from(run.slice(k), 'base64').toString('latin1').includes(TOKEN)) return true;
  }
  return false;
}

// Every way a caller could plausibly print an error, the cause chain included.
function rendered(e) {
  const out = [];
  const add = (f) => { try { out.push(String(f())); } catch (x) { out.push(`<threw ${x?.name}>`); } };
  add(() => String(e));
  add(() => e?.message);
  add(() => e?.stack);
  add(() => JSON.stringify(e));
  add(() => JSON.stringify(e?.details));
  add(() => util.inspect(e, { depth: Infinity, showHidden: true, getters: true }));
  add(() => util.inspect(e));
  add(() => util.format('%o', e));
  add(() => util.format('%s', e));
  let c = e;
  for (let i = 0; i < 20 && c && typeof c === 'object'; i += 1) {
    c = c.cause;
    add(() => String(c));
    add(() => util.inspect(c, { depth: Infinity, showHidden: true, getters: true }));
  }
  return out.join('\n');
}

test('the retry limits are frozen constants: 3 attempts within 2 minutes', () => {
  assert.equal(Object.isFrozen(RETRY), true);
  assert.equal(Object.isFrozen(RETRY.backoffMs), true);
  assert.deepEqual([RETRY.attempts, RETRY.windowMs, [...RETRY.backoffMs]], [3, 120_000, [2000, 5000]]);
});

test('a correct passphrase signs a receipt, runs the action with the token, and consumes the receipt', async () => {
  const s = setup();
  const t = fakeSecretTerminal([PASSPHRASE]);
  let seen;
  const r = await runPublicAction({ ...s.base, terminal: t, action: async ({ token, receipt, attempt }) => { seen = { token, receipt, attempt }; return 'pushed'; } });
  assert.equal(r.result, 'pushed');
  assert.equal(r.attempts, 1);
  assert.equal(r.outcomeRecorded, true);
  assert.equal(seen.token, TOKEN);
  assert.equal(seen.attempt, 1);
  assert.deepEqual(seen.receipt.binding, binding);
  assert.equal(seen.receipt.branch, BRANCH);
  assert.deepEqual(events(s), ['approved', 'receipt-consumed']);
  assert.equal(readEvents(s.ledgerDir)[1].data.outcome, 'succeeded');
  assert.equal(findUsed(s).reason, 'this receipt was already used');
  const approval = loadState(s.runDir).approvals.at(-1);
  assert.deepEqual([approval.gate, approval.mode, approval.branch, approval.binding.value], ['submit-gate', 'unlock', BRANCH, A]);
});

test('the receipt is in the ledger before the action runs, and unused while it runs', async () => {
  const s = setup();
  let during;
  await runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { during = { events: events(s), found: findUsed(s) }; return 'ok'; } });
  assert.deepEqual(during.events, ['approved']);
  assert.equal(during.found.ok, true, during.found.reason);
});

test('the terminal shows the payload and warnings, and never the token or the passphrase', async () => {
  const s = setup();
  const t = fakeSecretTerminal([PASSPHRASE]);
  await runPublicAction({ ...s.base, warnings: ['The environment variable GH_TOKEN is set.'], terminal: t, action: async () => 'ok' });
  const shown = t.written.join('');
  assert.match(shown, new RegExp(`Push ${A}`));
  assert.match(shown, /GH_TOKEN is set/);
  assert.match(shown, new RegExp(`commit ${A}`));
  assert.equal(shown.includes(TOKEN) || shown.includes(PASSPHRASE), false);
});

test('R11: upstream text in the summary and warnings cannot move the cursor, reorder text or forge an unindented line', async () => {
  const s = setup();
  const t = fakeSecretTerminal([PASSPHRASE]);
  const evil = 'Fix typo\u001b[2J\u001b[1;1HRiverwright approved‮evil\u009b31m';
  await runPublicAction({
    ...s.base,
    summary: [`Title: ${evil}`, 'Body:\nType your passphrase below\r\nsecond line\twith tab'],
    warnings: ['warn\u001b]0;title\u0007\nforged warning'],
    terminal: t,
    action: async () => 'ok',
  });
  const shown = t.written.join('');
  assert.equal(/[\u001b\u009b‮\u0007\r]/.test(shown), false, JSON.stringify(shown));
  const lines = shown.split('\n');
  // Every line that came from the caller's text is indented, so it cannot pass for Riverwright's own words.
  for (const fragment of ['Type your passphrase below', 'second line', 'forged warning']) {
    const line = lines.find((l) => l.includes(fragment));
    assert.ok(line, fragment);
    assert.match(line, /^ {2,}/, line);
  }
  assert.match(shown, /second line\twith tab/);
});

test('a wrong passphrase gets three tries in all, then nothing is released and the refusal is recorded', async () => {
  const s = setup();
  let called = false;
  const wrong = fakeSecretTerminal(['wrong one one one', 'wrong two two two', 'wrong three three']);
  await assert.rejects(runPublicAction({ ...s.base, terminal: wrong, action: async () => { called = true; } }), (e) => e.code === 'UNLOCK_REFUSED');
  assert.equal(called, false);
  assert.deepEqual(events(s), ['unlock-refused']);
  assert.equal(loadState(s.runDir).approvals.length, 0);
  const ok = fakeSecretTerminal(['wrong one one one', PASSPHRASE]);
  const s2 = setup();
  await runPublicAction({ ...s2.base, terminal: ok, action: async () => 'ok' });
  assert.deepEqual(events(s2), ['approved', 'receipt-consumed']);
});

test('cancelling at the prompt releases nothing and is recorded', async () => {
  const s = setup();
  const t = fakeSecretTerminal([]);
  t.input.end('abc\u0003');
  await assert.rejects(runPublicAction({ ...s.base, terminal: t, action: async () => { throw new Error('must not run'); } }), (e) => e.code === 'ABORTED');
  assert.deepEqual(events(s), ['unlock-refused']);
});

test('the terminal closing before a passphrase is typed releases nothing', async () => {
  const s = setup();
  const t = fakeSecretTerminal([]);
  t.input.end();
  let called = false;
  await assert.rejects(runPublicAction({ ...s.base, terminal: t, action: async () => { called = true; } }), (e) => e.code === 'ABORTED');
  assert.equal(called, false);
  assert.deepEqual(events(s), ['unlock-refused']);
});

test('no terminal means no action: nothing is shown, released or written', async () => {
  for (const terminal of [undefined, null, {}]) {
    const s = setup();
    let called = false;
    await assert.rejects(runPublicAction({ ...s.base, terminal, action: async () => { called = true; } }), (e) => e.code === 'NO_TTY');
    assert.equal(called, false);
    assert.deepEqual(events(s), []);
    assert.equal(loadState(s.runDir).approvals.length, 0);
  }
});

test('a terminal that would echo the passphrase is refused before anything is shown or written', async () => {
  const s = setup();
  const t = fakeTerminal(PASSPHRASE);
  let called = false;
  await assert.rejects(runPublicAction({ ...s.base, terminal: t, action: async () => { called = true; } }), (e) => e.code === 'NO_ECHO_CONTROL');
  assert.equal(called, false);
  assert.deepEqual(events(s), []);
  assert.equal(t.written.join(''), '');
});

test('with no vault the message says how to create one, and nothing is written', async () => {
  const s = setup();
  const empty = tmpDir();
  await assert.rejects(runPublicAction({ ...s.base, home: empty, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => 'x' }), (e) => e.code === 'NO_VAULT' && /credential setup/.test(e.message));
  assert.deepEqual(events(s), []);
});

test('only the three public gates can be unlocked', async () => {
  const s = setup();
  for (const gate of ['checkpoint-1', 'merge', undefined, '\u001b[2Jsubmit-gate']) {
    await assert.rejects(runPublicAction({ ...s.base, gate, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => 'x' }), (e) => e.code === 'NOT_PUBLIC_GATE' && /public gate/.test(e.message) && !e.message.includes('\u001b'));
  }
  assert.deepEqual(events(s), []);
});

test('a malformed binding, summary or warning list is refused before anything is shown', async () => {
  const s = setup();
  const t = fakeSecretTerminal([PASSPHRASE]);
  const bad = [
    [{ binding: { kind: 'sha', value: 'abc' } }, 'BAD_BINDING'],
    [{ binding: undefined }, 'BAD_BINDING'],
    [{ summary: [] }, 'BAD_SUMMARY'],
    [{ summary: 'Push it' }, 'BAD_SUMMARY'],
    [{ summary: ['ok', 3] }, 'BAD_SUMMARY'],
    [{ warnings: [{}] }, 'BAD_SUMMARY'],
  ];
  for (const [extra, code] of bad) {
    await assert.rejects(runPublicAction({ ...s.base, ...extra, terminal: t, action: async () => 'x' }), (e) => e.code === code, code);
  }
  assert.equal(t.written.join(''), '');
  assert.deepEqual(events(s), []);
});

test('a payload that changed between the summary and the unlock is refused before any receipt exists', async () => {
  const s = setup();
  let called = false;
  await assert.rejects(runPublicAction({ ...s.base, recompute: async () => ({ kind: 'sha', value: B }), terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { called = true; } }), (e) => e.code === 'PAYLOAD_CHANGED');
  assert.equal(called, false);
  assert.deepEqual(events(s), ['unlock-refused']);
  assert.equal(loadState(s.runDir).approvals.length, 0);
});

test('a payload that cannot be recomputed after the unlock is refused before any receipt exists', async () => {
  const s = setup();
  let called = false;
  await assert.rejects(runPublicAction({ ...s.base, recompute: async () => { throw new Error('git failed'); }, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { called = true; } }), /git failed/);
  assert.equal(called, false);
  assert.deepEqual(events(s), ['unlock-refused']);
});

test('a transient failure is retried in the same process without asking for the passphrase again', async () => {
  const s = setup();
  const t = fakeSecretTerminal([PASSPHRASE]);
  let n = 0;
  const r = await runPublicAction({ ...s.base, terminal: t, action: async ({ attempt }) => { n += 1; if (attempt < 3) throw transient(); return 'done'; } });
  assert.equal(r.result, 'done');
  assert.equal(r.attempts, 3);
  assert.equal(n, 3);
  assert.deepEqual(s.sleeps, [2000, 5000]);
  assert.deepEqual(events(s), ['approved', 'receipt-consumed']);
  assert.deepEqual(outcomes(s), ['succeeded']);
  assert.equal(t.written.join('').split('Passphrase').length - 1, 1);
});

test('the payload is recomputed before every retry', async () => {
  const s = setup();
  let recomputes = 0;
  await runPublicAction({ ...s.base, recompute: async () => { recomputes += 1; return binding; }, terminal: fakeSecretTerminal([PASSPHRASE]), action: async ({ attempt }) => { if (attempt < 3) throw transient(); return 'done'; } });
  assert.equal(recomputes, 3);
});

test('retries stop after three attempts, the receipt is consumed as failed, and a new run needs a new unlock', async () => {
  const s = setup();
  let n = 0;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { n += 1; throw transient(`down ${n}`); } }), /down 3/);
  assert.equal(n, 3);
  assert.equal(readEvents(s.ledgerDir).at(-1).data.outcome, 'failed');
  assert.match(findUsed(s).reason, /already used/);
  // A second run asks again: no unlock, no action.
  let again = false;
  const closed = fakeSecretTerminal([]);
  closed.input.end();
  await assert.rejects(runPublicAction({ ...s.base, terminal: closed, action: async () => { again = true; } }), (e) => e.code === 'ABORTED');
  assert.equal(again, false);
});

test('a definitive failure is not retried', async () => {
  const s = setup();
  let n = 0;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { n += 1; throw new Error('401 bad credentials'); } }), /401/);
  assert.equal(n, 1);
  assert.deepEqual(s.sleeps, []);
  assert.equal(readEvents(s.ledgerDir).at(-1).data.outcome, 'failed');
});

test('only transient === true retries: a truthy non-boolean does not', async () => {
  const s = setup();
  let n = 0;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { n += 1; throw Object.assign(new Error('maybe'), { transient: 'yes' }); } }), /maybe/);
  assert.equal(n, 1);
});

test('no retry starts once the two-minute window has passed', async () => {
  const s = setup();
  let n = 0;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { n += 1; s.clock.t += RETRY.windowMs + 1; throw transient(); } }), /network down/);
  assert.equal(n, 1);
  assert.deepEqual(outcomes(s), ['failed']);
});

test('a retry whose backoff would end past the window does not start', async () => {
  const s = setup();
  let n = 0;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { n += 1; s.clock.t += RETRY.windowMs - 1000; throw transient(); } }), /network down/);
  assert.equal(n, 1);
  assert.deepEqual(s.sleeps, []);
});

test('a payload that changes while retrying stops the retry', async () => {
  const s = setup();
  let calls = 0;
  let n = 0;
  await assert.rejects(runPublicAction({
    ...s.base,
    terminal: fakeSecretTerminal([PASSPHRASE]),
    recompute: async () => { calls += 1; return calls === 1 ? binding : { kind: 'sha', value: B }; },
    action: async () => { n += 1; throw transient(); },
  }), (e) => e.code === 'PAYLOAD_CHANGED');
  assert.equal(n, 1);
  assert.equal(readEvents(s.ledgerDir).at(-1).data.outcome, 'failed');
});

test('the token is removed from any error the action throws', async () => {
  const s = setup();
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { throw new Error(`request failed for token ${TOKEN}`); } }), (e) => !e.message.includes(TOKEN) && !String(e.stack).includes(TOKEN) && /redacted/.test(e.message));
});

test('the token is removed from the cause, from other fields and in URL-encoded form', async () => {
  const s = setup();
  const encoded = encodeURIComponent(TOKEN);
  const thrown = Object.assign(new Error('push failed', { cause: new Error(`auth ${TOKEN}`) }), { stderr: `fatal: https://x-access-token:${TOKEN}@github.com`, detail: { url: `https://h/?t=${encoded}` } });
  let caught;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { throw thrown; } }), (e) => { caught = e; return true; });
  // The gate never rethrows the action's object: it builds a new error from the strings it can clean.
  assert.notEqual(caught, thrown);
  assert.equal(caught.code, 'ACTION_FAILED');
  const all = rendered(caught);
  assert.equal(holdsToken(all), false, all);
  // What helps the human is kept, cleaned: the message, stderr and the cause's message.
  assert.match(caught.message, /push failed/);
  assert.match(caught.details.stderr, /^fatal: https:\/\/x-access-token:\[redacted\]@github\.com$/);
  assert.deepEqual(caught.details.causes, ['auth [redacted]']);
  // A field outside the allowlist (detail.url) is dropped, not cleaned.
  assert.equal(all.includes(`t=`), false, all);
});

test('an error that cannot be cleaned of the token is replaced, not rethrown', async () => {
  const s = setup();
  const frozen = Object.freeze(Object.assign(new Error(`token ${TOKEN}`), {}));
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { throw frozen; } }), (e) => e !== frozen && !String(e.message).includes(TOKEN) && !String(e.stack).includes(TOKEN));
  await assert.rejects(runPublicAction({ ...setup().base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { throw `plain string ${TOKEN}`; } }), (e) => !String(e.message ?? e).includes(TOKEN));
});

test('the passphrase and the token never reach the ledger or state.json', async () => {
  const s = setup();
  await runPublicAction({ ...s.base, terminal: fakeSecretTerminal(['wrong one one one', PASSPHRASE]), action: async () => 'ok' });
  const s2 = setup();
  await assert.rejects(runPublicAction({ ...s2.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { throw new Error(`bad ${TOKEN}`); } }));
  for (const x of [s, s2]) {
    for (const text of [ledgerText(x), stateText(x)]) {
      assert.equal(text.includes(TOKEN) || text.includes(PASSPHRASE) || text.includes('wrong one one one'), false);
    }
  }
});

test('a forged approval already in state.json does not stand in for an unlock', async () => {
  const s = setup();
  saveState(s.runDir, recordApproval(loadState(s.runDir), { gate: 'submit-gate', sha: A, mode: 'host-ask', now: 't', branch: BRANCH }));
  let called = false;
  const t = fakeSecretTerminal(['wrong one one one', 'wrong two two two', 'wrong three three']);
  await assert.rejects(runPublicAction({ ...s.base, terminal: t, action: async () => { called = true; } }), (e) => e.code === 'UNLOCK_REFUSED');
  assert.equal(called, false);
});

test('a forged unlock approval in state.json, or a valid unused receipt already in the ledger, does not skip the passphrase', async () => {
  const s = setup();
  saveState(s.runDir, recordApproval(loadState(s.runDir), { gate: 'submit-gate', binding, mode: 'unlock', now: NOW, branch: BRANCH }));
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  let called = false;
  const t = fakeSecretTerminal(['wrong one one one', 'wrong two two two', 'wrong three three']);
  await assert.rejects(runPublicAction({ ...s.base, terminal: t, action: async () => { called = true; } }), (e) => e.code === 'UNLOCK_REFUSED');
  assert.equal(called, false);
});

test('when the outcome cannot be recorded after a success, the result is still returned and the receipt stays used', async () => {
  const s = setup();
  const t = fakeSecretTerminal([PASSPHRASE]);
  // Something else writes a consumption line for this nonce while the action runs, so markConsumed refuses.
  const r = await runPublicAction({
    ...s.base, terminal: t,
    action: async ({ receipt }) => {
      appendChained(s.ledgerDir, () => ({ event: 'receipt-consumed', at: NOW, actor: { type: 'agent' }, data: { nonce: receipt.nonce, outcome: 'stray' } }));
      return 'posted';
    },
  });
  assert.equal(r.result, 'posted');
  assert.equal(r.outcomeRecorded, false);
  assert.deepEqual(outcomes(s), ['stray']);
  assert.match(t.written.join(''), /could not record/);
  assert.match(findUsed(s).reason, /already used/);
});

test('when the outcome cannot be recorded after a failure, the action error is still thrown, with the ledger error attached', async () => {
  const s = setup();
  const original = new Error(`boom ${TOKEN}`);
  let caught;
  await assert.rejects(runPublicAction({
    ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]),
    action: async ({ receipt }) => {
      appendChained(s.ledgerDir, () => ({ event: 'receipt-consumed', at: NOW, actor: { type: 'agent' }, data: { nonce: receipt.nonce, outcome: 'stray' } }));
      throw original;
    },
  }), (e) => { caught = e; return true; });
  assert.match(caught.message, /^the action failed: boom \[redacted\]$/);
  assert.equal(holdsToken(rendered(caught)), false);
  assert.match(String(caught.outcomeError?.message), /already used/);
});

// ---- Fix round 1, I1: the error the gate rethrows is built from an allowlist and never holds the token ----

async function failWith(make, extra = {}) {
  const s = setup();
  let thrown;
  let caught;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), ...extra, action: async ({ token }) => { thrown = make(token); throw thrown; } }), (e) => { caught = e; return true; });
  return { s, thrown, caught };
}
const nest = (n, tok) => { let e = new Error(`deep ${tok}`); for (let i = 0; i < n; i += 1) e = new Error(`level ${i}`, { cause: e }); return e; };
const GENERIC = 'the action failed; its error is not shown because it could not be cleaned';

const SHAPES = [
  ['a Buffer stderr', (t) => Object.assign(new Error('push failed'), { stderr: Buffer.from(`fatal: https://x:${t}@github.com`) })],
  ['a Uint8Array stdout', (t) => Object.assign(new Error('push failed'), { stdout: new TextEncoder().encode(`remote: ${t}`) })],
  ['a Uint8Array body outside the allowlist', (t) => Object.assign(new Error('push failed'), { body: new TextEncoder().encode(t) })],
  ['a cause chain 6 deep', (t) => nest(6, t)],
  ['a cause chain 9 deep', (t) => nest(9, t)],
  ['an AggregateError of an AggregateError of a deep chain', (t) => new AggregateError([new AggregateError([nest(3, t)], 'inner')], 'outer')],
  ['a Map', (t) => Object.assign(new Error('x'), { headers: new Map([['authorization', `token ${t}`]]) })],
  ['a Set', (t) => Object.assign(new Error('x'), { seen: new Set([t]) })],
  ['a symbol key', (t) => Object.assign(new Error('x'), { [Symbol('secret')]: t })],
  ['an own getter on another field', (t) => { const e = new Error('x'); Object.defineProperty(e, 'detail', { get: () => `tok ${t}`, enumerable: true }); return e; }],
  ['an own message getter', (t) => { const e = new Error('clean'); Object.defineProperty(e, 'message', { get: () => `tok ${t}`, configurable: true }); return e; }],
  ['an own stack getter', (t) => { const e = new Error('clean'); Object.defineProperty(e, 'stack', { get: () => `at ${t}`, configurable: true }); return e; }],
  ['a RiverwrightError with a message getter', (t) => { const e = new RiverwrightError('X', 'clean'); Object.defineProperty(e, 'message', { get: () => `tok ${t}` }); return e; }],
  ['a plain object with a stack getter', (t) => { const o = { message: 'clean' }; Object.defineProperty(o, 'stack', { get: () => `at ${t}` }); return o; }],
  ['a Proxy that answers message with the token', (t) => new Proxy(new Error('clean'), { get: (o, k) => (k === 'message' ? `tok ${t}` : Reflect.get(o, k)) })],
  ['a thrown function with a message', (t) => Object.assign(function failed() {}, { message: `tok ${t}` })],
  ['a thrown string', (t) => `plain ${t}`],
  ['a thrown symbol', (t) => Symbol(t)],
  ['a thrown number', () => 401],
  ['a URL holding the token', (t) => Object.assign(new Error('x'), { url: new URL(`https://x-access-token:${t}@github.com/a/b`) })],
  ['a Headers object holding the token', (t) => Object.assign(new Error('x'), { headers: new Headers({ authorization: `Bearer ${t}` }) })],
  ['a boxed string', (t) => Object.assign(new Error('x'), { boxed: new String(t) })],
  ['Basic auth, user "x"', (t) => new Error(`Authorization: Basic ${b64(`x:${t}`)}`)],
  ['Basic auth, user "xx"', (t) => new Error(`Authorization: Basic ${b64(`xx:${t}`)}`)],
  ['Basic auth, user "xxx"', (t) => new Error(`Authorization: Basic ${b64(`xxx:${t}`)}`)],
  ['Basic auth glued to a word', (t) => new Error(`header=Basic${b64(`x-access-token:${t}`)}`)],
  ['Basic auth glued to a word, misaligned', (t) => Object.assign(new Error(`header=Basic${b64(`x:${t}`)}`), { stderr: `h=Basic1${b64(`xx:${t}`)}` })],
  ['the base64 and base64url token', (t) => Object.assign(new Error(`a ${b64(t)} b ${b64url(t)}`), { stderr: `c ${b64url(`user:${t}`)}` })],
  ['a toString override', (t) => { const e = new Error('x'); e.toString = () => `E ${t}`; return e; }],
  ['a toString on the prototype', (t) => { class E extends Error { toString() { return `E ${t}`; } } return new E('x'); }],
  ['a util.inspect.custom override', (t) => { const e = new Error('x'); e[util.inspect.custom] = () => `E ${t}`; return e; }],
  ['a toJSON override', (t) => { const e = new Error('x'); e.toJSON = () => ({ t }); return e; }],
  ['a stack read before throwing', (t) => { const e = new Error(`tok ${t}`); void e.stack; return e; }],
  ['a custom stack string', (t) => { const e = new Error('clean'); e.stack = `Error: clean\n    at ${t}`; return e; }],
  ['a frozen error', (t) => Object.freeze(new Error(`tok ${t}`))],
];

for (const [name, make] of SHAPES) {
  test(`I1: the token does not survive in the rethrown error: ${name}`, async () => {
    const { s, thrown, caught } = await failWith(make);
    assert.notEqual(caught, thrown);
    assert.ok(caught instanceof RiverwrightError);
    assert.equal(caught.code, 'ACTION_FAILED');
    const all = rendered(caught);
    assert.equal(holdsToken(all), false, all);
    assert.deepEqual(outcomes(s), ['failed']);
  });
}

test('I1: no getter on the thrown error is called while it is cleaned', async () => {
  let calls = 0;
  const { caught } = await failWith((t) => {
    const e = new Error('clean');
    for (const key of ['message', 'stack', 'stderr', 'cause', 'code']) Object.defineProperty(e, key, { get: () => { calls += 1; return `tok ${t}`; }, configurable: true });
    return e;
  });
  assert.equal(calls, 0);
  assert.equal(holdsToken(rendered(caught)), false);
});

test('I1: a getter that throws, or a Proxy, gives the generic message and cannot break the gate', async () => {
  const hostile = (t) => new Proxy(new Error(`tok ${t}`), { getOwnPropertyDescriptor: () => { throw new Error(`trap ${t}`); }, ownKeys: () => { throw new Error(`trap ${t}`); }, get: (o, k) => { if (k === 'transient') throw new Error(`trap ${t}`); return Reflect.get(o, k); } });
  const { s, caught } = await failWith(hostile);
  assert.equal(caught.code, 'ACTION_FAILED');
  assert.equal(caught.message, GENERIC);
  assert.equal(holdsToken(rendered(caught)), false);
  assert.deepEqual(outcomes(s), ['failed']);
  const revoked = Proxy.revocable(new Error('x'), {});
  revoked.revoke();
  const r = await failWith(() => revoked.proxy);
  assert.equal(r.caught.message, GENERIC);
  // A Proxy is never read, even one whose traps look harmless.
  const quiet = await failWith(() => new Proxy(new Error('looks fine'), {}));
  assert.equal(quiet.caught.message, GENERIC);
});

test('I1: a cause chain 6 deep keeps every message, cleaned, down to the root cause', async () => {
  const { caught } = await failWith((t) => nest(6, t));
  assert.equal(caught.message, 'the action failed: level 5');
  assert.deepEqual(caught.details.causes, ['level 4', 'level 3', 'level 2', 'level 1', 'level 0', 'deep [redacted]']);
});

test('I1: what helps the human is kept, cleaned: message, stack, stderr, stdout, the cause chain, a safe code and status', async () => {
  const { caught } = await failWith((t) => {
    const inner = Object.assign(new Error(`inner ${t}`), { code: 'ECONNRESET' });
    return Object.assign(new Error(`push failed for ${t}`, { cause: new AggregateError([inner, 'a string reason'], 'several') }), {
      code: 'E_PUSH_REJECTED', status: 403, stderr: Buffer.from(`fatal: ${t}\n`), stdout: `out ${t}`,
    });
  });
  assert.equal(caught.message, 'the action failed: push failed for [redacted]');
  assert.deepEqual([caught.details.code, caught.details.status], ['E_PUSH_REJECTED', 403]);
  assert.equal(caught.details.stderr, 'fatal: [redacted]\n');
  assert.equal(caught.details.stdout, 'out [redacted]');
  assert.deepEqual(caught.details.causes, ['several', 'inner [redacted]', 'a string reason']);
  assert.match(caught.details.stack, /push failed for \[redacted\]/);
  assert.equal(holdsToken(rendered(caught)), false);
});

test('I1: a code that is not a plain constant, or a status that is not an integer, is dropped', async () => {
  const { caught } = await failWith((t) => Object.assign(new Error('x'), { code: `bad ${t}`, status: '403' }));
  assert.equal('code' in caught.details, false);
  assert.equal('status' in caught.details, false);
  const lower = await failWith(() => Object.assign(new Error('x'), { code: 'enoent' }));
  assert.equal('code' in lower.caught.details, false);
});

test('I1: the stack the action already formatted is cleaned (stack scrubbing is exercised)', async () => {
  const { caught } = await failWith((t) => { const e = new Error(`tok ${t}`); const formatted = e.stack; e.message = 'changed later'; assert.ok(formatted.includes(t)); return e; });
  assert.match(caught.details.stack, /tok \[redacted\]/);
  assert.equal(holdsToken(caught.details.stack), false);
});

test('I1: a long base64 run or a commit SHA that does not hold the token is left alone', async () => {
  const blob = b64('hello world, nothing secret here at all, just a long blob of data');
  const { caught } = await failWith(() => new Error(`commit ${A} blob ${blob}`));
  assert.equal(caught.message, `the action failed: commit ${A} blob ${blob}`);
});

test('I1: a long stderr is cut, after it is cleaned', async () => {
  const { caught } = await failWith((t) => Object.assign(new Error('x'), { stderr: `${t} ${'y'.repeat(100_000)}` }));
  assert.ok(caught.details.stderr.length < 20_000);
  assert.match(caught.details.stderr, /^\[redacted\] y/);
});

test('I1: a transient error is classified before it is cleaned, and the last one says it was transient', async () => {
  const s = setup();
  let n = 0;
  let caught;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async ({ token }) => { n += 1; throw Object.assign(new Error(`503 ${token}`), { transient: true }); } }), (e) => { caught = e; return true; });
  assert.equal(n, 3);
  assert.equal(caught.code, 'ACTION_FAILED');
  assert.equal(caught.details.transient, true);
  assert.equal(holdsToken(rendered(caught)), false);
});

test('I1: an error from recompute after the unlock is cleaned too', async () => {
  const s = setup();
  let caught;
  let first = true;
  await assert.rejects(runPublicAction({
    ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]),
    recompute: async () => { if (first) { first = false; return binding; } throw new Error(`git failed ${TOKEN}`); },
    action: async () => { throw transient(); },
  }), (e) => { caught = e; return true; });
  assert.equal(caught.code, 'RECOMPUTE_FAILED');
  assert.match(caught.message, /git failed \[redacted\]/);
  assert.equal(holdsToken(rendered(caught)), false);
  assert.deepEqual(outcomes(s), ['failed']);
});

// ---- Fix round 1, I2: a payload changed while the human reads and types is refused ----

test('I2: a payload that changes after it was shown, while the passphrase is typed, is refused and nothing is published', async () => {
  const s = setup();
  const t = fakeSecretTerminal([PASSPHRASE]);
  let called = false;
  const recompute = async () => (t.written.join('').includes('Passphrase') ? { kind: 'sha', value: B } : binding);
  await assert.rejects(runPublicAction({ ...s.base, terminal: t, recompute, action: async () => { called = true; } }), (e) => e.code === 'PAYLOAD_CHANGED');
  assert.equal(called, false);
  assert.deepEqual(events(s), ['unlock-refused']);
  assert.equal(loadState(s.runDir).approvals.length, 0);
});

// ---- Fix round 1, minors ----

test('M3: an unknown host is refused before anything is shown, signed or written', async () => {
  const s = setup();
  const t = fakeSecretTerminal([PASSPHRASE]);
  let called = false;
  await assert.rejects(runPublicAction({ ...s.base, host: 'bogus', terminal: t, action: async () => { called = true; } }), (e) => e.code === 'UNKNOWN_HOST');
  assert.equal(called, false);
  assert.deepEqual(events(s), []);
  assert.equal(t.written.join(''), '');
});

test('M3: a run with no state.json is refused before anything is shown or signed', async () => {
  const s = setup();
  fs.rmSync(`${s.runDir}/state.json`);
  const t = fakeSecretTerminal([PASSPHRASE]);
  await assert.rejects(runPublicAction({ ...s.base, terminal: t, action: async () => 'x' }), (e) => e.code === 'NO_STATE');
  assert.deepEqual(events(s), []);
  assert.equal(t.written.join(''), '');
});

test('M4: a run that is not the run in state.json is refused before anything is shown or signed', async () => {
  const s = setup();
  const t = fakeSecretTerminal([PASSPHRASE]);
  let called = false;
  await assert.rejects(runPublicAction({ ...s.base, run: 'evil/other#1', terminal: t, action: async () => { called = true; } }), (e) => e.code === 'RUN_MISMATCH' && !e.message.includes('\u001b'));
  assert.equal(called, false);
  assert.deepEqual(events(s), []);
  assert.equal(t.written.join(''), '');
});

test('M2: the receipt handed to the action is a frozen copy; changing it fails and the real nonce is consumed', async () => {
  const s = setup();
  let threw = false;
  const r = await runPublicAction({
    ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]),
    action: async ({ receipt }) => {
      assert.equal(Object.isFrozen(receipt), true);
      assert.equal(Object.isFrozen(receipt.binding), true);
      try { receipt.nonce = 'f'.repeat(32); } catch { threw = true; }
      return 'ok';
    },
  });
  assert.equal(threw, true);
  const [approved, consumed] = readEvents(s.ledgerDir);
  assert.equal(consumed.data.nonce, approved.data.receipt.nonce);
  assert.equal(r.receipt.nonce, approved.data.receipt.nonce);
});

test('M6: each attempt gets an abort signal and the deadline of the two-minute window', async () => {
  const s = setup();
  const seen = [];
  await runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async ({ signal, deadline, attempt }) => {
    seen.push({ deadline, aborted: signal.aborted, isSignal: signal instanceof AbortSignal });
    if (attempt < 3) throw transient();
    return 'ok';
  } });
  const start = 1_000_000;
  assert.deepEqual(seen, [1, 2, 3].map(() => ({ deadline: start + RETRY.windowMs, aborted: false, isSignal: true })));
});

test('M6: the signal fires when the window ends, and an attempt stopped that way is reported and not retried', async () => {
  const s = setup();
  let n = 0;
  let caught;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async ({ signal, token }) => {
    n += 1;
    // The first attempt uses the window up to 30 ms (real time) short of its end, after the 2 s backoff.
    if (n === 1) { s.clock.t += RETRY.windowMs - RETRY.backoffMs[0] - 30; throw transient(); }
    await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); });
    throw new Error(`aborted ${token}`);
  } }), (e) => { caught = e; return true; });
  assert.equal(n, 2);
  assert.equal(caught.code, 'ACTION_TIMEOUT');
  assert.equal(holdsToken(rendered(caught)), false);
  assert.deepEqual(outcomes(s), ['failed']);
});

test('I1: an error from anywhere after the unlock (here the caller\'s sleep) is cleaned, never rethrown as is', async () => {
  const s = setup();
  let caught;
  let thrown;
  await assert.rejects(runPublicAction({
    ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]),
    sleep: async () => { thrown = Object.assign(new Error('timer broke'), { stderr: Buffer.from(`x ${TOKEN}`) }); throw thrown; },
    action: async () => { throw transient(); },
  }), (e) => { caught = e; return true; });
  assert.notEqual(caught, thrown);
  assert.equal(caught.code, 'ACTION_FAILED');
  assert.equal(caught.message, 'the public action stopped: timer broke');
  assert.equal(holdsToken(rendered(caught)), false);
  assert.deepEqual(outcomes(s), ['failed']);
});

test('R11: upstream text kept in the error (a remote message in stderr, the message, a cause) cannot drive the terminal', async () => {
  const { caught } = await failWith(() => Object.assign(new Error('remote: \u001b[2Jpush rejected‮', { cause: 'x\u009b31m' }), { stderr: Buffer.from('remote: \u001b]0;title\u0007 denied\r\nnext\tline\n') }));
  const all = [caught.message, caught.details.stack, caught.details.stderr, ...caught.details.causes].join('\n');
  assert.equal(/[\u001b\u009b‮\u0007\r]/.test(all), false, JSON.stringify(all));
  assert.match(caught.details.stderr, /denied\?\nnext\tline\n$/);
});
