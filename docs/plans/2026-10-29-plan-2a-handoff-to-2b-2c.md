# Plan 2a handoff to Plans 2b and 2c

**What this is.** Plan 2a (the security foundation) changed interfaces that Plans 2b and 2c were written against,
and its reviews left items for later plans. This note lists every one, so they survive when the Plan 2a branch and
its working notes are gone. Each line names its source: a ruling (`R1` to `R40`), a review finding (for example
`Task 13 M-4` or `final review M7`), or the plan task that raised it. The rulings are summarized at the end.

**Builds on.** [Spec 1, the single-issue core](../specs/core-single-issue-pipeline.md) (§6 approvals, §7.1 the git
lock, §7.2 the host hooks, §7.5 the sealed credential and the unlock) and the
[thread record and audit spec](../specs/thread-record-and-audit.md) (the ledger). Decisions:
[ADR-0010](../adr/0010-sealed-credential-released-by-human-unlock.md),
[ADR-0011](../adr/0011-generated-plugin-folder-marketplace-at-root.md),
[ADR-0012](../adr/0012-leased-force-push-for-resubmits.md) and
[ADR-0014](../adr/0014-receipt-fields-and-crash-window.md) (accepted, option A). Evidence and the Task 17 review outcomes:
[research §11](../research/credential-separation.md#11-review-findings-for-plan-2a). This note does not restate the
specs; where a spec already says something, the line points to it.

**Status.** Written 2026-10-29, after the final whole-branch review of Plan 2a. Nothing in Plan 2a is verified: CI
on three systems and the owner's manual checks (Task 16) are owner-pending.

## Superseded lines in the Plan 2b file

The [Plan 2b file](2026-09-30-plan-2b-cli-skills-and-publish.md) is a dated snapshot and is not rewritten. These of
its lines are superseded by this note (ruling R40):

- Lines 3838 and 4120 call `runPublicAction` for the submit gate without `fork`. The gate refuses that with
  `BAD_CALL` (since Task 14). Pass the fork's URL.
- Lines 3861 and 4143 call `beginStation(state, 'submit', …)` after the gate returns, with no `publicProof`. That
  always fails with `GATE_NOT_APPROVED`, because the receipt is used by then. Begin the station inside the action,
  as below.

## Plan 2b: `submit`, `post` and the gate

- `submit` begins the run's submit station inside `runPublicAction`'s action, in the same process, while the receipt
  is still unused, and only then pushes; it passes `fork` (R40, final review I1; spec §6 and §7.5 step 6).
- The action is called once per attempt (up to three), so begin the station on the first attempt only; a retry must
  not begin it again (R40).
- Add one test that runs `runPublicAction` and then moves the run through the submit station the way `submit` does
  (final review I1).
- The caller owns the terminal and closes it in a `finally` (Task 7 carry-forward; `gate.mjs` header).
- Decode tool output to UTF-8 strings before throwing, and never pre-serialize it (`JSON.stringify`, `util.inspect`,
  `encodeURIComponent`); raw bytes in an error are omitted, not decoded (R13, R14; spec §7.5).
- Add a test that feeds UTF-16 tool output through the real caller path (R14).
- Never build an error from bytes: `new Error(uint8array)` turns the bytes into a decimal string before the gate
  sees them (Task 7 carry-forward; `gate.mjs` header).
- Every new output that prints text read from a file, the ledger, the vault, a receipt or a repository goes through
  `printable.mjs` (R11).
- Never put the token in an action's result: the gate returns the result unchanged. Check each result for the
  token's forms, as the gate's internal `hides()` scan does for errors, when the actions are built (Task 17 F5,
  R35).
- Indent the error `details` when printing them (Task 7 carry-forward).
- A retried `post` can publish twice: make the post action idempotent or check before retrying (Task 7 M8a).
- The pull request title and body are not bound to the receipt; decide whether they should be (Task 7 M8b).
- Long summary lines wrap past the indent; wrap them before handing the summary to the gate (Task 7 M8c).
- Nothing may treat `mode: 'unlock'` in `state.json` as proof of approval (Task 7 M8d, R18).
- `submit` and `post` refuse to run when `process.execArgv` or `NODE_OPTIONS` carries a preload, or when `PATH`,
  `LD_*` or `DYLD_*` differ from a safe value: the runtime half of the publish allowlist (R37).
- Report clearly when a `receipt-consumed` line appended by someone else blocks the human's own push (Task 17 F6,
  R35).
