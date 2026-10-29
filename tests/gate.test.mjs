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
const FORK = 'https://github.com/pacphi/ruflo.git';
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
    home, runDir, gate: 'submit-gate', run: RUN, binding, branch: BRANCH, fork: FORK, host: 'claude-code',
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

test('I1: what helps the human is kept, cleaned: message, stack, stderr, stdout, the cause chain, a safe code and status (bytes only by size, R13)', async () => {
  const { caught } = await failWith((t) => {
    const inner = Object.assign(new Error(`inner ${t}`), { code: 'ECONNRESET' });
    return Object.assign(new Error(`push failed for ${t}`, { cause: new AggregateError([inner, 'a string reason'], 'several') }), {
      code: 'E_PUSH_REJECTED', status: 403, stderr: Buffer.from(`fatal: ${t}\n`), stdout: `out ${t}`,
    });
  });
  assert.equal(caught.message, 'the action failed: push failed for [redacted]');
  assert.deepEqual([caught.details.code, caught.details.status], ['E_PUSH_REJECTED', 403]);
  assert.equal(caught.details.stderr, `[${Buffer.byteLength(`fatal: ${TOKEN}\n`)} bytes omitted]`);
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
  // Since N8 only the frame lines are taken from the original stack; its first line is the gate's own message.
  const { caught } = await failWith((t) => { const e = new Error('clean'); e.stack = `Error: tok ${t}\n    at ${t} (file.js:1:1)`; return e; });
  assert.equal(caught.details.stack, 'Error: clean\n    at [redacted] (file.js:1:1)');
  assert.equal(holdsToken(rendered(caught)), false);
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
  const { caught } = await failWith(() => Object.assign(new Error('remote: \u001b[2Jpush rejected‮', { cause: 'x\u009b31m' }), { stderr: 'remote: \u001b]0;title\u0007 denied\r\nnext\tline\n' }));
  const all = [caught.message, caught.details.stack, caught.details.stderr, ...caught.details.causes].join('\n');
  assert.equal(/[\u001b\u009b‮\u0007\r]/.test(all), false, JSON.stringify(all));
  assert.match(caught.details.stderr, /denied\?\nnext\tline\n$/);
});

// ---- Fix round 2 (re-review N1 to N6) ----

const ALIGN = [['aligned', 0], ['at an odd byte offset', 1]];
for (const [bom, bomBytes] of [['no BOM', []], ['a BOM', [0xff, 0xfe]]]) {
  for (const [where, pad] of ALIGN) {
    test(`N1: a UTF-16LE stderr (${bom}, ${where}) holding the token is not shown (R13: only its size is)`, async () => {
      const { caught } = await failWith((t) => Object.assign(new Error('x'), { stderr: Buffer.concat([Buffer.alloc(pad, 0x20), Buffer.from(bomBytes), Buffer.from(`w ${t}`, 'utf16le')]) }));
      const all = rendered(caught);
      assert.equal(holdsToken(all), false, all);
      assert.equal(holdsToken(all.replace(/[?\0]/g, '')), false, all);
      assert.equal(caught.message, 'the action failed: x');
      assert.equal(caught.details.stderr, `[${pad + bomBytes.length + 2 * `w ${TOKEN}`.length} bytes omitted]`);
    });
  }
}

test('N1: a UTF-16LE Uint16Array view is covered too', async () => {
  const { caught } = await failWith((t) => Object.assign(new Error('x'), { stdout: new Uint16Array(Buffer.from(`${t}`, 'utf16le').buffer.slice(0, 82)) }));
  assert.equal(holdsToken(rendered(caught).replace(/[?\0]/g, '')), false);
  assert.equal(caught.details.stdout, '[82 bytes omitted]');
});

test('N2: an attempt is not started after the window, even when the sleep ran long', async () => {
  const s = setup();
  let n = 0;
  let caught;
  await assert.rejects(runPublicAction({
    ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]),
    sleep: async () => { s.clock.t += 40_000; },
    action: async () => { n += 1; s.clock.t += 100_000; throw transient(); },
  }), (e) => { caught = e; return true; });
  assert.equal(n, 1);
  assert.equal(caught.code, 'ACTION_TIMEOUT');
  assert.deepEqual(outcomes(s), ['failed']);
});

test('N2: an attempt is not started after the window, even when the recompute ran long', async () => {
  const s = setup();
  let n = 0;
  let calls = 0;
  await assert.rejects(runPublicAction({
    ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]),
    recompute: async () => { calls += 1; if (calls > 1) s.clock.t += 30_000; return binding; },
    action: async () => { n += 1; s.clock.t += 100_000; throw transient(); },
  }), (e) => e.code === 'ACTION_TIMEOUT');
  assert.equal(n, 1);
  assert.deepEqual(outcomes(s), ['failed']);
});

test('N3: a timeout says the action may already have taken effect', async () => {
  const s = setup();
  let caught;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async ({ signal, attempt }) => {
    if (attempt === 1) { s.clock.t += RETRY.windowMs - RETRY.backoffMs[0] - 30; throw transient(); }
    await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); });
    throw new Error('socket hang up');
  } }), (e) => { caught = e; return true; });
  assert.equal(caught.code, 'ACTION_TIMEOUT');
  assert.match(caught.message, /it may already have been published; check before you run it again/);
});

