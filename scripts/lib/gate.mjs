// The collapsed public gate (ADR-0010, core spec §6 and §7.5): show the payload, unlock with the passphrase,
// sign a receipt, run the action with the token, retry a transient failure a few times in this same process,
// then record the receipt's outcome. Plan 2b's `submit` and `post` are thin callers of runPublicAction.
//
// What holds:
// - No terminal, or a terminal that would echo, means nothing is shown, released or written.
// - The binding (a commit SHA or a content hash) is what the receipt signs. The summary the human reads is
//   display only; recompute() must return the same binding after the unlock and before every retry.
// - The token and the private key live only in this call's memory, and the references are dropped when it
//   returns. Nothing is cached across runs, so a run that exits needs a new unlock. A record in state.json or an
//   earlier receipt never stands in for the passphrase.
// - Memory hygiene is best effort. JS strings (the passphrase, the token) and KeyObjects cannot be zeroed: only
//   the references are dropped, and the bytes stay in the heap until the garbage collector reuses them. The
//   passphrase also lives on in readSecret's closure, and anything typed after it stays in the caller-owned
//   terminal.pending (tty.mjs). The action must not put the token in argv or a file, may pass it to one child's
//   environment (ADR-0010 residual risk), and must not keep it after it returns.
// - The retry limits are constants here, not settings an agent could change.
// - Text shown in the terminal goes through printable.mjs (R11): the summary and warnings carry upstream text.
//
// Receipt order: the `approved` event is written before the action and stays unused while it runs, because the
// pre-push guard checks for a signed, unused receipt during `git push` (spec §7.1). The final outcome
// (succeeded or failed) is recorded once, afterwards. A crash during the action therefore leaves the receipt
// unused until it expires (10 minutes), bound to the exact SHA and branch: the same residual risk ADR-0010
// states for the tail of the ledger.
import util from 'node:util';
import { RiverwrightError } from './errors.mjs';
import { openVault, readVault } from './vault.mjs';
import { canHideInput, noEchoControl, readSecret } from './tty.mjs';
import { PUBLIC_GATES, appendReceipt, markConsumed } from './receipt.mjs';
import { appendEvent, ledgerDirFor } from './ledger.mjs';
import { loadState, saveState } from './state.mjs';
import { assertHost } from './hosts.mjs';
import { checkBinding, normalizeBranch, recordApproval } from './approvals.mjs';
import { printable, printableLines, shown } from './printable.mjs';

export const RETRY = Object.freeze({ attempts: 3, windowMs: 120_000, backoffMs: Object.freeze([2000, 5000]) });
const PASSPHRASE_TRIES = 3;
const REDACTED = '[redacted]';

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
//
// The gate never rethrows what the action (or recompute) threw. It builds a new RiverwrightError from a short
// allowlist of fields, each read once as an own data property, so no getter, Proxy trap, toString, toJSON or
// util.inspect.custom on the original runs, and nothing else it holds (Map, Set, URL, Headers, symbol keys,
// boxed strings, functions) is carried over. Every kept string is scrubbed of the token's raw, URL-encoded,
// base64 and base64url forms, and of any base64-looking run that decodes to bytes holding it (an HTTP Basic
// header, at any alignment). Then everything is checked again. If any form survives, or reading the error
// throws, the error becomes the generic message, with nothing else attached (fail closed).
//
// Redaction cannot find a token split across two fields, or encoded some other way. The action contract
// (Plan 2b) is: never put the token in error text, argv or a file; it may go to one child's environment.

const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const B64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const CAUSE_DEPTH = 10;
const CAUSE_COUNT = 20;
const TEXT_MAX = 8192;
// The built-in accessors, captured before any action runs: an Error's `stack` getter (an own accessor on every
// Error in current V8) and the typed-array internals. Only these are ever called, never one the error defines.
const NATIVE_STACK_GET = Object.getOwnPropertyDescriptor(new Error('probe'), 'stack')?.get;
const TYPED = Object.getPrototypeOf(Uint8Array.prototype);
const typedGet = (name) => Object.getOwnPropertyDescriptor(TYPED, name).get;
const [TA_BUFFER, TA_OFFSET, TA_LENGTH] = ['buffer', 'byteOffset', 'byteLength'].map(typedGet);
const isTypedArray = (v) => { try { TA_LENGTH.call(v); return true; } catch { return false; } };