- Real submit runs live under the account home (`~/.riverwright`); a run under a custom `RIVERWRIGHT_HOME` cannot
  pass the submit proof until the owner decides R21 (R20, R21).

## Plan 2b: git, the push and the clone

- Read the fork branch's remote tip before the unlock; git 2.54 leaves a stale `--force-with-lease` ref out of the
  pre-push lines, so the guard sees an empty push (Task 14 finding; ADR-0012).
- Pass a `lease` only when the push replaces the fork branch tip; otherwise pass none (Task 14 carry-forward).
- Never make a shallow workspace clone: the guard's ancestry walk treats a shallow boundary as "not a fast-forward"
  (R33, Task 14 carry-forward).
- Set `GIT_SSH_COMMAND` only in Riverwright's own spawn, spread last so an ambient value is replaced, never through
  a command the agent's shell runs (Task 13 M-5; spec §7.5).
- The push-key command runs `ssh` found through `PATH`, which an agent can change; record and use an absolute `ssh`
  path chosen by the owner (Task 13 M-4).
- Call `installGuard` only on workspace clones: given the root of a user's own repository it would replace that
  repository's local credential helpers (Task 12 carry-forward; spec §7.1).
- `installGuard` and `checkGuard` need the workspace home and an existing script, and throw `NOT_CLONE_ROOT`,
  `REMOTE_OUTSIDE_CLONE` or `BAD_SCRIPT` (Task 12 carry-forward).

## Plan 2b: `doctor`, `setup` and the skills

- `doctor` catches and prints `installGuard` and `checkGuard` errors instead of crashing (Task 12 carry-forward).
- `doctor` shows the ambient-credential report that `riverwright credential status` prints (Task 5; spec §7.5).
- Warn when the fork's owner differs from the GitHub login the credential was set up with (Task 14 M-7).
- `node scripts/riverwright.mjs submit|post` is denied everywhere; skills and documents run the bin launcher directly
  (R37, final review M8; spec §7.2).

## Plan 2c: adapters and hooks

- `--home account`, the symbolic form in ADR-0011, is not accepted yet by `workspaceHomeFromArg` or
  `launcherHookCommand` (Task 11 carry-forward).
- Write the per-host shell-tool hook matchers (Task 11 carry-forward; spec §7.2).
- Split `classify.mjs` (1,861 lines) into modules behind the same corpus tests before adding per-host matchers, and
  send new spelling variants to the known-limits list unless they are regressions (final review recommendation 1).
- The hook rule's known limits stay recorded, not fixed: the eight spelling classes in research §11 and the earlier
  Task 11 ones (stdin path spellings such as `/proc/self/fd/0`, a nested variable pair past the work budget, `sed -e`
  with a variable, `awk` option order on gawk and mawk, `git` false positives with variables or user aliases), plus
  `cd "$VAR"` ignored and a relative `cd` in a loop followed once (R30, R36, R38).
- `scope.mjs` follows only `cd` and `pushd` and expands `~` from `HOME`, while `classify.mjs` follows more and uses
  the account home too; share one helper or say why they differ (final review recommendation 4).
- The hook took 1.9 s on 12,000 `git -C` commands (`touchesHome` in `scope.mjs`) (Task 11 parked).

## Task 16 and CI (owner-pending)

- Hidden typing, Ctrl-C restoring the terminal, and Windows `CONIN$`, on a real terminal (R4; Task 4).
- The hardware push key: touch and PIN behavior, and whether Apple's bundled OpenSSH supports `sk-` keys (Task 13
  M-4).
- A fine-grained, fork-scoped token opening a pull request (Task 16 plan text).
- CI on ubuntu, macOS and Windows with Node 24 and 26; the suite has run only on Node 26 on macOS (final review
  recommendation 6).