test('N4: a global Error.prepareStackTrace hook cannot put the token back into the stack of the generic or the built error', async () => {
  const saved = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (err, frames) => `${err.name}: ${err.message}\n    at ${TOKEN} (${frames.length})`;
    for (const make of [() => new Error('plain failure'), () => ({ message: 'x', stderr: Buffer.from(`w ${TOKEN}`, 'utf16le') })]) {
      const s = setup();
      let caught;
      await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { throw make(); } }), (e) => { caught = e; return true; });
      const d = Object.getOwnPropertyDescriptor(caught, 'stack');
      assert.equal('value' in d, true, 'stack is a plain data property');
      const all = rendered(caught);
      assert.equal(holdsToken(all), false, all);
    }
  } finally {
    Error.prepareStackTrace = saved;
  }
});

test('N5: the text is scrubbed before it is cut: a token across the 8 KiB cut does not leave a piece behind', async () => {
  const { caught } = await failWith((t) => Object.assign(new Error('x'), { stderr: `${'A'.repeat(8180)} ${t}` }));
  assert.equal(caught.details.stderr.includes('ghp_'), false);
  assert.match(caught.details.stderr, /\[redacted\]/);
});

test('N5: a token holding "?" with a control character in its place is caught after terminal cleaning', async () => {
  const s = setup();
  const odd = 'abc?defghijklmnop';
  makeTestVault(s.home, { token: odd });
  let caught;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { throw new Error(`tok ${odd.replace('?', '\u001b')}`); } }), (e) => { caught = e; return true; });
  assert.equal(caught.message, GENERIC);
});

test('N5: an error from the first recompute (before the receipt) is rebuilt: the token in it does not survive', async () => {
  const s = setup();
  let caught;
  let thrown;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), recompute: async () => { thrown = Object.assign(new Error(`git failed ${TOKEN}`), { stderr: TOKEN }); throw thrown; }, action: async () => 'no' }), (e) => { caught = e; return true; });
  assert.notEqual(caught, thrown);
  assert.equal(caught.code, 'RECOMPUTE_FAILED');
  assert.equal(holdsToken(rendered(caught)), false);
  assert.deepEqual(events(s), ['unlock-refused']);
});

test('N5: an attempt stopped by the window that throws a transient error is not retried', async () => {
  const s = setup();
  let n = 0;
  let caught;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async ({ signal }) => {
    n += 1;
    // The first attempt leaves 30 ms (real time) of the window; the clock is put back once the signal fires, so only the aborted signal can stop a retry.
    if (n === 1) { s.clock.t += RETRY.windowMs - RETRY.backoffMs[0] - 30; throw transient(); }
    await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); });
    s.clock.t = 1_000_000;
    throw transient();
  } }), (e) => { caught = e; return true; });
  assert.equal(n, 2);
  assert.equal(caught.code, 'ACTION_TIMEOUT');
});

test('N6: each half of a split token, and a cut-off token, is redacted', async () => {
  const { caught } = await failWith((t) => Object.assign(new Error(t.slice(0, 20)), { stderr: t.slice(20), stdout: t.slice(0, 35) }));
  const all = [caught.message, caught.details.stderr, caught.details.stdout].join('\n');
  assert.equal(all.includes(TOKEN.slice(0, 16)), false);
  assert.equal(all.includes(TOKEN.slice(25)), false);
});

test('N6: the token as hex, and as util.inspect prints a Buffer, is redacted', async () => {
  const { caught } = await failWith((t) => Object.assign(new Error(`hex ${Buffer.from(t).toString('hex')}`), { stderr: util.inspect(Buffer.from(t)) }));
  const hex = Buffer.from(TOKEN).toString('hex');
  const all = rendered(caught);
  assert.equal(all.includes(hex), false);
  assert.equal(all.includes(hex.slice(0, 40).replace(/(..)/g, '$1 ').trim()), false);
});

test('N6: base64 wrapped across lines (any column) is caught', async () => {
  for (const col of [10, 12, 40, 76]) {
    const { caught } = await failWith((t) => new Error(`Authorization: Basic ${b64(`x-access-token:${t}`).replace(new RegExp(`(.{${col}})`, 'g'), '$1\n')}`));
    const squeezed = rendered(caught).replace(/\s+/g, '');
    assert.equal(holdsToken(squeezed), false, `column ${col}`);
    assert.equal(squeezed.includes(b64(`x-access-token:${TOKEN}`).slice(0, 40)), false, `column ${col}`);
  }
});

test('N6, M1: a huge single base64-looking run is read only up to 1 MiB, then cut; it no longer has to fail closed', async () => {
  const { caught } = await failWith(() => Object.assign(new Error('x'), { stderr: 'A'.repeat(12 * 1024 * 1024) }));
  assert.equal(caught.message, 'the action failed: x');
  assert.equal(caught.details.stderr, `${'A'.repeat(8192)}... [cut]`);
});

// ---- Fix round 3 (R13, N7, hex case) ----

