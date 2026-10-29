---
id: ADR-0014
title: The signed receipt has eleven fields, and a receipt stays usable after a crash mid-action until it expires
status: Accepted
date: 2026-10-29
authors:
  - pacphi
tags: [security, receipts, approvals, ledger, crash-window]
---

## Context

[ADR-0010](0010-sealed-credential-released-by-human-unlock.md) item 4 lists seven receipt fields (gate, run,
binding, ledger head, `seq`, nonce and time). Item 2 says "a run that exits or dies needs a new unlock."

Plan 2a built something different in two ways.

1. **Eleven fields, in a fixed byte order.** The receipt also signs the branch, the fork (`host/owner/repo`) and the
   lease of [ADR-0012](0012-leased-force-push-for-resubmits.md). A forged fork URL in `state.json` cannot redirect
   the push, and a lease cannot be swapped. A receipt that lacks the fork or lease fields fails closed, so old
   receipts stop working. See `FIELDS` and the signed-bytes function in
   [scripts/lib/receipt.mjs](../../scripts/lib/receipt.mjs).
2. **The R12 crash window.** The gate writes the receipt, runs the action while the receipt is still unused (so
   the pre-push guard can see it during the gate's own push), and records the outcome once, afterwards. If the
   process dies in the middle of the action, the receipt stays usable until it expires, 10 minutes. That
   contradicts the "dies" half of item 2. The receipt is bound to the exact commit SHA, branch and fork, so
   the most it allows is the same approved push again.

The owner accepted this record on 2026-10-29: the eleven signed fields are official, and the crash window is
kept as built (option A below).

## Decision

**Option A, accepted by the owner on 2026-10-29.** Keep the crash window as built and record it as an exception
to ADR-0010 item 2.

Options for the crash window (R12):

- **A. Keep R12 as built (recommended).** Smallest change, and it matches how the pre-push guard works today.
  Risk: after a crash, the same approved commit, branch and fork can be pushed again for up to 10 minutes
  without a new unlock. Nothing else can be pushed.
- **B. Claim the receipt before the action, and teach the guard to accept a claimed-but-unfinished receipt.**
  Closes the window for a second caller, and a crash needs a new unlock. Cost: changes to the gate, the receipt
  states and the guard, and more tests. Risk: a new state is a new place for a bug, and the guard would trust
  a receipt that is only "claimed".
- **C. Shorten the receipt lifetime for submit.** One constant. Shrinks the window but does not close it, and a
  short life makes a slow network retry more likely to need a second unlock.

## Consequences

**Positive:** the signed fields are on record, so a later reader knows why `fork` and `lease` are signed. With A,
no further code changes.

**Negative:** with A, ADR-0010 item 2 is not fully true for receipts: a crash leaves a usable receipt for up to
10 minutes. The cutting-the-ledger-tail risk (a used receipt revived until it expires) is a separate known risk
and is not changed by any option here.

**Neutral:** receipts written before this change fail closed and need a new unlock.

## Verification

The tests in `tests/receipt.test.mjs` and `tests/gate.test.mjs` cover the eleven fields, the fail-closed old
format and the gate's order of steps. Option B or C would need new tests first.

## Related

- [ADR-0010](0010-sealed-credential-released-by-human-unlock.md), items 2 and 4
- [ADR-0012](0012-leased-force-push-for-resubmits.md), the lease
- [Core spec §7.5](../specs/core-single-issue-pipeline.md), receipts and the crash window

## Implementation status

Built as option A in Plan 2a on the branch `plan-2a-security`, not yet merged into `develop`. Accepted by the
owner on 2026-10-29.
