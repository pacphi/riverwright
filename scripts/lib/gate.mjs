// The collapsed public gate (ADR-0010, core spec §6 and §7.5): show the payload, unlock with the passphrase,
// sign a receipt, run the action with the token, retry a transient failure a few times in this same process,
// then record the receipt's outcome. Plan 2b's `submit` and `post` are thin callers of runPublicAction.
//
// What holds:
// - No terminal, or a terminal that would echo, means nothing is shown, released or written.
// - The binding (a commit SHA or a content hash) is what the receipt signs. The summary the human reads is
//   display only; recompute() must return the same binding after the unlock and before every retry.
// - The token and the private key live only in this call's memory and are dropped when it returns. Nothing is
//   cached across runs, so a run that exits needs a new unlock. A record in state.json or an earlier receipt
//   never stands in for the passphrase.
// - The retry limits are constants here, not settings an agent could change.
// - Text shown in the terminal goes through printable.mjs (R11): the summary and warnings carry upstream text.
//
// Receipt order: the `approved` event is written before the action and stays unused while it runs, because the
// pre-push guard checks for a signed, unused receipt during `git push` (spec §7.1). The final outcome
// (succeeded or failed) is recorded once, afterwards. A crash during the action therefore leaves the receipt
// unused until it expires (10 minutes), bound to the exact SHA and branch: the same residual risk ADR-0010
// states for the tail of the ledger.
import { RiverwrightError } from './errors.mjs';
import { openVault, readVault } from './vault.mjs';
import { canHideInput, noEchoControl, readSecret } from './tty.mjs';
import { PUBLIC_GATES, appendReceipt, markConsumed } from './receipt.mjs';
import { appendEvent, ledgerDirFor } from './ledger.mjs';
import { loadState, saveState } from './state.mjs';
import { checkBinding, normalizeBranch, recordApproval } from './approvals.mjs';
import { printable, printableLines, shown } from './printable.mjs';

export const RETRY = Object.freeze({ attempts: 3, windowMs: 120_000, backoffMs: Object.freeze([2000, 5000]) });
const PASSPHRASE_TRIES = 3;
const REDACTED = '[redacted]';
const SCAN_DEPTH = 4;

const same = (a, b) => a?.kind === b?.kind && a?.value === b?.value;
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };

// Each caller line is printed indented, and so is every line inside it, so upstream text with a newline
// cannot produce a line that reads as Riverwright's own words.
const indented = (text, first, rest = first) => `${printableLines(text).split('\n').map((l, i) => `${i ? rest : first}${l}`).join('\n')}\n`;

function checkLines(lines, { label, required }) {
  const ok = Array.isArray(lines) && lines.every((l) => typeof l === 'string') && (!required || lines.length > 0);
  if (!ok) throw new RiverwrightError('BAD_SUMMARY', `${label} must be ${required ? 'a non-empty' : 'an'} array of strings`);
}

// ---- Keeping the token out of errors ----

const formsOf = (token) => [...new Set([token, encodeURIComponent(token)])].filter((f) => typeof f === 'string' && f.length > 0);
const holds = (text, forms) => forms.some((f) => text.includes(f));
const scrub = (text, forms) => forms.reduce((t, f) => t.split(f).join(REDACTED), text);

// Cleans string fields of an error and the objects it holds (cause, errors, stderr, details...), to SCAN_DEPTH.
// Accessor properties are not called, except an Error's own `stack`. Returns false when a field that held the
// token could not be rewritten (a frozen error, a read-only field).
function clean(value, forms, seen, depth) {
  if (value === null || typeof value !== 'object' || seen.has(value) || depth > SCAN_DEPTH || ArrayBuffer.isView(value)) return true;
  seen.add(value);
  let ok = true;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') continue;
    const d = Object.getOwnPropertyDescriptor(value, key);
    const isStack = key === 'stack' && value instanceof Error;
    if (!d || (!('value' in d) && !isStack)) continue;
    let v;
    try { v = isStack ? value.stack : d.value; } catch { continue; }
    if (typeof v === 'string') {
      if (!holds(v, forms)) continue;
      try { value[key] = scrub(v, forms); } catch { /* read-only: checked below */ }
      let after;
      try { after = isStack ? value.stack : value[key]; } catch { after = v; }
      if (typeof after !== 'string' || holds(after, forms)) ok = false;
    } else if (v && typeof v === 'object') {
      ok = clean(v, forms, seen, depth + 1) && ok;
    }
  }
  return ok;
}

function redact(error, token) {
  if (typeof token !== 'string' || !token) return error;
  const forms = formsOf(token);
  if (typeof error === 'string') return holds(error, forms) ? new RiverwrightError('ACTION_FAILED', scrub(error, forms)) : error;
  if (error === null || typeof error !== 'object') return error;
  if (clean(error, forms, new Set(), 0)) return error;
  return new RiverwrightError('ACTION_FAILED', 'the action failed, and its error held the credential in a form Riverwright could not remove, so the error is not shown');
}

// ---- The gate ----