const omitted = (n) => `[${n} bytes omitted]`;
const BYTE_FIELDS = [
  ['a Buffer', (t) => Buffer.from(`fatal: ${t}`), (t) => Buffer.byteLength(`fatal: ${t}`)],
  ['a UTF-16LE Buffer', (t) => Buffer.from(`fatal: ${t}`, 'utf16le'), (t) => 2 * `fatal: ${t}`.length],
  ['a UTF-16LE Buffer holding base64 of the token', (t) => Buffer.from(`Basic ${b64(`x:${t}`)}`, 'utf16le'), (t) => 2 * `Basic ${b64(`x:${t}`)}`.length],
  ['a Uint8Array', (t) => new TextEncoder().encode(t), (t) => t.length],
  ['a Uint16Array of code units', (t) => Uint16Array.from([...t].map((c) => c.charCodeAt(0))), (t) => 2 * t.length],
  ['an Int32Array of code units', (t) => Int32Array.from([...t].map((c) => c.charCodeAt(0))), (t) => 4 * t.length],
  ['an ArrayBuffer', (t) => new TextEncoder().encode(t).buffer, (t) => t.length],
  ['a DataView', (t) => new DataView(new TextEncoder().encode(`xx${t}`).buffer, 2), (t) => t.length],
  ['a SharedArrayBuffer', (t) => { const sab = new SharedArrayBuffer(t.length); new Uint8Array(sab).set(new TextEncoder().encode(t)); return sab; }, (t) => t.length],
];

for (const [name, make, size] of BYTE_FIELDS) {
  test(`R13: ${name} in stderr or stdout is never decoded: it is replaced by a note of its size`, async () => {
    const { caught } = await failWith((t) => Object.assign(new Error(`push failed for ${t}`), { stderr: make(t), stdout: make(t) }));
    assert.equal(caught.message, 'the action failed: push failed for [redacted]');
    assert.equal(caught.details.stderr, omitted(size(TOKEN)));
    assert.equal(caught.details.stdout, omitted(size(TOKEN)));
    const all = rendered(caught);
    assert.equal(holdsToken(all), false, all);
    assert.equal(holdsToken(all.replace(/[\s\0?]/g, '')), false, all);
  });
}

test('R13: bytes as the message, as a cause, inside an AggregateError, or thrown on their own are replaced by the note', async () => {
  const bytes = () => Buffer.from(TOKEN, 'utf16le');
  const { caught } = await failWith(() => Object.assign(new Error('push failed', { cause: bytes() }), { errors: [] }));
  assert.deepEqual(caught.details.causes, [omitted(2 * TOKEN.length)]);
  const agg = await failWith(() => new AggregateError([bytes(), new Error('second')], 'several'));
  assert.deepEqual(agg.caught.details.causes, [omitted(2 * TOKEN.length), 'second']);
  const msg = await failWith(() => ({ message: bytes() }));
  assert.equal(msg.caught.message, `the action failed: ${omitted(2 * TOKEN.length)}`);
  const bare = await failWith(() => bytes());
  assert.equal(bare.caught.message, `the action failed: ${omitted(2 * TOKEN.length)}`);
  // On a real Error, V8 would format the stack's first line from the message (N8): the gate takes only the
  // frames from it and puts its own note on top.
  const onError = await failWith(() => Object.assign(new Error('x'), { message: bytes() }));
  assert.equal(onError.caught.message, `the action failed: ${omitted(2 * TOKEN.length)}`);
  assert.match(onError.caught.details.stack, new RegExp(`^Error: \\[${2 * TOKEN.length} bytes omitted\\]\\n {4}at `));
  for (const c of [caught, agg.caught, msg.caught, bare.caught, onError.caught]) assert.equal(holdsToken(rendered(c).replace(/[\s\0?]/g, '')), false);
});

test('R13: a byte buffer is never read through its own accessors or a Proxy', async () => {
  let calls = 0;
  const { caught } = await failWith((t) => {
    const b = Buffer.from(t);
    Object.defineProperty(b, 'byteLength', { get: () => { calls += 1; return 1; } });
    Object.defineProperty(b, 'toString', { value: () => { calls += 1; return t; } });
    return Object.assign(new Error('x'), { stderr: b, stdout: new Proxy(Buffer.from(t), {}) });
  });
  assert.equal(calls, 0);
  assert.equal(caught.details.stderr, omitted(TOKEN.length));
  assert.equal(caught.details.stdout, undefined);
  assert.equal(holdsToken(rendered(caught)), false);
});

const interleave = (text, gap) => [...text].join(gap);
const NUL_SHAPES = [
  ['UTF-16 text decoded as UTF-8 (one NUL between characters)', '\0'],
  ['UTF-32 text decoded as UTF-8 (three NULs between characters)', '\0\0\0'],
  ['a zero-width space between characters', '​'],
  ['another control character between characters', '\u0001'],
];
const NUL_PLACES = [
  ['the message', (text) => new Error(text)],
  ['a custom stack', (text) => { const e = new Error('clean'); e.stack = `Error: clean\n    at ${text}`; return e; }],
  ['a stderr string', (text) => Object.assign(new Error('clean'), { stderr: text })],
  ['a cause message', (text) => new Error('clean', { cause: new Error(text) })],
  ['a thrown string', (text) => text],
];
for (const [shape, gap] of NUL_SHAPES) {
  for (const [place, make] of NUL_PLACES) {
    test(`N7: ${shape}, in ${place}, gives the generic message`, async () => {
      const { caught } = await failWith((t) => make(interleave(`x ${t}`, gap)));
      assert.equal(caught.message, GENERIC);
      const all = rendered(caught);
      assert.equal(holdsToken(all.replace(/[\s\0?​\u0001]/g, '')), false, all);
    });
  }
}

