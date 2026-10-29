import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { RETRY, runPublicAction } from '../scripts/lib/gate.mjs';
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
  const all = [caught.message, caught.stack, caught.cause?.message, caught.cause?.stack, caught.stderr, caught.detail?.url].map(String).join('\n');
  assert.equal(all.includes(TOKEN) || all.includes(encoded), false, all);
  assert.match(caught.stderr, /redacted/);
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
  assert.match(caught.message, /^boom \[redacted\]/);
  assert.match(String(caught.outcomeError?.message), /already used/);
});
