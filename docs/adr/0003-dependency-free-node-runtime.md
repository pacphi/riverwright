---
id: ADR-0003
title: A dependency-free Node runtime that works on Windows, macOS and Linux
status: Accepted
date: 2026-09-29
authors:
  - pacphi
tags: [runtime, node, windows, portability, security]
---

## Context

The deterministic parts of the product (state, approvals, the git and host guards, project edits) must
behave the same on Windows, macOS and Linux. A first design used bash. Two facts changed that. Bash is
absent on many Windows machines, and a guard written in bash fails open there; the superpowers Windows
hook launcher, for instance, exits 0 when it cannot find bash. And Node is already required by the hosts
and by the neighbouring tools.

## Decision

We will write the runtime in Node.js 24 or newer using only built-in modules, with no npm dependencies.
Small launchers (`riverwright` and `rw`, POSIX shell and Windows cmd) start Node and exit 2 (deny) when
it is missing and the call is a hook or a guard. Child processes run through `execFile` with argument
arrays, never through a shell string, and Windows `.cmd` shims are handled explicitly. We test on Ubuntu,
macOS and Windows with Node 24 and 26.

We rejected bash (fails open, not portable) and a bundled binary for now (a later option through Node
single executable applications).

## Consequences

**Positive:** one codebase; installing the plugin is a file copy; JSON, paths and processes are built in.

**Negative:** Node 24 or newer is required; Windows shell quoting needs care and real CI.

**Neutral:** Node 26 becomes LTS on 2026-10-28, so the matrix already covers the next LTS.

## Verification

`node --test` in CI on six jobs. The first Windows run found a fail-open bug in the PowerShell hook form,
now fixed and covered by tests that run the real wrapper wherever PowerShell exists.

## Related

- [Core spec](../specs/core-single-issue-pipeline.md), section 3.2
- `.github/workflows/ci.yml`

## Implementation status

Implemented and verified in CI on Ubuntu, macOS and Windows for Node 24 and 26.