test('N7: a NUL-interleaved half of the token is caught too', async () => {
  const { caught } = await failWith((t) => Object.assign(new Error('x'), { stderr: interleave(t.slice(0, 20), '\0') }));
  assert.equal(caught.message, GENERIC);
});

test('N7: ordinary text with a NUL or a zero-width space in it is still kept', async () => {
  const { caught } = await failWith(() => Object.assign(new Error('remote:\0 rejected​'), { stderr: 'a\0b' }));
  assert.equal(caught.message, 'the action failed: remote:? rejected?');
  assert.equal(caught.details.stderr, 'a?b');
});

const hexOf = (t) => Buffer.from(t).toString('hex');
test('3a: the token as upper-case hex, plain or spaced, is redacted', async () => {
  const { caught } = await failWith((t) => Object.assign(new Error(`hex ${hexOf(t).toUpperCase()}`), { stderr: util.inspect(Buffer.from(t)).toUpperCase() }));
  const all = rendered(caught);
  const upper = hexOf(TOKEN).toUpperCase();
  assert.equal(all.toLowerCase().includes(hexOf(TOKEN)), false, all);
  assert.equal(all.includes(upper.slice(0, 40).replace(/(..)/g, '$1 ').trim()), false, all);
  assert.match(caught.message, /^the action failed: hex \[redacted\]$/);
});

test('3a: the token as mixed-case hex, at an odd offset, or half of it in hex, is not shown', async () => {
  let n = 0;
  const mixed = (h) => h.replace(/[a-f]/g, (c) => ((n += 1) % 2 ? c.toUpperCase() : c));
  for (const make of [
    (t) => new Error(`hex ${mixed(hexOf(t))}`),
    (t) => new Error(`hex 7${hexOf(t)}`),
    (t) => Object.assign(new Error(`a ${hexOf(t.slice(0, 20)).toUpperCase()}`), { stderr: hexOf(t.slice(20)) }),
    (t) => new Error(`wrapped ${hexOf(t).toUpperCase().replace(/(.{10})/g, '$1\n')}`),
  ]) {
    const { caught } = await failWith(make);
    const all = rendered(caught).replace(/\s+/g, '').toLowerCase();
    assert.equal(all.includes(hexOf(TOKEN).slice(0, 32)), false, all);
    assert.equal(all.includes(hexOf(TOKEN).slice(-32)), false, all);
  }
});

test('3a: a commit SHA, upper-case hex and a long hex blob that do not hold the token are left alone', async () => {
  const blob = Buffer.from('nothing secret in this blob at all, really nothing').toString('hex').toUpperCase();
  const { caught } = await failWith(() => new Error(`commit ${A} ${'C'.repeat(40)} blob ${blob}`));
  assert.equal(caught.message, `the action failed: commit ${A} ${'C'.repeat(40)} blob ${blob}`);
});

test('N7: one control or zero-width character inside the token (which the scrub would cut around) gives the generic message', async () => {
  for (const mark of ['\u001b', '​', '\0', '\n']) {
    for (const make of [(t) => new Error(`tok ${t.slice(0, 10)}${mark}${t.slice(10)}`), (t) => Object.assign(new Error('x'), { stderr: `${t.slice(0, 35)}${mark}${t.slice(35)} and ${t}` })]) {
      const { caught } = await failWith(make);
      assert.equal(caught.message, GENERIC, JSON.stringify(mark));
    }
  }
});

test('N6: every character of a piece of 16 or more is redacted, not only the first 16', async () => {
  const { caught } = await failWith((t) => Object.assign(new Error(`a ${t.slice(0, 31)} b`), { stderr: `c ${t.slice(10)} d`, stdout: `e ${t.slice(0, 35)} f` }));
  assert.equal(caught.message, 'the action failed: a [redacted] b');
  assert.equal(caught.details.stderr, 'c [redacted] d');
  assert.equal(caught.details.stdout, 'e [redacted] f');
});

test('3a: mixed-case hex of the token, at either alignment, is scrubbed in place by decoding the run', async () => {
  let n = 0;
  const mixed = (h) => h.replace(/[a-f]/g, (c) => ((n += 1) % 2 ? c.toUpperCase() : c));
  const even = await failWith((t) => new Error(`hex ${mixed(hexOf(t))} end`));
  assert.equal(even.caught.message, 'the action failed: hex [redacted] end');
  const odd = await failWith((t) => Object.assign(new Error(`hex 7${mixed(hexOf(t))} end`), { stderr: `half F${mixed(hexOf(t.slice(0, 20)))}` }));
  assert.equal(odd.caught.message, 'the action failed: hex [redacted] end');
  assert.equal(odd.caught.details.stderr, 'half [redacted]');
});