// runPublicAction({ home, runDir, gate, run, binding, branch?, host?, terminal, summary, warnings?, now, clock?,
//   sleep?, recompute, action }) => { result, receipt, attempts, outcomeRecorded }
//
// action({ token, receipt, attempt }) does the public thing. It throws an error with `transient === true` for a
// network error, a 5xx or a rate limit; anything else is final. recompute() returns the payload's binding as it
// is now (a commit SHA or a content hash, from the live repository or the normalized text). The caller owns the
// terminal ({ input, output }) and closes it.
export async function runPublicAction({ home, runDir, gate, run, binding, branch = null, host = null, terminal, summary, warnings = [], now, clock = Date.now, sleep = defaultSleep, recompute, action }) {
  // Everything that can be checked without the human is checked before anything is shown or written.
  if (!PUBLIC_GATES.includes(gate)) throw new RiverwrightError('NOT_PUBLIC_GATE', `${shown(gate)} is not a public gate (${PUBLIC_GATES.join(', ')})`);
  const bound = checkBinding(binding);
  if (typeof run !== 'string' || !run) throw new RiverwrightError('BAD_CALL', 'a public action names its run');
  const onBranch = gate === 'submit-gate' ? normalizeBranch(branch) : null;
  if (gate !== 'submit-gate' && branch !== null) throw new RiverwrightError('BAD_CALL', 'only the submit gate names a branch');
  checkLines(summary, { label: 'the summary', required: true });
  checkLines(warnings, { label: 'the warnings', required: false });
  for (const [name, fn] of [['now', now], ['clock', clock], ['sleep', sleep], ['recompute', recompute], ['action', action]]) {
    if (typeof fn !== 'function') throw new RiverwrightError('BAD_CALL', `runPublicAction needs ${name} to be a function`);
  }
  if (!terminal?.input || !terminal?.output) throw new RiverwrightError('NO_TTY', 'Publishing needs your passphrase typed in a real terminal. Run this riverwright command yourself in a terminal window; nothing was published.');
  if (!canHideInput(terminal)) throw noEchoControl();
  const vault = readVault(home);
  const ledgerDir = ledgerDirFor(runDir);

  const refuse = (reason) => {
    // Best effort: a refusal that cannot be recorded must not hide why the action stopped.
    try { appendEvent(runDir, { type: 'unlock-refused', at: now(), actor: { type: 'human' }, run, gate, reason }); } catch { /* see above */ }
  };

  const out = terminal.output;
  out.write(`\nRiverwright is about to act publicly (${gate}) for ${printable(run)}:\n`);
  for (const line of summary) out.write(indented(line, '  '));
  const what = bound.kind === 'sha' ? `commit ${bound.value}` : `content ${bound.value}`;
  out.write(`\nYour passphrase signs a receipt for this exact ${what}${onBranch ? ` on ${onBranch}` : ''}.\n`);
  if (warnings.length) {
    out.write('\nRiverwright cannot stop these routes to your credentials:\n');
    for (const w of warnings) out.write(indented(w, '  - ', '    '));
  }
  out.write('\nType your passphrase to approve this exact action. Nothing you type is shown.\n');

  let opened = null;
  for (let i = 0; i < PASSPHRASE_TRIES && !opened; i += 1) {
    let passphrase;
    try {
      passphrase = await readSecret({ terminal, question: 'Passphrase: ' });
    } catch (e) {
      refuse(e?.code === 'ABORTED' ? 'aborted' : 'the terminal failed');
      throw e;
    }
    try {
      opened = openVault(vault, passphrase);
    } catch (e) {
      if (e?.code !== 'BAD_PASSPHRASE') {
        refuse('the vault could not be opened');
        throw e;
      }
      out.write('That passphrase did not open the vault.\n');
    } finally {
      passphrase = null;
    }
  }
  if (!opened) {
    refuse('wrong passphrase');
    throw new RiverwrightError('UNLOCK_REFUSED', `the passphrase did not open the vault after ${PASSPHRASE_TRIES} tries; nothing was published`);
  }

  let token = opened.token;
  let privateKey = opened.privateKey;
  opened = null;
  const changed = () => new RiverwrightError('PAYLOAD_CHANGED', 'what would be published changed after it was shown to you; nothing more was published. Run the command again.');
  try {
    let current;
    try {
      current = await recompute();
    } catch (e) {
      refuse('the payload could not be recomputed');
      throw redact(e, token);
    }
    if (!same(current, bound)) {
      refuse('payload changed');
      throw changed();
    }

    const written = appendReceipt({ ledgerDir, privateKey, gate, run, binding: bound, branch: onBranch, at: now() });
    privateKey = null;
    const receipt = deepFreeze(structuredClone(written.record.data.receipt));

    let result;
    let failed = false;
    let failure;
    let attempt = 0;
    try {
      saveState(runDir, recordApproval(loadState(runDir), { gate, binding: bound, mode: 'unlock', host, now: now(), branch: onBranch ?? undefined }));
      const started = clock();
      for (;;) {
        attempt += 1;
        try {
          result = await action({ token, receipt, attempt });
          break;
        } catch (e) {
          const wait = RETRY.backoffMs[attempt - 1];
          const canRetry = e?.transient === true && attempt < RETRY.attempts && wait !== undefined && clock() - started + wait <= RETRY.windowMs;
          if (!canRetry) throw e;
          await sleep(wait);
          if (!same(await recompute(), bound)) throw changed();
        }
      }
    } catch (e) {
      failed = true;
      failure = e;
    }

    // Recorded once, after the last attempt. A failure to record it never turns a success into a failure.
    let outcomeError = null;
    try {
      markConsumed({ ledgerDir, nonce: receipt.nonce, outcome: failed ? 'failed' : 'succeeded', at: now() });
    } catch (e) {
      outcomeError = e;
    }

    if (failed) {
      const err = redact(failure, token);
      if (outcomeError && err && typeof err === 'object') {
        try { err.outcomeError = outcomeError; } catch { /* frozen: the action error still wins */ }
      }
      throw err;
    }
    if (outcomeError) {
      out.write(`\nThe action finished, but Riverwright could not record that its receipt was used (${printable(outcomeError.message)}). Check the ledger with "riverwright ledger verify".\n`);
    }
    return { result, receipt, attempts: attempt, outcomeRecorded: outcomeError === null };
  } finally {
    token = null;
    privateKey = null;
  }
}
