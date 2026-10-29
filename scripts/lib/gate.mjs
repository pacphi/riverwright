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
// boxed strings, functions) is carried over.
//
// Raw bytes are never kept (ruling R13). A Buffer, typed array, DataView, ArrayBuffer or SharedArrayBuffer found
// anywhere the walk reaches (the message, stack, stderr, stdout, a cause, an AggregateError entry, or the thrown
// value itself) becomes the fixed text "[N bytes omitted]" and is never decoded. So no encoding of the bytes
// (UTF-16, UTF-32, hex or base64 inside them) can carry the token out, and none has to be checked.
//
// Only strings are kept. Each is scrubbed of the token's raw, URL-encoded, base64, base64url and hex (lower or
// upper case, plain or spaced) forms, of every 16-character piece of the raw token, and of any base64 or hex run
// that decodes to bytes holding one. Then it is checked again, as is and with every white space, control and
// format character taken out: the NULs of UTF-16 or UTF-32 text read as UTF-8, a zero-width space, a line wrap.
// A form found only that way cannot be scrubbed in place. If any form survives, or reading the error throws, the
// error becomes the generic message, with nothing else attached (fail closed).
//
// Accepted limits. The action contract (Plan 2b) is what covers them: never put the token in error text, argv or
// a file; it may go to one child's environment.
// - A token cut into pieces shorter than 16 characters, spread across fields or down the cause chain.
// - A printable or combining character (not a space, control or format character) inside the token.
// - A deliberately obfuscated token: a list of decimal bytes, "0x" or "\x" before each byte, reversed or
//   doubled characters, or the token's bytes misread in another encoding (UTF-8 read as UTF-16 shows as CJK).
// - Raw byte buffers are omitted by design: a tool that writes its stderr as bytes loses that detail here.

const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const B64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const HEX_RUN = /[0-9A-Fa-f]{32,}/g;
const SQUEEZE = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const CAUSE_DEPTH = 10;
const CAUSE_COUNT = 20;
const TEXT_MAX = 8192;
// The built-in accessors, captured before any action runs: an Error's `stack` getter (an own accessor on every
// Error in current V8) and the byte lengths of the byte containers. Only these are ever called, never one the
// error defines.
const NATIVE_STACK_GET = Object.getOwnPropertyDescriptor(new Error('probe'), 'stack')?.get;
const lengthGetter = (proto) => Object.getOwnPropertyDescriptor(proto, 'byteLength').get;
const BYTE_LENGTH = [
  [util.types.isTypedArray, lengthGetter(Object.getPrototypeOf(Uint8Array.prototype))],
  [util.types.isDataView, lengthGetter(DataView.prototype)],
  [util.types.isArrayBuffer, lengthGetter(ArrayBuffer.prototype)],
  [util.types.isSharedArrayBuffer, lengthGetter(SharedArrayBuffer.prototype)],
];

// The forms: `full` are whole-token encodings (raw, URL-encoded, base64, base64url, hex in either case, and the
// spaced hex that util.inspect(Buffer) prints). `windows` are the 16-character pieces of the raw token, so each
// half of a split token and a cut-off token match too. A false hit on a 16-character piece of a random token is
// negligible.
const WINDOW = 16;
function formsOf(token) {
  const raw = Buffer.from(token);
  const hex = raw.toString('hex');
  const spaced = hex.replace(/(..)/g, '$1 ').trim();
  const full = [...new Set([token, encodeURIComponent(token), raw.toString('base64'), raw.toString('base64url'), raw.toString('base64').replace(/=+$/, ''), hex, spaced, hex.toUpperCase(), spaced.toUpperCase()])].filter((f) => f.length > 0).sort((a, b) => b.length - a.length);
  const windows = [];
  for (let i = 0; token.length > WINDOW && i + WINDOW <= token.length; i += 1) windows.push(token.slice(i, i + WINDOW));
  // The spaced hex holds spaces, so squeezing turns it into the plain hex; it is taken out before that check.
  return { full, all: [...full, ...new Set(windows)], spaced: full.filter((f) => f.replace(SQUEEZE, '') !== f) };
}
const holdsForm = (text, list) => list.some((f) => text.includes(f));
// A base64 (or base64url) run that decodes, at any of the four character alignments, to bytes holding a form.
const runHides = (run, forms) => {
  for (let k = 0; k < 4; k += 1) if (holdsForm(Buffer.from(run.slice(k), 'base64').toString('latin1'), forms.full)) return true;
  return false;
};
// A hex run (either case) that decodes, at either character alignment, to bytes holding a form or a piece of one.
const hexRunHides = (run, forms) => holdsForm(Buffer.from(run, 'hex').toString('latin1'), forms.all) || holdsForm(Buffer.from(run.slice(1), 'hex').toString('latin1'), forms.all);
const hidesIn = (text, forms) => holdsForm(text, forms.all)
  || [...text.matchAll(B64_RUN)].some(([run]) => runHides(run, forms))
  || [...text.matchAll(HEX_RUN)].some(([run]) => hexRunHides(run, forms));