test('N7: a Basic header with NULs between its characters (UTF-16 text read as UTF-8) gives the generic message', async () => {
  const { caught } = await failWith((t) => Object.assign(new Error('x'), { stderr: interleave(`Authorization: Basic ${b64(`x:${t}`)}`, '\0') }));
  assert.equal(caught.message, GENERIC);
});

// ---- Fix round 4 (N8, N9, N10, mutants) ----

// A list of eight or more numbers joined by commas: how a typed array or an Array prints through toString.
const DECIMALS = /\d+(?:\.\d+)?(?:\s*,\s*\d+(?:\.\d+)?){8,}/;
const codeUnits = (t) => [...t].map((c) => c.charCodeAt(0));
const CONTAINERS = [
  ['a Uint8Array', (t) => new Uint8Array(Buffer.from(t))],
  ['an Int16Array of code units', (t) => Int16Array.from(codeUnits(t))],
  ['a Float64Array', (t) => Float64Array.from(Buffer.from(t))],
  ['a plain Array of bytes', (t) => [...Buffer.from(t)]],
];
for (const [kind, make] of CONTAINERS) {
  for (const key of ['message', 'name']) {
    for (const [when, readFirst] of [['', false], [', with the stack read by the action first', true]]) {
      test(`N8: ${kind} as the error's own ${key}${when} never reaches the stack as decimals`, async () => {
        const { caught } = await failWith((t) => {
          const e = new Error('x');
          e[key] = make(t);
          if (readFirst) void e.stack;
          return e;
        });
        const all = rendered(caught);
        assert.equal(DECIMALS.test(all), false, all);
        assert.equal(holdsToken(all), false, all);
        assert.match(caught.details.stack, /\n {4}at /);
      });
    }
  }
}

test('N8: a message or name from a prototype getter, or a poisoned toString, is never called and never shown', async () => {
  let calls = 0;
  let tok;
  let kind = CONTAINERS[0][1];
  class ByMessage extends Error { get message() { calls += 1; return kind(tok); } }
  class ByName extends Error { get name() { calls += 1; return kind(tok); } }
  for (const [, make] of CONTAINERS) {
    kind = make;
    for (const build of [() => { const e = new ByMessage(); delete e.message; return e; }, () => new ByName('clean')]) {
      const { caught } = await failWith((t) => { tok = t; return build(); });
      const all = rendered(caught);
      assert.equal(DECIMALS.test(all), false, all);
      assert.equal(holdsToken(all), false, all);
    }
  }
  class Poisoned extends Error {
    get name() { calls += 1; return tok; }
    toString() { calls += 1; return tok; }
    [Symbol.toPrimitive]() { calls += 1; return tok; }
  }
  for (const make of [
    () => new Poisoned('clean'),
    () => { const e = new Error('x'); e.message = { toString() { calls += 1; return tok; } }; return e; },
  ]) {
    const { caught } = await failWith((t) => { tok = t; return make(); });
    const all = rendered(caught);
    assert.equal(DECIMALS.test(all), false, all);
    assert.equal(holdsToken(all), false, all);
  }
  assert.equal(calls, 0);
});

test('N8: the stack keeps the action\'s frames under the gate\'s own cleaned message, never the original header', async () => {
  const { caught } = await failWith((t) => {
    const e = new Error(`tok ${t}`);
    const formatted = e.stack;
    e.message = 'changed later';
    assert.ok(formatted.startsWith(`Error: tok ${t}\n`));
    return e;
  });
  assert.equal(caught.message, 'the action failed: changed later');
  assert.match(caught.details.stack, /^Error: changed later\n {4}at /);
  assert.equal(caught.details.stack.includes('tok'), false);
  // A frame that holds the token (a function named after it) is scrubbed.
  const named = await failWith((t) => ({ [t]: () => new Error('from a named function') })[t]());
  assert.match(named.caught.details.stack, /^Error: from a named function\n {4}at .*\[redacted\]/);
  assert.equal(holdsToken(rendered(named.caught)), false);
});

test('N9: a base64 run is checked for 16-character pieces too: halves in two fields, a cut Basic header, a cut token', async () => {
  const halves = await failWith((t) => { const b = b64(t); return Object.assign(new Error(`a ${b.slice(0, 28)}`), { stderr: `b ${b.slice(28)}` }); });
  assert.equal(halves.caught.message, 'the action failed: a [redacted]');
  assert.equal(halves.caught.details.stderr, 'b [redacted]');
  const basic = await failWith((t) => new Error(`401 Authorization: Basic ${b64(`x-access-token:${t}`).slice(0, 64)}...`));
  assert.equal(basic.caught.message, 'the action failed: 401 Authorization: Basic [redacted]...');
  const cut = await failWith((t) => new Error(`cut ${b64(t.slice(0, 30))}`));
  assert.equal(cut.caught.message, 'the action failed: cut [redacted]');
});