- On Windows: `/dev/null` as git's global config and graft file in the guard, and `-F NUL` for the push key, tested
  only as text (Task 13, Task 14 parked).
- The guard's "live" environment assertion needs git 2.21 or newer (Task 14, R33).
- The real-git `pushInsteadOf` test is skipped on Windows (Task 8).

## Owner decisions pending

Present one at a time.

- ADR-0014: decided 2026-10-29. The owner accepted option A: the eleven signed fields are official and the crash
  window is kept and recorded (R34).
- R32: decided 2026-10-29. The owner chose to keep it: the push-key `ssh` ignores the user's and the system's SSH
  configuration, so host aliases, custom ports and jump hosts do not apply to that push.
- R21: the split home (`ledger verify` and the submit proof read only the account home). When decided, the message
  should name the vault path it checked: with a vault in both homes, `ledger verify` now says "the receipt signature
  does not verify", which reads as tampering (final review recommendation 3).
- The vault-fingerprint warning: record the vault key's fingerprint at setup and have `ledger verify`, `doctor` and
  the gate warn when it changes (R36, final review recommendation 2).
- Whether to keep `consumeReceipt` and the `claimed` state: kept for ADR-0014 option B; remove if option A is chosen
  and Plan 2b does not use it (final review M4).
- Merging the branch into `develop`, and pushing it.

## Parked minors for a later plan

These were found by the task reviews, judged low risk, and not fixed. Each still needs a decision.

- The ledger: no `fsync` after an append; the stale-lock release has no owner check, so two waiters that both clear
  a stale lock can both proceed; Plan 1 `ledger.jsonl` files are ignored silently (Task 1 M2, M4, M5).
- Ledger tests: `LEDGER_BUSY`, `--head` and `--seq` checks, a non-contiguous `seq`, a blank line mid-file (Task 1
  M6).
- The hook swallows a failed ledger append silently (Task 1 M3).
- The vault: no `fsync`; the vault folder's mode on a folder that already exists; no exclusive create;
  `validateVault` does not parse the public key or refuse unknown key-derivation fields; a whitespace-only
  passphrase; test gaps for NFKC, a loose-mode folder and the Windows skip (Task 2).
- `deriveKey` does not zero its Buffers (Task 7 M7).
- `openVault` rethrows a `JSON.parse` error unchanged (Task 7, routed to the final review).
- A test for a `LEDGER_BUSY` or I/O failure while the gate records the outcome (Task 7 M5).
- The gate's error cleaning does not check UTF-32 or other unusual encodings, and a very large input is slow (Task
  7); the remaining accepted limits are in the `gate.mjs` header (R13, R14, R15).
- `appendReceipt` still exposes its `nonce` seam; `findValidReceipt`'s `nonce` parameter has no caller (Task 3,
  final review M4).
- The terminal prompt: a no-op error listener added per read on the same stream, stray control bytes absorbed
  in an unfinished escape sequence, backspace removes a code point not a grapheme, arrow keys are swallowed (Task 4).
- The ambient audit: the private-key header test expects a byte-order mark but reads the file as latin1, so a key
  with a BOM or a blank first line is missed; `gh` exiting 1 when offline reads as "no login" (Task 5).
- `exec.mjs` labels an output-cap overrun as a timeout (Task 5).
- `setup.mjs` prints `step.file` raw in its confirm prompt; `sanitize --quote` keeps ESC and C1 characters; U+034F
  and U+FE0F pass through `printable`; U+200D is shown as `?` (Task 6, R10).
- `credential setup --replace` keeps no copy of the old vault (Task 6; documented in spec §7.5).
- `installGuard`: a check that fails after writing throws after the writes; a worktree-scope credential helper is
  reported but not removed; the message for a whitespace `core.hooksPath` (Task 12).
- The push key's private-key check follows a symbolic link; harmless, as nothing is read (Task 13 M-3).
- `ledger verify` re-verifies the whole chain for each receipt; fine now, slow if ledgers grow long (final review
  recommendation 5).

## Accepted residuals (no action; for reference)

