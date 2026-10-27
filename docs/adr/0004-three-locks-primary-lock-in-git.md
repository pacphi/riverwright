---
id: ADR-0004
title: Three independent locks; the primary lock lives in git, not in any host
status: Accepted
date: 2026-09-29
authors:
  - pacphi
tags: [security, guard, hooks, approvals, prompt-injection]
---

## Context

An AI agent that reads untrusted upstream text and holds the user's GitHub credentials could publish
something no one approved. Research shows this is not hypothetical: in a 2026 benchmark, 66.5% of
malicious issues passed every guardrail in popular coding agents, and a public GitHub MCP incident
chained an injected issue into a private-data leak. Host hooks are not a safe primary control: several
fail open by default (Cursor without `failClosed`, Grok on a non-2 exit, Hermes unless `fail_closed`),
and their schemas differ. Two independent security reviews found further gaps.

## Decision

We will use three locks that do not depend on each other. Lock 1 is a git pre-push guard in the working
clone: it allows a push only to the recorded fork, on the run's own branch, at the approved commit. Lock 2
is a host hook that denies outward shell commands, generated per host and always failing closed. Lock 3
is a human action: a host permission prompt, or a typed confirmation in a terminal.

The guard finds its run from the repository being pushed from, not from environment variables or git
config an agent can set. Test switches live in an internal object that the real entry point never fills.
Hooks take their workspace path from an explicit argument, not the environment.

We accept a stated residual risk: an agent with shell access that deliberately circumvents every layer
could still push. Removing it needs credential separation, planned next.

## Consequences

**Positive:** accidental and injection-driven publication fails at more than one point; no guarantee
rests on one host's hook semantics.

**Negative:** three mechanisms to maintain; the approval record is still a file the agent can write until
credential separation lands.

**Neutral:** the command classifier is deliberately conservative and will sometimes deny a harmless command.

## Verification

More than 400 tests, including 107 classifier-bypass cases and forged-environment attacks that failed
first. Two independent reviews (Claude and Codex) and two hardening passes are recorded in the history.

## Related

- [Core spec](../specs/core-single-issue-pipeline.md), section 7
- [Evidence base](../research/evidence-base.md), section D

## Implementation status

Locks 1 and 2 are implemented and verified in CI. Installing the guard into a clone, credential
separation and approvals kept outside the workspace are Plan 2.
