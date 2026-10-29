# Task 7 report: the collapsed public gate (`runPublicAction`)

Status: DONE_WITH_CONCERNS

Branch `plan-2a-security`, base f13135e.

| Commit | What |
|---|---|
| fea94df | fix(security): let a claimed receipt record its final outcome exactly once (P1) |
| a7cd20b | feat(security): the public gate, an unlock that signs a receipt and bounds its retries |

Tests: `node --test`: 642 tests, 635 pass, 0 fail, 7 skipped (baseline 601 / 594 / 7; +41 tests: 6 receipt,
31 gate, 3 approvals, 1 state-cli). Test-first, stated exactly: gate.test.mjs failed to load (ERR_MODULE_NOT_FOUND)
and the new approvals tests failed on the missing exports. Of the 6 new receipt tests, 3 failed on the old code:
claimed then succeeded, claimed then failed, and the locked final. The other 3 describe behaviour that already
held and now guard it. The approve-CLI test passed at first. It started failing once `unlock` was added to
APPROVAL_MODES, which is how the CLI hole below was found, and it passes with the CLI fix.

## Files

- `scripts/lib/gate.mjs` (new): `RETRY`, `runPublicAction`.
- `scripts/lib/receipt.mjs`: P1 fix in `markConsumed`, plus the state machine in the module header.
- `scripts/lib/approvals.mjs`: `APPROVAL_MODES = ['host-ask','tty','unlock']`, `checkBinding`,
  `recordApproval({ binding })`. `unlock` is accepted only for the three public gates; passing a binding plus
  sha/content is refused.
- `scripts/lib/commands/approve.mjs`: `riverwright approve --mode unlock` is refused (see concern 2).
- `scripts/lib/tty.mjs`: exports `canHideInput(terminal)` and `noEchoControl()`; `readSecret` uses them (no
  behaviour change).
- Tests: `tests/gate.test.mjs` (new), `tests/receipt.test.mjs`, `tests/approvals.test.mjs`,
  `tests/state-cli.test.mjs`.

## Carried-over items