- Tail replay: cutting the ledger's tail makes a used receipt look unused for up to 10 minutes (R9; spec §7.5).
- Crash window: a crash during the action leaves the receipt usable for up to 10 minutes (R12; ADR-0014).
- Prose that names `rw credential` or `rw submit` is denied (R24, R37); variable pairs after interpreters and
  runners are denied machine-wide (final review M5; ROADMAP risks).
- The guard trusts the `--home` written in the hook file, which a same-user agent can edit anyway (final review).
- The token and passphrase in the JavaScript heap cannot be zeroed (ADR-0010).

## Rulings index

The rulings were made during the Plan 2a build. Tracked documents and code comments cite them by number.

| Ruling | Decision |
|---|---|
| R1 | Task 16 is the owner's to run; Task 17 is the independent review stage, not an implementer task |
| R2 | Task 15 edits apply to the current roadmap and plans index; no status reaches `verified` without a CI link |
| R3 | Local commits are allowed on the branch; pushing and merging are not |
| R4 | The raw terminal path is tested with fakes; real terminals are the owner's checks |
| R5 | Model choice per task; Task 1 was a pilot shown to the owner first |
| R6 | Specs that named `ledger.jsonl` are corrected; dated plans stay as written |
| R7 | `verifyChain` with a seq and a head compares against that line, not the tip |
| R8 | Argon2id at 64 MiB and 3 passes stands |
| R9 | Tail replay is an accepted residual risk, documented |
| R10 | U+200D is shown as `?`; cosmetic, security first |
| R11 | Text read from files, the ledger, the vault, receipts or a repository is printed through `printable.mjs` |
| R12 | The gate does not claim a receipt before the action; it records the outcome once afterwards |
| R13 | Raw bytes in an action's error are omitted, never decoded |
| R14 | Callers decode tool output to UTF-8 strings and never pre-serialize it |
| R15 | The gate's own 1 MiB scan cut, readable class names, and tests for the stack hook |
| R16 | The guard refuses a push to the upstream; the receipt signs the fork (done in Task 14) |
| R17 | Only the newest valid receipt authorizes; a newer unlock supersedes older ones |
| R18 | A recorded approval is never proof for a public gate; the submit station needs a receipt |
| R19 | Actor labels: `tty` is human, `host-ask` is the agent with `confirmedVia: "host-prompt"` |
| R20 | The submit proof reads the account home only; `--home` only through the test seam |
| R21 | `ledger verify` reads the account home only; the split home awaits the owner |
| R22 | `ledger verify` exits 2 when receipts exist and no vault was found; never "Ledger intact" |
| R23 | The credential hook rule is always in scope |
| R24 | Match the credential subcommand, fail closed on shapes a static rule cannot resolve |
| R25 | A text rule for the credential command (superseded by R26) |
| R26 | The subcommand-slot rule, with known non-executing tools |
| R27 | `git` is non-executing only for an allowlist of read-only subcommands |
| R28 | A variable or pattern counts as a program only where a program stands |
| R29 | Script and package operands of runtimes count as program position; unreadable pipes into shells stay `unresolvable` |
| R30 | Further spelling variants parked for Task 17 |
| R31 | `.superpowers/**` is left out of the Markdown lint |
| R32 | The push-key `ssh` ignores the user's and the system's SSH configuration; kept by the owner on 2026-10-29 |
| R33 | Fast-forward is decided by a hash-checked ancestry walk, and the guard's git gets an allowlisted environment |
| R34 | Roadmap rules win over the brief; ADR-0014 written as Proposed; R32 and R21 go to the owner |
| R35 | Task 17 triage: fix C1, C2, C3/F4, F1, F2, F3 and test hygiene; accept F5 and F6 with reasons |
| R36 | Further hook spellings are recorded as known limits; the vault-fingerprint warning is proposed |
| R37 | `submit` and `post` are allowed only in their plain trusted form; the runtime half is Plan 2b's |
| R38 | Stdin and preload forms of `submit` and `post` are denied; sequential `cd` tracking fixed |
| R39 | Superseded by R38's checks; not needed |
| R40 | `submit` begins the submit station inside the gate's action, before the push, and passes `fork` |