// Also with every space, control and format character taken out, so a token or a run wrapped across lines, or
// with NULs between its characters (UTF-16 or UTF-32 text read as UTF-8), is found.
const hides = (text, forms) => {
  if (hidesIn(text, forms)) return true;
  const squeezed = text.replace(SQUEEZE, '');
  return squeezed !== text && hidesIn(squeezed, forms);
};
// Every character covered by any form or piece is redacted, overlapping matches merged into one "[redacted]", so
// a piece of 16 characters or more is removed whole, not cut down to a tail of up to 15.
function scrubForms(text, list) {
  let covered = null;
  for (const f of list) {
    let end = 0;
    for (let i = text.indexOf(f); i !== -1; i = text.indexOf(f, i + 1)) {
      covered ??= new Uint8Array(text.length);
      covered.fill(1, Math.max(i, end), i + f.length);
      end = i + f.length;
    }
  }
  if (covered === null) return text;
  let out = '';
  for (let i = 0; i < text.length;) {
    const stop = covered.indexOf(covered[i] ? 0 : 1, i);
    const next = stop === -1 ? text.length : stop;
    out += covered[i] ? REDACTED : text.slice(i, next);
    i = next;
  }
  return out;
}
const scrub = (text, forms) => scrubForms(text, forms.all)
  .replace(B64_RUN, (run) => (runHides(run, forms) ? REDACTED : run))
  .replace(HEX_RUN, (run) => (hexRunHides(run, forms) ? REDACTED : run));
// Overlapping occurrences of `f` in `text`.
const count = (text, f) => { let n = 0; for (let i = text.indexOf(f); i !== -1; i = text.indexOf(f, i + 1)) n += 1; return n; };
// A form that appears only once space, control and format characters are taken out spans one of them, so it
// cannot be scrubbed in place. Once the spaced hex is redacted, no form holds such a character, so squeezing keeps
// every occurrence the text already had, and any extra one crosses a removed character.
const crossesSqueezed = (text, forms) => {
  const base = scrubForms(text, forms.spaced);
  const squeezed = base.replace(SQUEEZE, '');
  return squeezed !== base && forms.all.some((f) => squeezed.includes(f) && count(squeezed, f) > count(base, f));
};
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

// R13: a byte container is named by its size and never read. util.types checks the internal type, so no code the
// error defines runs; a Proxy is not a byte container here (it is dropped or refused by the caller).
function bytesNote(v) {
  if (!isObj(v) || util.types.isProxy(v)) return undefined;
  for (const [is, length] of BYTE_LENGTH) if (is(v)) return `[${length.call(v)} bytes omitted]`;
  return undefined;
}

function cleanText(value, forms) {
  const note = bytesNote(value);
  if (note !== undefined) return note;
  if (typeof value !== 'string') return undefined;
  if (crossesSqueezed(value, forms)) throw new Unclean();
  const scrubbed = scrub(value, forms);
  // Checked before terminal cleaning too, which turns a NUL or a zero-width space into "?" and would hide the
  // token from the squeezed check.
  if (hides(scrubbed, forms)) throw new Unclean();
  // R11: what is kept is upstream text (a remote's stderr, an API message), so it cannot drive a terminal.
  const clean = printableLines(scrubbed);
  // Again when terminal cleaning changed something: a "?" put in place of a control can complete a token holding "?".
  if (clean !== scrubbed && hides(clean, forms)) throw new Unclean();
  return cut(clean);
}

// The message of one entry in the cause chain: a string, a byte container's note, or an object's own `message`.
function messageOf(v, forms) {
  if (typeof v === 'string') return cleanText(v, forms);
  if (!isObj(v)) return undefined;
  if (util.types.isProxy(v)) throw new Unclean();
  return bytesNote(v) ?? cleanText(own(v, 'message'), forms);
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
// `stack` is pinned as a plain data value, so a global Error.prepareStackTrace hook cannot format it later.
const pinStack = (e, text) => Object.defineProperty(e, 'stack', { value: text, writable: true, configurable: true, enumerable: false });
function sanitize(error, token, { code, what, transient = false }) {
  const generic = () => {
    const e = new RiverwrightError(code, `${what}; its error is not shown because it could not be cleaned`, transient ? { transient } : {});
    return pinStack(e, `${e.name}: ${e.message}`);
  };
  if (typeof token !== 'string' || !token) return generic();
  const forms = formsOf(token);
  let built;
  try {
    const details = {};
    let message;
    if (typeof error === 'string' || bytesNote(error) !== undefined) message = cleanText(error, forms);
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
    const stack = String(built.stack);
    const views = [built.message, stack, JSON.stringify(built), JSON.stringify(built.details)];
    if (views.some((v) => hides(v, forms))) return generic();
    pinStack(built, stack);
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
        // The window is checked just before every attempt, whatever the sleep and the recompute spent.
        if (clock() >= deadline) {
          failure = new RiverwrightError('ACTION_TIMEOUT', `the two-minute window ended before attempt ${attempt} could start; it was not started`);
          break;
        }
        // Each attempt counts against the window: its signal fires when the window ends.
        const signal = AbortSignal.timeout(Math.max(0, deadline - clock()));
        try {
          result = await action({ token, receipt, attempt, signal, deadline });
          break;
        } catch (e) {
          // Classified from the original, then cleaned at once: the raw error is not kept.
          const transient = isTransient(e);
          if (signal.aborted) {
            failure = sanitize(e, token, { code: 'ACTION_TIMEOUT', what: 'the action did not finish before the two-minute window ended; it may already have been published; check before you run it again', transient });
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
