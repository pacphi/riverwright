---
id: ADR-0013
title: Agents read GitHub through riverwright read, which needs no credential; gh becomes optional
status: Accepted
date: 2026-09-30
authors:
  - pacphi
tags: [github, credentials, read-only, agents, prompt-injection]
---

## Context

Agents need to look things up on GitHub before anything is published: an upstream issue, its comments, duplicate
issues, a pull request's state. The plans assumed the GitHub CLI for this, and an earlier choice made `gh`
required with its login only a warning.

The walking-skeleton preparation observed two facts on 2026-09-30 (`gh` 2.101.0, Node 26.4.0):

- `gh` will not run at all without a login or a `GH_TOKEN`: with an empty configuration directory it prints
  "please run gh auth login" and exits.
- GitHub's REST API itself allows anonymous reads of public data: a plain Node `fetch` of a public pull request
  list returned status 200, with a limit of 60 requests an hour.

So reading through `gh` would make a GitHub credential available to the agent's shell, which is exactly the ambient
route [ADR-0010](0010-sealed-credential-released-by-human-unlock.md) says Riverwright cannot close.

## Decision

We will give agents one way to read GitHub, `riverwright read`, and make `gh` optional.

1. `riverwright read issue|comments|pr|search|repo|ref ...` is built on Node's `https`. It sends `GET` requests to
   `api.github.com` only, carries no token and reads none from the environment, and refuses any other host or method.
2. Everything it returns from upstream is data: it passes through the sanitizer and is quoted, never obeyed
   (core spec §7.4).
3. It stays inside the anonymous rate limit: responses are cached per run with conditional requests, and a response
   that shows the limit is exhausted stops the command with the reset time. There is no token fallback in this
   decision; adding one is a separate decision.
4. Skills and roles use `riverwright read` for every lookup. `gh` is no longer part of the required floor (Node 24+,
   git and one host); `doctor` reports whether it is installed as information, and still reports a `gh` login as an
   ambient credential route. The host hook's rules for outward `gh` commands are unchanged.
5. Private repositories are out of scope, since anonymous reads cannot see them.

We rejected: requiring a `gh` login (an agent-usable credential on every machine, the opposite of ADR-0010);
giving `gh` a separate read-only token (still a credential in the agent's reach, and it needs setup); and leaving
the skills on `gh` with a login only as a warning (the skills would fail for anyone who followed the advice to stay
logged out).

## Consequences

**Positive:** no credential is needed to research an issue, so there is nothing for an agent to misuse; one reading
path means one place to sanitize and to cache; a person who wants `gh` keeps it.

**Negative:** the anonymous limit is 60 requests an hour (and the search endpoint's unauthenticated limit is lower;
not verified here), which a large scan could exhaust; private upstreams cannot be read; another command to build and
maintain.

**Neutral:** publishing is unchanged: it uses the sealed token through `submit` and `post`.

## Verification

Tests run against an injected fake transport and never the network: a non-GET, a host other than `api.github.com`
and an `Authorization` header are refused; responses are sanitized; a cached response is reused with a conditional
request; an exhausted limit stops with the reset time. A real anonymous read is checked by hand
(the walking-skeleton checklist, check 5).

## Related

- [ADR-0010](0010-sealed-credential-released-by-human-unlock.md), [ADR-0012](0012-leased-force-push-for-resubmits.md)
- [Walking-skeleton checklist](../plans/2026-09-30-walking-skeleton-checklist.md), observation F1
- Plan 2b (the command, the skills and `doctor`)

## Implementation status

Decided, not built. Plan 2b carries it.