test('N10: base64 or hex of UTF-16 text (PowerShell -EncodedCommand, a UTF-16 Buffer printed) is not shown', async () => {
  const ps = await failWith((t) => new Error(`Command failed: powershell -EncodedCommand ${Buffer.from(`$env:X='${t}'`, 'utf16le').toString('base64')}`));
  assert.equal(ps.caught.message, 'the action failed: Command failed: powershell -EncodedCommand [redacted]');
  const hex16 = await failWith((t) => new Error(`bytes ${Buffer.from(`x ${t}`, 'utf16le').toString('hex')}`));
  assert.equal(hex16.caught.message, 'the action failed: bytes [redacted]');
  const odd = await failWith((t) => new Error(`bytes 7${Buffer.from(`x ${t}`, 'utf16le').toString('hex').toUpperCase()}`));
  assert.equal(odd.caught.message, 'the action failed: bytes [redacted]');
  // util.inspect shows the first 50 bytes, spaced: 25 characters of the token, found only once squeezed.
  const shown = await failWith((t) => new Error(`unexpected ${util.inspect(Buffer.from(t, 'utf16le'))}`));
  assert.equal(shown.caught.message, GENERIC);
});

test('mutants: a 16-character piece of the token is redacted and a 15-character piece is kept (the stated limit)', async () => {
  const { caught } = await failWith((t) => Object.assign(new Error(`p ${t.slice(5, 21)} q`), { stderr: `r ${t.slice(-16)} s`, stdout: `u ${t.slice(5, 20)} v` }));
  assert.equal(caught.message, 'the action failed: p [redacted] q');
  assert.equal(caught.details.stderr, 'r [redacted] s');
  assert.equal(caught.details.stdout, `u ${TOKEN.slice(5, 20)} v`);
});

test('mutants: the hex of a 16-character piece (a 32-character hex run) is redacted, and a 30-character one is kept', async () => {
  const { caught } = await failWith((t) => Object.assign(new Error(`h ${hexOf(t.slice(5, 21))} q`), { stderr: `k ${hexOf(t.slice(5, 20))} l` }));
  assert.equal(caught.message, 'the action failed: h [redacted] q');
  assert.equal(caught.details.stderr, `k ${hexOf(TOKEN.slice(5, 20))} l`);
});

test('mutants: a Basic header glued after one, two or three base64 characters is redacted at every alignment', async () => {
  for (const glue of ['a', 'ab', 'abc', 'abcd']) {
    const { caught } = await failWith((t) => new Error(`${glue}${b64(`x:${t}`)}`));
    assert.equal(caught.message, 'the action failed: [redacted]', glue);
    assert.equal(holdsToken(rendered(caught)), false, glue);
  }
});

test('mutants: the hex of a 20-character piece, wrapped every 10 characters or NUL-interleaved, gives the generic message', async () => {
  for (const make of [
    (t) => new Error(hexOf(t.slice(0, 20)).match(/.{1,10}/g).join('\n')),
    (t) => new Error([...hexOf(t.slice(3, 23))].join('\0')),
  ]) {
    const { caught } = await failWith(make);
    assert.equal(caught.message, GENERIC);
  }
});

test('M1: only the first 1 MiB of a field is scanned; what lies past it is never read or shown, and the field is marked cut', async () => {
  // A NUL-interleaved token makes a field generic when it is read; past 1 MiB it is not read at all.
  const far = await failWith((t) => new Error(`${'x'.repeat(1024 * 1024)}${interleave(t, '\0')}`));
  assert.equal(far.caught.message, `the action failed: ${'x'.repeat(8192)}... [cut]`);
  // Within the first 1 MiB it is still caught, even far past the 8 KiB that is shown.
  const near = await failWith((t) => new Error(`${'x'.repeat(1024 * 1024 - 200)}${interleave(t, '\0')}`));
  assert.equal(near.caught.message, GENERIC);
  // A field that shrinks when scrubbed below 8 KiB is still marked cut when its tail was not read. The last 64
  // characters of what was scrubbed are not shown (m1).
  const lead = 'abc '.repeat(25);
  const shrunk = await failWith((t) => Object.assign(new Error('x'), { stderr: `${lead}${b64(`x:${t}${'z'.repeat(800_000)}`)} tail` }));
  assert.equal(shrunk.caught.details.stderr, `${`${lead}[redacted]`.slice(0, lead.length + 10 - 64)}... [cut]`);
});

