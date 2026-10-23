---
id: ADR-0006
title: Work on a plain clone, create the fork only at the submit gate, open drafts
status: Accepted
date: 2026-09-29
authors:
  - pacphi
tags: [workflow, fork, pull-request, ci, maintainers]
---

## Context

Creating a fork and pushing to it are public actions. Pushing work-in-progress branches to claim work, as
another project does, would publish unreviewed code. GitHub does not run a first-time contributor's
workflows on upstream pull requests until a maintainer approves them, and fork Actions are off by
default. Maintainers merge agent pull requests less often than human ones, penalize large diffs, and now
have settings to cap a contributor's open pull requests.

## Decision

We will do reproduction and fixing in a plain clone of the upstream, with its push URL disabled. The fork
is created, its Actions enabled, and the branch pushed only after the human approves the submit gate. The
pull request opens as a draft, and is marked ready only when the fork's own CI is green and the human
confirms. Diffs stay small. Batch work opens a few pull requests, waits for engagement, and states
dependencies in each body.

## Consequences

**Positive:** nothing public before approval; maintainers see a passing, focused pull request.

**Negative:** an extra step (fork CI) before "ready".

**Neutral:** projects that require an issue first get one, with approval, before any pull request.

## Verification

The pre-push guard refuses every push before the gate. A dry run lists exactly the public actions.

## Related

- [Core spec](../specs/core-single-issue-pipeline.md), sections 5 and 7.1
- [Evidence base](../research/evidence-base.md), sections C and F

## Implementation status

Designed. The submit command is Plan 2; the guard half is implemented.
