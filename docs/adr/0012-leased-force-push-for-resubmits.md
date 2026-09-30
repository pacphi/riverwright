---
id: ADR-0012
title: A re-submit after an amend may replace the branch tip only through a leased push bound to the receipt
status: Accepted
date: 2026-09-30
authors:
  - pacphi
tags: [security, git, approvals, receipts, force-push]
---

## Context

Normally a pull request grows by new commits, which push cleanly. Sometimes the owner amends a commit that was
already pushed (for example to add a sign-off, which the agent never adds: [ADR-0005](0005-approvals-bound-to-exact-content.md)),
which changes its SHA and makes the next push a non-fast-forward. Until now the design never forced a push. Plan 2b
proposed "open a new branch" for this case; the owner chose to allow a leased force on the same branch so the
existing pull request is updated in place.

A plain force push is a rewrite the human did not approve in detail, and the pre-push guard could not tell a
replacement of our own earlier commit from a replacement of someone else's work.

## Decision

We will allow a non-fast-forward push to the fork's run branch only as a **leased** push bound to the signed receipt.

1. A submit-gate receipt may carry `lease`: the full SHA the human has been shown as the current tip of the remote
   branch, which Riverwright recorded when it pushed that commit. The signed bytes include it. No other gate has one.
2. `submit` reads the fork branch's tip before the unlock. If the tip is not the SHA recorded in the ledger's `pushed`
   event for this run, it stops: someone else changed the branch. Otherwise the unlock summary says plainly that the
   push **replaces** that commit with the new one, and the human's passphrase approves exactly that pair.
3. The push uses `--force-with-lease=refs/heads/<branch>:<lease>`, always with the explicit expected value, never a
   bare `--force` or `--force-with-lease`.
4. The pre-push guard allows a push whose remote tip is not an ancestor of the pushed commit only if the receipt's
   `lease` equals that remote tip. Anything else that is not a fast-forward is refused. The branch, the commit and the
   fork checks are unchanged, and pushing to any other repository is still refused.
5. The host hook continues to deny an agent's own `--force` push, so the only path is `riverwright submit`.

We rejected: never forcing and opening a new branch (it leaves the old pull request orphaned, which the owner did
not want), and refusing amends entirely (it blocks the sign-off fix-up).

## Consequences

**Positive:** an amended commit updates its existing pull request; the overwrite is limited to the exact commit we
pushed, so a concurrent change by someone else is never destroyed; the human's unlock approves the replacement
explicitly.

**Negative:** this is the first force-shaped operation in the design, so the guard and the gate have one more
rule to maintain; reviewers of the upstream pull request see rewritten history, which some maintainers dislike.

**Neutral:** ordinary follow-up commits are unchanged.

## Verification

Tests cover: a receipt without a lease refusing a non-fast-forward; a lease that does not equal the remote tip
refused; the matching lease allowed; the lease covered by the signature; the summary showing the replacement; and a
branch whose tip moved being refused before any unlock.

## Related

- [ADR-0004](0004-three-locks-primary-lock-in-git.md), [ADR-0005](0005-approvals-bound-to-exact-content.md),
  [ADR-0010](0010-sealed-credential-released-by-human-unlock.md)
- Plan 2a, Task 14 (receipt, gate and guard), and Plan 2b (the push and the pre-unlock tip check)

## Implementation status

Decided, not built.
