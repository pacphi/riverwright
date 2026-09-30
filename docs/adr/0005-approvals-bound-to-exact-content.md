---
id: ADR-0005
title: Human approval is bound to an exact commit or content hash; the agent never signs the DCO
status: Accepted
date: 2026-09-29
authors:
  - pacphi
tags: [approvals, dco, provenance, compliance]
---

## Context

Approval that is not tied to specific content can be reused for something else: approve a commit, then
change the code. Separately, the Linux kernel's policy states that only humans can certify the Developer
Certificate of Origin, and that AI involvement is disclosed with an `Assisted-by:` trailer. Nearly half of
open-source AI policies require disclosure, and some projects ban autonomous agents.

## Decision

We will record every approval as a gate name plus a binding: a full commit SHA for pushes, a SHA-256 of the
line-ending-normalized text for anything posted. A later change voids the approval. Approvals also bind to
the run's branch. The submit gate defaults to typed confirmation in a terminal; weakening it needs an
explicit command-line flag that appears in the prompt the human sees.

The agent never adds `Signed-off-by`. The human's approval at the submit gate is the certification, and it
is recorded against the final commit, after any sign-off amend. Commits carry `Assisted-by:`. We do not
add `Co-Authored-By` unless the upstream's policy asks for it.

## Consequences

**Positive:** approval is a receipt for exact content; disclosure follows the strictest common practice.

**Negative:** editing after approval means approving again.

**Neutral:** a project that bans agent contributions stops the run.

## Verification

Tests cover forged bindings, mismatched commits and branches, and the sign-off ordering.

## Related

- [Core spec](../specs/core-single-issue-pipeline.md), sections 6 and 10
- [Evidence base](../research/evidence-base.md), sections C and D

## Implementation status

Approval records, bindings and terminal confirmation are implemented and verified in CI. The submit and
post commands that consume them are Plan 2.