test('N8: the global Error.prepareStackTrace is put back after the gate reads a stack, whether it was set or not', async () => {
  const before = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  await failWith((t) => new Error(`tok ${t}`));
  assert.deepEqual(Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace'), before);
  const mine = (err, frames) => `mine ${frames.length}`;
  try {
    Error.prepareStackTrace = mine;
    const { caught } = await failWith(() => new Error('plain failure'));
    assert.equal(Error.prepareStackTrace, mine);
    assert.match(caught.details.stack, /^Error: plain failure\n {4}at /);
  } finally {
    if (before) Object.defineProperty(Error, 'prepareStackTrace', before);
    else delete Error.prepareStackTrace;
  }
});

test('N8, R13: a stack that is a byte buffer is named by its size under the gate\'s message, never decoded', async () => {
  const { caught } = await failWith((t) => { const o = { message: 'x' }; Object.defineProperty(o, 'stack', { value: Buffer.from(t) }); return o; });
  assert.equal(caught.details.stack, `x\n${omitted(TOKEN.length)}`);
});

// ---- Fix round 5 (m1, m2, m3) ----

// A filler that scrubs down to "[redacted]": one base64 run holding the token, cut so that `piece` ends exactly at
// the gate's 1 MiB scan cut.
const SCAN_MAX = 1024 * 1024;
const fieldWithPieceAtCut = (t, piece) => {
  const run = b64(`x:${t}${'z'.repeat(900_000)}`).slice(0, SCAN_MAX - piece.length - 1);
  return `${run} ${piece} more text after the cut`;
};

test('m1: a token that crosses the gate\'s own 1 MiB scan cut does not show a piece, alone or across three fields', async () => {
  const pieces = (t) => [t.slice(0, 15), t.slice(15, 30), t.slice(30)];
  const { caught } = await failWith((t) => Object.assign(new Error('x'), {
    stderr: fieldWithPieceAtCut(t, pieces(t)[0]), stdout: fieldWithPieceAtCut(t, pieces(t)[1]),
    cause: new Error(fieldWithPieceAtCut(t, pieces(t)[2])),
  }));
  const shown = [caught.details.stderr, caught.details.stdout, ...caught.details.causes];
  assert.equal(shown.length, 3);
  for (const text of shown) {
    assert.ok(text.endsWith('... [cut]'));
    for (const p of pieces(TOKEN)) assert.equal(text.includes(p.slice(0, 6)), false, text);
  }
  // A token straddling the old cut position shows no piece of itself either.
  const straddle = await failWith((t) => Object.assign(new Error('x'), { stderr: fieldWithPieceAtCut(t, t.slice(0, 10)) }));
  assert.equal(straddle.caught.details.stderr.includes(TOKEN.slice(0, 6)), false);
});

test('m2: the class name stays in the stack header, a DOMException keeps its name and message, and no name getter runs', async () => {
  const type = await failWith(() => new TypeError('bad input'));
  assert.match(type.caught.details.stack, /^TypeError: bad input\n {4}at /);
  class Custom extends Error {}
  Custom.prototype.name = 'CustomFailure';
  const custom = await failWith(() => new Custom('boom'));
  assert.match(custom.caught.details.stack, /^CustomFailure: boom\n {4}at /);
  for (const reason of [new DOMException('The operation was aborted due to timeout', 'TimeoutError'), new DOMException('stopped by the user', 'AbortError')]) {
    const { caught } = await failWith(() => reason);
    assert.equal(caught.message, `the action failed: ${reason.message}`);
    assert.equal(caught.details.stack === undefined || caught.details.stack.startsWith(`${reason.name}: ${reason.message}`), true);
  }
  const dom = await failWith(() => { const e = new DOMException('late', 'AbortError'); e.stack = 'x\n    at somewhere (f.js:1:1)'; return e; });
  assert.equal(dom.caught.details.stack, 'AbortError: late\n    at somewhere (f.js:1:1)');
  // A name that is not a plain identifier, or that holds the token, is not shown; an accessor is never called.
  const calls = [];
  const getter = new Error('quiet');
  Object.defineProperty(getter, 'name', { get() { calls.push('own'); return 'Sneaky'; } });
  const proto = Object.create({ get name() { calls.push('proto'); return 'Sneaky'; } });
  const viaProto = Object.assign(proto, { message: 'quiet too', stack: 'x\n    at a (b.js:1:1)' });
  const odd = new Error('odd'); odd.name = 'not a name!';
  const named = await failWith((t) => Object.assign(new Error('tok'), { name: t }));
  const results = [await failWith(() => getter), await failWith(() => viaProto), await failWith(() => odd), named];
  assert.deepEqual(calls, []);
  for (const { caught } of results) assert.doesNotMatch(caught.details.stack ?? '', /Sneaky|not a name/);
  assert.equal(holdsToken(rendered(named.caught)), false);
});

test('m3: the original Error.prepareStackTrace is put back when formatting the frames throws', async () => {
  const before = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  const mine = () => 'mine';
  Error.prepareStackTrace = mine;
  const map = Array.prototype.map;
  // Throws only for the array of CallSites that the gate's hook maps.
  Array.prototype.map = function poisoned(...args) { // eslint-disable-line no-extend-native
    if (typeof this[0]?.getFileName === 'function') throw new Error('formatting failed');
    return Reflect.apply(map, this, args);
  };
  let caught;
  try { ({ caught } = await failWith(() => new Error('plain'))); } finally {
    Array.prototype.map = map; // eslint-disable-line no-extend-native
  }
  const after = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  if (before) Object.defineProperty(Error, 'prepareStackTrace', before); else delete Error.prepareStackTrace;
  assert.equal(after.value, mine);
  assert.equal(caught.message, GENERIC);
});

test('m3: Error.prepareStackTrace is put back exactly when it was an accessor or a non-writable property', async () => {
  const before = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  const mine = () => 'mine';
  const writes = [];
  const shapes = [
    { get: () => mine, set: (v) => { writes.push(v); }, configurable: true },
    { value: mine, writable: false, configurable: true },
  ];
  try {
    for (const shape of shapes) {
      Object.defineProperty(Error, 'prepareStackTrace', shape);
      await failWith(() => new Error('plain'));
      assert.deepEqual(Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace'), { enumerable: false, ...shape });
    }
    assert.deepEqual(writes, []);
  } finally {
    Object.defineProperty(Error, 'prepareStackTrace', { configurable: true, writable: true, value: undefined });
    if (before) Object.defineProperty(Error, 'prepareStackTrace', before); else delete Error.prepareStackTrace;
  }
});

test('m3: only lines that start with four spaces and "at " are kept as frames', async () => {
  const stack = ['Error: header', '    at kept (a.js:1:1)', '  at two (b.js:1:1)', ' at one (c.js:1:1)', '    atx (d.js:1:1)', '\tat tab (e.js:1:1)', 'x    at inline (f.js:1:1)', '    at also (g.js:1:1)'].join('\n');
  const { caught } = await failWith(() => ({ message: 'm', stack }));
  assert.equal(caught.details.stack, 'm\n    at kept (a.js:1:1)\n    at also (g.js:1:1)');
});

// ---- Task 14: the fork (R16(b)) and the lease (ADR-0012) are signed, and the gate shows both in its own words ----

test('a lease is carried into the signed receipt, so the unlock approves replacing exactly that commit', async () => {
  const s = setup();
  const lease = 'c'.repeat(40);
  const t = fakeSecretTerminal([PASSPHRASE]);
  const r = await runPublicAction({ ...s.base, lease, terminal: t, action: async ({ receipt }) => receipt.lease });
  assert.equal(r.result, lease);
  assert.equal(readEvents(s.ledgerDir)[0].data.receipt.lease, lease);
  // The gate's own line (not the caller's summary) says that the push replaces that commit.
  const own = t.written.join('').split('\n').find((l) => l.startsWith('Your passphrase signs'));
  assert.match(own, new RegExp(`replaces commit ${lease}`));
  const plain = setup();
  const pt = fakeSecretTerminal([PASSPHRASE]);
  const p = await runPublicAction({ ...plain.base, terminal: pt, action: async ({ receipt }) => receipt.lease });
  assert.equal(p.result, null);
  assert.doesNotMatch(pt.written.join(''), /replaces/);
});

test('the fork is signed as its normalized key, and the gate names it in its own line', async () => {
  const s = setup();
  const t = fakeSecretTerminal([PASSPHRASE]);
  const r = await runPublicAction({ ...s.base, fork: 'git@github.com:PacPhi/ruflo.git', terminal: t, action: async ({ receipt }) => receipt.fork });
  assert.equal(r.result, 'github.com/pacphi/ruflo');
  assert.equal(readEvents(s.ledgerDir)[0].data.receipt.fork, 'github.com/pacphi/ruflo');
  const own = t.written.join('').split('\n').find((l) => l.startsWith('Your passphrase signs'));
  assert.match(own, /to your fork github\.com\/pacphi\/ruflo/);
});

test('a submit gate without a fork the guard can recognise, or a fork or lease on another gate, is refused before anything is shown', async () => {
  const content = { kind: 'content', value: `sha256:${'d'.repeat(64)}` };
  const cases = [
    [{ fork: null }, /fork/],
    [{ fork: undefined }, /fork/],
    [{ fork: '/tmp/decoy.git' }, /fork/],
    [{ fork: 'http://github.com/pacphi/ruflo.git' }, /fork/],
    [{ fork: 'github.com/pacphi/ruflo' }, /fork/],
    [{ gate: 'post-comment', branch: null, binding: content, recompute: async () => content }, /fork/],
    [{ lease: 'abc' }, /lease/],
    [{ lease: 'C'.repeat(40) }, /lease/],
    // Finding M-1: leases that can never be a real replacement.
    [{ lease: '0'.repeat(40) }, /lease/],
    [{ lease: binding.value }, /lease/],
    [{ lease: 'c'.repeat(64) }, /lease/],
    [{ gate: 'post-comment', branch: null, fork: null, binding: content, recompute: async () => content, lease: 'c'.repeat(40) }, /lease/],
    [{ binding: { kind: 'content', value: `sha256:${'d'.repeat(64)}` }, lease: 'c'.repeat(40) }, /lease/],
  ];
  for (const [extra, why] of cases) {
    const s = setup();
    const t = fakeSecretTerminal([PASSPHRASE]);
    let called = false;
    await assert.rejects(runPublicAction({ ...s.base, ...extra, terminal: t, action: async () => { called = true; } }), (e) => e.code === 'BAD_CALL' && why.test(e.message), JSON.stringify(extra));
    assert.equal(called, false);
    assert.equal(t.written.join(''), '', JSON.stringify(extra));
    assert.deepEqual(events(s), [], JSON.stringify(extra));
  }
  const post = setup();
  const ok = await runPublicAction({ ...post.base, gate: 'post-comment', branch: null, fork: null, binding: content, recompute: async () => content, terminal: fakeSecretTerminal([PASSPHRASE]), action: async ({ receipt }) => [receipt.fork, receipt.lease] });
  assert.deepEqual(ok.result, [null, null]);
});