const formsOf = (token) => [...new Set([token, encodeURIComponent(token), Buffer.from(token).toString('base64'), Buffer.from(token).toString('base64url'), Buffer.from(token).toString('base64').replace(/=+$/, '')])].filter((f) => f.length > 0);
const holdsForm = (text, forms) => forms.some((f) => text.includes(f));
// A base64 (or base64url) run that decodes, at any of the four character alignments, to bytes holding a form.
const runHides = (run, forms) => {
  for (let k = 0; k < 4; k += 1) if (holdsForm(Buffer.from(run.slice(k), 'base64').toString('latin1'), forms)) return true;
  return false;
};
const hides = (text, forms) => holdsForm(text, forms) || [...text.matchAll(B64_RUN)].some(([run]) => runHides(run, forms));
const scrub = (text, forms) => forms.reduce((t, f) => t.split(f).join(REDACTED), text).replace(B64_RUN, (run) => (runHides(run, forms) ? REDACTED : run));
const cut = (text) => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}... [cut]` : text);

class Unclean extends Error {}

// Reads an own data property; an accessor is never called. A Proxy is refused before this is reached.
function own(o, key) {
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d && 'value' in d ? d.value : undefined;
}
// `stack` is an own accessor on a real Error; its built-in getter only formats the frames V8 captured.
function ownStack(o) {
  const d = Object.getOwnPropertyDescriptor(o, 'stack');
  if (!d) return undefined;
  if ('value' in d) return d.value;
  return d.get !== undefined && d.get === NATIVE_STACK_GET ? d.get.call(o) : undefined;
}
const isObj = (v) => v !== null && (typeof v === 'object' || typeof v === 'function');

function cleanText(value, forms) {
  let text;
  if (typeof value === 'string') text = value;
  else if (isObj(value) && !util.types.isProxy(value) && isTypedArray(value)) {
    const bytes = Buffer.from(TA_BUFFER.call(value), TA_OFFSET.call(value), TA_LENGTH.call(value));
    text = bytes.toString('utf8');
    // Belt and braces: the byte-exact decoding must not hold a form the UTF-8 text hides.
    if (hides(bytes.toString('latin1'), forms) && !hides(text, forms)) throw new Unclean();
  } else return undefined;
  // R11: what is kept is upstream text (a remote's stderr, an API message), so it cannot drive a terminal.
  const clean = printableLines(scrub(text, forms));
  if (hides(clean, forms)) throw new Unclean();
  return cut(clean);
}

// The message of one entry in the cause chain: a string, or an object's own string `message`.
function messageOf(v, forms) {
  if (typeof v === 'string') return cleanText(v, forms);
  if (!isObj(v)) return undefined;
  if (util.types.isProxy(v)) throw new Unclean();
  return cleanText(own(v, 'message'), forms);
}

// The cause chain and AggregateError `errors`, breadth first, as plain strings, to a fixed depth and count.
function causesOf(root, forms) {
  const causes = [];
  const seen = new Set([root]);
  let level = [root];
  for (let depth = 0; depth < CAUSE_DEPTH && level.length && causes.length < CAUSE_COUNT; depth += 1) {
    const next = [];
    for (const o of level) {
      if (!isObj(o)) continue;
      if (util.types.isProxy(o)) throw new Unclean();
      const children = [];
      const cause = own(o, 'cause');
      if (cause !== undefined) children.push(cause);
      const errors = own(o, 'errors');
      if (Array.isArray(errors) && !util.types.isProxy(errors)) {
        const n = Math.min(own(errors, 'length') ?? 0, CAUSE_COUNT);
        for (let i = 0; i < n; i += 1) children.push(own(errors, String(i)));
      }
      for (const c of children) {
        if (seen.has(c) || causes.length >= CAUSE_COUNT) continue;
        seen.add(c);
        const m = messageOf(c, forms);
        if (m !== undefined) causes.push(m);
        next.push(c);
      }
    }
    level = next;
  }
  return causes;
}

// A transient failure is classified from the original, before it is cleaned. A throwing getter means "not
// transient", never a broken gate.
function isTransient(e) {
  try { return e?.transient === true; } catch { return false; }
}

// code: ACTION_FAILED, RECOMPUTE_FAILED or ACTION_TIMEOUT. `what` prefixes the message.
function sanitize(error, token, { code, what, transient = false }) {
  const generic = () => new RiverwrightError(code, `${what}; its error is not shown because it could not be cleaned`, transient ? { transient } : {});
  if (typeof token !== 'string' || !token) return generic();
  const forms = formsOf(token);
  let built;
  try {
    const details = {};
    let message;
    if (typeof error === 'string') message = cleanText(error, forms);
    else if (isObj(error)) {
      if (util.types.isProxy(error)) return generic();
      message = cleanText(own(error, 'message'), forms);
      const errCode = own(error, 'code');
      if (typeof errCode === 'string' && SAFE_CODE.test(errCode)) details.code = errCode;
      const status = own(error, 'status');
      if (Number.isInteger(status)) details.status = status;
      const stack = cleanText(ownStack(error), forms);
      if (stack !== undefined) details.stack = stack;
      for (const key of ['stderr', 'stdout']) {
        const text = cleanText(own(error, key), forms);
        if (text !== undefined) details[key] = text;
      }
      const causes = causesOf(error, forms);
      if (causes.length) details.causes = causes;
    }
    if (transient) details.transient = true;
    built = new RiverwrightError(code, message ? `${what}: ${message}` : what, details);
    // The final check, on the new error as a caller would print it.
    const views = [built.message, String(built.stack), JSON.stringify(built), JSON.stringify(built.details)];
    if (views.some((v) => hides(v, forms))) return generic();
  } catch {
    return generic();
  }
  return built;
}

// ---- The gate ----

// runPublicAction({ home, runDir, gate, run, binding, branch?, host?, terminal, summary, warnings?, now, clock?,
//   sleep?, recompute, action }) => { result, receipt, attempts, outcomeRecorded }
//
// action({ token, receipt, attempt, signal, deadline }) does the public thing. It throws an error with
// `transient === true` for a network error, a 5xx or a rate limit; anything else is final. `signal` aborts when
// the two-minute retry window ends (`deadline`, in clock() milliseconds), and the action should pass it to its
// network calls: the gate does not abandon an attempt that ignores it, because a publish that finishes after
// the gate gave up would be recorded wrongly. Nothing thrown after the unlock is rethrown as is: see sanitize().
// recompute() returns the payload's binding as it is now (a commit SHA or a content hash, from the live
// repository or the normalized text). The caller owns the terminal ({ input, output }) and closes it.
export async function runPublicAction({ home, runDir, gate, run, binding, branch = null, host = null, terminal, summary, warnings = [], now, clock = Date.now, sleep = defaultSleep, recompute, action }) {
  // Everything that can be checked without the human is checked before anything is shown or written.
  if (!PUBLIC_GATES.includes(gate)) throw new RiverwrightError('NOT_PUBLIC_GATE', `${shown(gate)} is not a public gate (${PUBLIC_GATES.join(', ')})`);
  const bound = checkBinding(binding);
  if (typeof run !== 'string' || !run) throw new RiverwrightError('BAD_CALL', 'a public action names its run');
  assertHost(host);
  const onBranch = gate === 'submit-gate' ? normalizeBranch(branch) : null;
  if (gate !== 'submit-gate' && branch !== null) throw new RiverwrightError('BAD_CALL', 'only the submit gate names a branch');
  checkLines(summary, { label: 'the summary', required: true });
  checkLines(warnings, { label: 'the warnings', required: false });
  for (const [name, fn] of [['now', now], ['clock', clock], ['sleep', sleep], ['recompute', recompute], ['action', action]]) {
    if (typeof fn !== 'function') throw new RiverwrightError('BAD_CALL', `runPublicAction needs ${name} to be a function`);
  }
  // The run must exist and be the run named, before a passphrase can be spent on it.
  const { runId } = loadState(runDir);
  if (runId !== run) throw new RiverwrightError('RUN_MISMATCH', `the run ${shown(run)} is not the run in this run directory (${shown(runId)}); nothing was shown or signed`);
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
      throw sanitize(e, token, { code: 'RECOMPUTE_FAILED', what: 'the payload could not be recomputed' });
    }
    if (!same(current, bound)) {
      refuse('payload changed');
      throw changed();
    }

    const written = appendReceipt({ ledgerDir, privateKey, gate, run, binding: bound, branch: onBranch, at: now() });
    privateKey = null;
    const receipt = deepFreeze(structuredClone(written.record.data.receipt));

    let result;
    let failure = null;
    let attempt = 0;
    try {
      saveState(runDir, recordApproval(loadState(runDir), { gate, binding: bound, mode: 'unlock', host, now: now(), branch: onBranch ?? undefined }));
      const started = clock();
      const deadline = started + RETRY.windowMs;
      for (;;) {
        attempt += 1;
        // Each attempt counts against the window: its signal fires when the window ends.
        const signal = AbortSignal.timeout(Math.max(0, deadline - clock()));
        try {
          result = await action({ token, receipt, attempt, signal, deadline });
          break;
        } catch (e) {
          // Classified from the original, then cleaned at once: the raw error is not kept.
          const transient = isTransient(e);
          if (signal.aborted) {
            failure = sanitize(e, token, { code: 'ACTION_TIMEOUT', what: 'the action did not finish before the two-minute window ended', transient });
            break;
          }
          const wait = RETRY.backoffMs[attempt - 1];
          const canRetry = transient && attempt < RETRY.attempts && wait !== undefined && clock() - started + wait <= RETRY.windowMs;
          if (!canRetry) {
            failure = sanitize(e, token, { code: 'ACTION_FAILED', what: 'the action failed', transient });
            break;
          }
        }
        await sleep(RETRY.backoffMs[attempt - 1]);
        let again;
        try {
          again = await recompute();
        } catch (e) {
          failure = sanitize(e, token, { code: 'RECOMPUTE_FAILED', what: 'the payload could not be recomputed' });
          break;
        }
        if (!same(again, bound)) {
          failure = changed();
          break;
        }
      }
    } catch (e) {
      // The gate's own steps (saving the approval record) and the caller's clock and sleep. Cleaned all the same.
      failure = sanitize(e, token, { code: 'ACTION_FAILED', what: 'the public action stopped' });
    }
    const failed = failure !== null;

    // Recorded once, after the last attempt. A failure to record it never turns a success into a failure.
    let outcomeError = null;
    try {
      markConsumed({ ledgerDir, nonce: receipt.nonce, outcome: failed ? 'failed' : 'succeeded', at: now() });
    } catch (e) {
      outcomeError = e;
    }

    if (failed) {
      // `failure` is always an error the gate built, so the ledger error can be attached to it.
      if (outcomeError) failure.outcomeError = outcomeError;
      throw failure;
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