1. **P1 (claimed receipt can't record its outcome).** Fixed in receipt.mjs. The states are: unused, claimed,
   final. unused goes to claimed (consumeReceipt) or straight to final; claimed goes to final once
   (markConsumed succeeded|failed); final allows nothing more. A claimed receipt already counts as used.
   Any stray or unknown consumption line also counts as used and blocks any outcome. The lock, the anchoring
   and the append-only behaviour are unchanged, and all the existing receipt tests stay green. New tests:
   claimed then succeeded; claimed then failed; a claim can't be claimed again; a direct final is final; the
   final is written under the lock (LEDGER_BUSY); a stray line blocks the outcome.
2. **R11.** The summary and warnings go through `printableLines`, and every line inside an entry is
   indented, so upstream text with `\n` can't print an unindented line that looks like Riverwright's own.
   `run` goes through `printable`, the gate in an error through `shown`, and the outcome-record failure
   message through `printable`. The binding and branch are checked values (hex, normalized branch). The
   receipt binds `binding`, never the displayed text. The human also sees one line, "Your passphrase signs a
   receipt for this exact commit <sha> on <branch>", so they see what is signed.
3. **R9.** Not made worse. The gate writes one consumption line, as before. The receipt module's
   claimed-then-final pair only adds lines, so dropping the tail final line leaves "claimed", which still
   counts as used.
4. **Windows/CI (R4).** All terminal tests use the injected `fakeSecretTerminal` (`noEcho`) and
   `fakeTerminal`. Not covered: real `setRawMode` on a tty, real `/dev/tty` or `CONIN$`, how long the
   passphrase and token strings stay in memory (JS can't zero a string; we only drop references), and a
   real network or publisher (every action is an injected fake).
   Hazard: a test that uses `fakeSecretTerminal([])` must call `input.end()` (or end it with a key). If it
   doesn't, `readSecret` waits forever, and plain `node --test` (no `--test-timeout`) hangs instead of
   failing. This happened once during this task.

## ADR-0010 Verification coverage (gate.test.mjs)

| Required | Test |
|---|---|
| A forged approval file does not release the credential | "a forged approval already in state.json..."; "a forged unlock approval in state.json, or a valid unused receipt already in the ledger, does not skip the passphrase" |
| A payload changed after display is rejected | "...changed between the summary and the unlock is refused before any receipt exists"; "...changes while retrying stops the retry"; "...cannot be recomputed..." |
| No terminal means no action | "no terminal means no action" (undefined, null, {}); "a terminal that would echo..." (NO_ECHO_CONTROL, nothing shown or written); "the terminal closing before a passphrase..." |
| A wrong passphrase releases nothing | "a wrong passphrase gets three tries in all..." |
| Secrets never in output, ledger or errors | "the terminal shows the payload... never the token or the passphrase"; "the passphrase and the token never reach the ledger or state.json"; three redaction tests |
| Ledger head detects rewrite/truncation; doctor never prints a value | Covered by Tasks 3 and 5 (receipt.test.mjs, ambient tests), not this task |

Mutation check: 10 hand mutations of gate.mjs, each caught by at least one test. They removed printableLines,
the inner-line indent, the pre-receipt recompute check, the recompute on retry, redaction, nested redaction
and the echo pre-check; made any error retryable; ignored the window; and recorded success as failed.

## Deviations from the brief (and why)

- **Brief tests:** `findValidReceipt` now needs `binding` (Task 3 M6), so the tests pass it.
- **Outcome-record failure:** the brief's code calls `consume('succeeded')` inside the `try`, so if the
  ledger write failed after a successful publish, the catch recorded "failed" and threw. A caller could then
  retry and publish twice. Now: after a success, a failed outcome write is reported on the terminal and the
  call returns `outcomeRecorded: false`. After a failure, the action's (redacted) error is still thrown, with
  the ledger error attached as `err.outcomeError`. The return value gains `outcomeRecorded`.
- **Inputs checked before anything is shown or written:** binding (BAD_BINDING), run, branch (normalized for
  submit-gate, refused for the others), a non-empty `summary: string[]` and `warnings: string[]`
  (BAD_SUMMARY), and the callbacks (BAD_CALL). Then the terminal (NO_TTY / NO_ECHO_CONTROL), then the vault
  (NO_VAULT).
- **Redaction** goes further than message/stack: it walks the cause, `errors`, `stderr` and nested plain
  objects (depth 4, data properties only, plus an Error's `stack`), and removes the raw and URL-encoded
  token. A frozen or read-only field that holds the token makes the whole error get replaced
  (ACTION_FAILED). A thrown string is scrubbed.
- **Other refusals are recorded too:** a terminal failure, a vault that can't be opened, and a payload that
  can't be recomputed each write `unlock-refused`. Recording is best-effort, so a ledger error can't hide
  why the action stopped.
- **Hand-offs:** the action gets a frozen copy of the receipt, and the private key is dropped right after
  signing.

## Concerns

1. **Claim-first vs. the pre-push guard (owner decision for Task 8).** The gate does not claim the receipt
   before the action. It follows the brief and the spec: §7.5 step 6 consumes after the action, and §7.1 says
   the guard checks for a signed, *unconsumed* receipt during `git push`. Claiming first would make the Task 8
   guard (it calls `findValidReceipt`, and any consumption line counts as used) block our own push.
   Consequence: if the process crashes during the action, the receipt stays unused until it expires (10
   minutes), bound to the exact SHA and branch. This is stated in the gate.mjs header. To move to
   claim-first later, the guard must accept a claimed but not yet final receipt. The P1 API now supports that
   flow.
2. **`approve --mode unlock` hole, closed.** Adding `unlock` to APPROVAL_MODES let `riverwright approve
   --mode unlock` write an unlock approval with no passphrase. The new state-cli test caught this. The CLI now
   refuses it. state.json is not consent, but the record would have claimed an unlock that never happened.
3. **The caller owns the terminal.** runPublicAction does not close it. Plan 2b's submit/post must close it
   in a `finally`.
4. **Redaction limits:** accessor properties other than `stack` are not read, objects deeper than 4 levels
   are not scanned, and only the raw and URL-encoded forms are removed (not base64, for example a Basic auth
   header). The action's *result* is not scrubbed. That is the caller's job.
5. **The lease task's gate.mjs diff (plan around lines 3930-3990) will not apply as written.** It patches the
   brief's reference code (`privateKey: opened.privateKey`, `const consume = ...`), which a7cd20b doesn't
   have. Re-derive it by hand: add `lease = null` to the `runPublicAction` signature and pass it to
   `appendReceipt`.
6. **`verifyReceipts`** (ledger verify) does not yet report consumption anomalies (a stray outcome, two
   finals). These are parked, not done here.

## Fix round 1

Commits: af7cdc4 and 76a6f04 (R11 follow-up), on a7cd20b. Files: `scripts/lib/gate.mjs`, `tests/gate.test.mjs`,
`tests/receipt.test.mjs`. Full suite: 697 tests, 690 pass, 0 fail, 7 skipped (baseline 642/635/7). Node
26.12.1, macOS only.

### I1: fail-closed error building

- The gate never rethrows what the action, recompute, or anything after the unlock threw. `sanitize()` builds
  a new `RiverwrightError` (`ACTION_FAILED`, `RECOMPUTE_FAILED`, or `ACTION_TIMEOUT`) whose `details` hold only
  `code` (kept only if it matches `/^[A-Z0-9_]{1,64}$/`), `status` (integer), `stack`, `stderr`, `stdout` (string
  or a decoded typed array), `causes` (the cause and `errors` chain, breadth first, as plain strings, depth 10,
  at most 20) and `transient`. The message is `"<what>: <cleaned message>"`.
- Every field is read once as an own data property. `stack` (an own accessor on every Error in Node 26) is
  read only through V8's built-in getter, captured at module load. Typed arrays are read through the
  intrinsic `%TypedArray%` getters. A Proxy anywhere gives the generic message. Map, Set, URL, Headers, boxed
  strings, symbols and other getters are dropped and never read.
- Scrubbing covers the raw, URL-encoded, base64 (with and without padding) and base64url forms. Base64-looking
  runs (`[A-Za-z0-9+/_-]{16,}={0,2}`) are decoded at all four alignments, and a run is redacted when its
  decoding holds a form. For bytes, the latin1 decoding must not hold a form that the UTF-8 text hides.
  Strings are cut to 8 KiB after scrubbing. The built error is checked again (message, stack, JSON, details).
  If anything is left, or reading throws, the result is the generic message:
  `the action failed; its error is not shown because it could not be cleaned`.
- `transient` is read from the original before cleaning, inside a try/catch.
- Tests: one test for each shape the task named (35 shapes). A getter-call counter (0 calls). A hostile Proxy
  and a revoked one give the generic message. Content that is useful is kept. A 6-deep cause chain is kept in
  full. Codes and status that are not safe are dropped. A long base64 run and a SHA are left alone. Long
  stderr is cut. Transient retries end with `details.transient`. The recompute path and the caller's sleep are
  covered. The test detector does its own base64 decode, so it is independent of the gate's. The three old
  assertions were rewritten to check the same intent against the new shape.
- Probe `t7/probe-redact.mjs`: 37 of 37 rows clean (it was 24 LEAK before). Residual, by design: a token
  split across two fields, or encoded another way (hex, MIME-wrapped base64), is not caught. V8's built-in
  stack getter can run `Error.prepareStackTrace` or a prototype `name` getter. Its output is scrubbed, and it
  runs inside the try/catch.

- R11 (second commit): every kept string goes through `printableLines` after scrubbing and before the
  re-check, so a remote's escape sequences in stderr, the message or a cause cannot drive a terminal. cli.mjs
  already cleans `err.message` when it renders it; this also covers `details`, which Plan 2b callers will print.

### I2 and M9

- I2: `recompute` returns A until the terminal shows `Passphrase`, then B. The run ends with PAYLOAD_CHANGED,
  only `unlock-refused`, no approval, and the action is never called. Mutation M1 (recompute before the
  display) is now killed.
- M9: `receipt.test.mjs` drops line 1, renumbers, and rebuilds the chain from genesis. The chain itself
  verifies, yet `findValidReceipt` and `verifyReceipts` both report "names seq 3 but sits at seq 2".

### Minors fixed

- M3/M4: `assertHost(host)`, `loadState(runDir)` and `runId === run` (new code `RUN_MISMATCH`) are checked
  before the terminal check, so nothing is shown, signed or written. Probe `t7/probe-host.mjs`: both cases now
  leave the ledger empty and the action is never called.
- M1/M2: a test reads `e.stack` before the throw, and a test for a custom stack string. A frozen-receipt test
  checks that writing to `receipt.nonce` throws and that the real nonce is consumed.
- M6: each attempt gets `signal` (`AbortSignal.timeout` until `deadline = started + 120 s`, in clock() ms) and
  `deadline`. An attempt that fails after its signal fired is `ACTION_TIMEOUT` and is not retried. The gate does
  not abandon an action that ignores the signal, because a publish that finishes after the gate gives up would
  be recorded wrongly. The module header says so.
- M7: the header states that memory hygiene is best effort. JS strings and KeyObjects cannot be zeroed. The
  passphrase stays in readSecret's closure and the text after it in `terminal.pending`. The action contract:
  the token never goes into argv or a file, may go to one child's environment, and is not kept.

### Mutation check (`t7/mutate2.py` against a copy of the repo)

Killed: recompute before display, no deepFreeze, stack not scrubbed, no base64 scan, alignment 0 only, no run
check, no early host check, cause depth 4, rethrow original, no signal, no timeout code, transient read after
cleaning. Survived (defence in depth, not reachable by a natural input): the Proxy refusal at the root (the
cause walk refuses a Proxy too), and the final re-check (scrubbing leaves nothing for it to find).

### Parked (not done in this round)

- M5: test the `outcomeRecorded: false` branch for LEDGER_BUSY or an I/O failure, and name the R12 class in the
  comment.
- M7, Task 2 scope: zero the passphrase and the derived-key Buffers in `deriveKey`.
- M8 (Plan 2b): (a) a non-idempotent retry can publish twice; (b) the submit-gate title and body are not
  bound; (c) soft wrap of long summary lines; (d) the `unlock` approval in state.json is never proof.
- M9 wording for Task 15 (ADR status: detects a rewrite and a truncation before the newest receipt, not the
  tail).
- Earlier concerns stand: `verifyReceipts` consumption anomalies, the Task 14 lease diff, the caller closing
  the terminal.

### Concerns

- The action signature gains `signal` and `deadline`, and failures now arrive as `ACTION_FAILED`,
  `RECOMPUTE_FAILED` or `ACTION_TIMEOUT` with the original code in `details.code`. Core spec §7.5 should say
  so (a docs change rule). It was not edited in this round.
- The M6 timeout test waits about 30 ms of real time, because `AbortSignal.timeout` uses real timers.

## Fix round 2

Commit: see `git log` (one commit after 76a6f04). Tests written first and seen failing (13 of the 16 new tests),
then fixed. Whole suite: 714 tests, 707 pass, 0 fail, 7 skipped (baseline 697 / 690 / 7).

- N1: `cleanText` also decodes Buffer and typed-array text as UTF-16LE, at both byte alignments (so BOM,
  no BOM and big-endian all land), and refuses (generic message) if any form is in it. Tests: four UTF-16LE
  cases and a `Uint16Array` view.
- N2: `clock() >= deadline` is checked right before every attempt. A late attempt is not started; the gate
  records `failed` and throws `ACTION_TIMEOUT` ("the two-minute window ended before attempt N could start").
  Tests: long sleep, long recompute (`probe-timing.mjs` cases 1 and 2 now stop).
- N3: the timeout message ends with "it may already have been published; check before you run it again".
- N4: `stack` is pinned as an own data value on the generic error (fixed text, never read from the hook) and on
  the built error (the string that was checked). Test installs `Error.prepareStackTrace` and restores it.
- N5: four tests added. Mutation run (`t7rr/mut4.py`): cut-before-scrub, rethrow of the recompute error, retry of
  a timed-out transient attempt, and the UTF-16 checks are killed. Two survive and are equivalent: removing the
  re-check in `cleanText` (the final view check in `sanitize` catches the same text), and not pinning the built
  error's stack (V8 caches the stack at the final check, which has already read it).
- N6: every 16-character window of the token is a form (catches each half of a split token and a cut-off token);
  hex and the spaced hex of `util.inspect(Buffer)` are forms; the check also runs on the text with white space
  removed, so wrapped base64 (any column) and a token broken by a newline fail closed. A base64 run of 12 MiB
  that overflows the regex stack gives the generic message (tested). Timing: 16 MiB of 16-character runs 1.9 s
  (was 1.3 s), 64 MiB 7.6 s (was 5.1 s).

Parked: Windows-style big-endian UTF-16 is covered only through the odd-alignment LE view; a token in a
non-ASCII, non-UTF encoding (for example UTF-32) is not checked; the two N5 equivalent mutants above; the
carried-forward items of the re-review (spec §7.5 text, Plan 2b indentation of `details`, `openVault` JSON.parse).
`pnpm lint:md` fails on `task-7-rereview-round1.md` (the reviewer's file, MD056 and MD038), not on this change.

## Fix round 3

Commit: 4538118 (one commit after 96d5836). Tests written first and seen failing (34 of the first batch, then 2
and 1 more as gaps showed up), then fixed. Whole suite: 754 tests, 747 pass, 0 fail, 7 skipped (baseline
714 / 707 / 7).

Claims probed first (`scratchpad/t7r3-claims.mjs`, fake token, no network). At 96d5836 all three leaked:
upper-case hex in the message, base64 of the token inside a UTF-16LE Buffer stderr (3b), and a NUL-interleaved
message (N7). After the fix all three are clean.

- R13: `bytesNote` names any Buffer, typed array, DataView, ArrayBuffer or SharedArrayBuffer by its size,
  `[N bytes omitted]`, wherever the walk reaches: the message, stack, stderr, stdout, a cause, an AggregateError
  entry, or the thrown value itself. The type check is `util.types` and the length comes from the built-in
  `byteLength` getters captured at load, so no getter or `toString` of the error runs (tested). A Proxy around
  bytes is dropped, as before. All byte decoding (UTF-8, latin1, UTF-16 at both alignments) is gone from
  `cleanText`, so 3b closes by construction: no decoded view remains to check. `transient` is still read from the
  original under try/catch. Tests changed to assert the note instead of a scrubbed decode: the I1 "what helps the
  human" test, the four N1 UTF-16LE tests (message now kept, stderr is the note) and the `Uint16Array` test. The
  R11 test now uses a string stderr, so it still checks terminal cleaning.
- N7: the squeeze is `[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]` (NUL, other controls, zero-width and format characters, not
  only white space). `cleanText` checks the scrubbed text before `printableLines`, because that turns a NUL into
  `?` and would hide the token from the squeezed check. A form that appears more often in the squeezed text than
  in the text (`crossesSqueezed`) spans a removed character and cannot be scrubbed in place, so the error becomes
  generic. That also closes "a control or zero-width character inside the token", which the round-2 re-review
  listed as accepted (the scrub used to cut around it and show 10 + 15 characters). Tests: NUL (UTF-16), three
  NULs (UTF-32), U+200B and U+0001 between characters, each in the message, a custom stack, a stderr string, a
  cause message and a thrown string; a NUL-interleaved half token; a NUL-interleaved Basic header; one control
  character inside the token; and ordinary text with a NUL or U+200B is still kept.
- 3a: the upper-case hex and upper-case spaced hex are forms, and `HEX_RUN` (`[0-9A-Fa-f]{32,}`) runs are
  decoded at both alignments and checked against every form and 16-character piece, like base64 runs. Tests:
  upper-case plain and spaced (as `util.inspect` prints, upper-cased), mixed case at even and odd alignment
  (scrubbed in place to `[redacted]`), half a token in hex, hex wrapped every 10 characters; a SHA, a run of
  `C` and a long upper-case hex blob are left alone.
- Also: scrubbing now merges overlapping matches of all forms and pieces into one `[redacted]`, so a piece of 16
  characters or more is removed whole. Before, the split/join left a tail of up to 15 characters of a cut-off or
  split token. Test: 31-, 31- and 35-character pieces are fully redacted.
- Header comment rewritten: R13, what strings go through, and the accepted limits (pieces under 16 characters
  across fields or causes; a printable or combining character inside the token; decimal byte lists, `0x`/`\x`
  per byte, reversed or doubled characters, bytes misread in another encoding such as UTF-8 read as UTF-16;
  raw byte buffers omitted by design).

Mutation check (`scratchpad/t7r3-mut.py`, 11 mutants, all killed): no crossing check, squeeze of `\s` only, no
check before terminal cleaning, no hex run scrub, hex alignment 0 only, no upper-case forms, split/join scrub,
bytes decoded as UTF-8 again, cause bytes not noted, DataView not covered, spaced hex not taken out before the
crossing check.

Probes re-run against 4538118: `t7/probe-redact.mjs` all clean; `t7rr/probe-r2`, `probe-r2b`, `probe-break`,
`probe-show`, `probe-hex`, `probe-timing` clean, except the known accepted case in `probe-r2` (token cut into
about 5-character pieces down a cause chain). In `probe-show` the control character and the zero-width space
inside the token are now generic (were `ghp_exampl?[redacted]56789abcdefghij`). UTF-16/UTF-32 byte cases now
report the omission note instead of the generic message: intended. False-positive probe (`probe-r2c`, against
4538118): legitimate URL, SHA, nonce and UUID text pass byte for byte; `code` and `status` survive.

Timing (`scratchpad/t7r3-perf1.mjs`, before -> after): 64 MiB of 16-character base64 runs 6.1 s -> 7.0 s;
64 MiB of words with spaces 3.5 s -> 4.7 s; 64 MiB byte buffers now milliseconds (not decoded). 64 MiB of one
hex run (not the token) is generic before and after (one huge run, as with base64), 0.1 s -> 0.2 s. 16 MiB of 15-character pieces separated by spaces was generic before and still is.

Concerns:

- A tool that writes stderr as bytes (`execFile` with `encoding: 'buffer'`) now gives only its size. Plan 2b
  callers that want stderr text should decode it themselves (as UTF-8) before throwing, so it takes the string
  path. Worth a line in core spec §7.5 (Task 15) next to the other action-contract notes.
- A real `Error` whose `message` was replaced by a Buffer is generic: V8 formats `stack` from the message, so the
  bytes come back as a NUL-interleaved string there, which the N7 check refuses. Fail closed, tested.
- `.superpowers/` is git-ignored, so this report is not in the commit.

## Fix round 4

Commits 92baf9c (fix and tests) and ff95cb3 (every container kind through the prototype getters) on
`plan-2a-security` (base 4538118). Tests were written first and seen to fail (18 N8 tests, the N9 and N10 tests,
the two M1 tests); the mutant tests pass on the base by design and were checked by the sweep below.
`node --test`: 781 tests, 774 pass, 0 fail, 7 skipped (baseline 754/747/7). `tests/gate.test.mjs`: 169/169.

- N8 (`frameLines`, `sanitize`): the original's stack header is never read. V8's own `stack` getter is called
  only while the gate's `Error.prepareStackTrace` (`framesOnly`) is in place, so a lazily formatted stack is
  the frames alone and V8 never reads `name` or `String(message)`. The global hook is put back (descriptor
  restored, or deleted when there was none) in a `finally`. A stack that was already formatted (the action read
  it, or assigned its own string) comes back as is, so only lines starting with `    at ` are kept. The shown
  stack is the gate's cleaned message over the cleaned frames; the message is not scanned twice. A
  byte-container stack is still the size note. Tests: Uint8Array, Int16Array of code units, Float64Array and a
  plain Array as own `message` and own `name`, with and without the stack read first (16 tests, no decimal list
  in any view); prototype `message` and `name` getters returning each of the four kinds, a subclass with poisoned `name`,
  `toString` and `Symbol.toPrimitive`, and a message object with a poisoned `toString` (0 calls); frames kept
  under the gate's message and a frame named after the token scrubbed; the hook restored whether or not one was
  set. Side effect: an original whose stack was not read yet caches the frames-only text; it is never rethrown.
- N9 and N10 (`bytesHide`): decoded base64 and hex runs are checked against every form and 16-character piece
  (`forms.all`), as decoded and squeezed. Bytes shorter than the shortest form are skipped. Tests: base64 halves
  in two fields, a Basic header cut at 64 characters, base64 of 30 characters (all `[redacted]` in place);
  PowerShell `-EncodedCommand` (base64 of UTF-16LE) and hex of UTF-16LE text at both alignments (in place);
  `util.inspect` of a UTF-16LE Buffer (generic, found only once squeezed).
- Mutants: tests for a 16-character piece redacted and a 15-character piece kept; hex of a 16-character piece
  (32 hex characters) redacted and of 15 kept; a Basic header glued after 1 to 4 base64 characters; hex of a
  20-character piece wrapped every 10 characters or NUL-interleaved (generic).
- M3: the header now says which code runs on the original (only the built-in byte-length getters and V8's
  `stack` getter under the gate's hook; `transient` is the one deliberate exception) and lists R14 in the
  accepted limits in the ruling's terms.
- M1 (`SCAN_MAX`): only the first 1 MiB of each string is scanned; what is shown (8 KiB) comes from that, and a
  field read in part is marked `... [cut]`. Tests: a NUL-interleaved token past 1 MiB is not read; one just inside
  is still generic; a field that shrinks below 8 KiB is still marked cut. The test "a huge single base64-looking
  run fails closed" now expects the run kept and cut (it no longer has to fail closed; M2 improves too).

Probes (`t7r4/*.fix4.out`): `probe-stackhdr`, `probe-protogetter`, `probe-name-overflow`: clean, except
`new Error(Uint8Array)`, which is a decimal string before the gate sees it (accepted limit). `probe-r4`: A1 to A6
clean (A5 generic); C block 77 cases, note everywhere but the `Symbol.toStringTag` fake (dropped, never called), `accessorCalls=0` except "poisoned in thrown" (the
`transient` read, by design); D and E unchanged; B1 to B4 still show (R14 accepted limit) and B6 to B12 (printable
character inside the token, accepted limit). `probe-mut`: all clean. `probe-fp-perf`: legitimate text unchanged;
every 64 MiB case under 1 s (was up to 15.6 s). `probe-m1-many` (new): message, stack, stderr, stdout and causes up to
the cause cap, each 64 MiB of hex runs: 5.3 s in the gate.

Mutation sweep (`t7r4/mut-r5.py`, output `mut-r5.out`, run on a copy holding the committed `gate.mjs` and
tests): 63 mutants, 49 killed, 14 survived, 0 not applied. The five that mattered in round 3 are killed: `WINDOW`
16 -> 17 and -> 20, base64 alignments 2 and 3, no hex-run check in `hidesIn`, `HEX_RUN` 32 -> 34 (also new:
`WINDOW` 16 -> 15, `HEX_RUN` 32 -> 33). New N8, N9, N10 and M1 mutants are killed: no hook, hook not restored or
restored only when absent, no frame filter, original header kept, any getter called, stack bytes not noted,
decoded runs checking `forms.full` only, decoded runs not squeezed, `SCAN_MAX` not applied or doubled, cut marker
by length only. Survivors: the two `shortest` skips (speed only); the hides check on the joined stack (both parts
are already clean, and a form across the seam needs "at" inside the token); and the eleven the round-3 reviewer
listed as equivalent or harmless (no post-printable check, `bytesNote` without the Proxy check, no Proxy refusal
in the cause walk or `messageOf`, scrubForms `end` or non-overlapping search, `pinStack` on the built error, no
base64url, unpadded base64 or URL-encoded form, `B64_RUN` 16 -> 20).

### Concerns

- The 1 MiB scan cut can leave a piece shorter than 16 characters of a token that straddles the cut, and it
  shows when the rest of the field scrubs away: "64 MiB of the token repeated" now shows `[redacted]` plus 4
  characters, then `... [cut]` (message length 29 -> 42). Within the stated under-16 limit; the windows catch 16
  or more. "Scrubbed before it is cut" (N5) still holds at the 8 KiB display cut, not at the 1 MiB scan cut.
- A non-configurable `Error.prepareStackTrace` (for example `--frozen-intrinsics`) makes the hook install
  throw, so every action error becomes generic. Fail closed, but all detail is lost.
- `details.stack` changed shape: its first line is the gate's cleaned message, with no `Name:` prefix; a stack
  with no `    at` lines is dropped. Plan 2b callers and core spec 7.5 (Task 15) should say so.
- Reading the stack under the hook caches the frames-only text on the original error (never rethrown).
- `new Error(uint8array)` is a decimal string before the gate sees it (accepted limit); worth a line in the
  Plan 2b action contract.
- Verified on Node 26.12.1. Node 24 uses the same `Error.prepareStackTrace` override path; CI on Node 24 is the
  check.

## Fix round 5

Ruling R15. Commit: see git log (scripts/lib/gate.mjs, tests/gate.test.mjs). Suite: 786 tests, 779 pass, 0 fail, 7 skipped (baseline 781/774/7).

- m1: a field that was read only in part (over 1 MiB) now shows nothing from the last 64 characters of its scrubbed text (`SCAN_TAIL`), so a partial token at the cut is never shown. Test: three fields with token pieces ending at the cut, and a straddling token. The M1 test's expected text moved by those 64 characters.
- m2: the stack header again starts with the class name when it is a DATA property (own or up the prototype chain, depth 8, Proxy stops the walk) matching `/^[A-Za-z][A-Za-z0-9_]{0,63}$/`. A DOMException is read through its built-in `name` and `message` getters captured at load (they run no user code); a TimeoutError or AbortError shows name and message. Tests include that own and prototype `name` getters are never called. Other tests that pinned the header text now expect `Error: ...`.
- m3: three tests kill the hook mutants (restore when formatting throws; restore of an accessor and of a non-writable hook with no setter call; frame filter keeps only `    at ` lines).
- m4, m5: header limits added (vm-realm errors show no stack; frozen hook makes every error generic; replaced globalThis.Error accessor and Node-formatted errors are outside the gate's control; the 1 MiB cut tail).
- The seven tests that fail on the old gate.mjs are the new m1/m2 tests plus the six whose expectations changed by design.
- `pnpm lint:md` reports MD038 in two `.superpowers/sdd` review files (task-7-rereview-round1.md, round4.md); not touched by this round.
