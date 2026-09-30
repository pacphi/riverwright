---
id: ADR-0009
title: pnpm, pinned by packageManager, installs the development tools
status: Accepted
date: 2026-09-29
authors:
  - pacphi
tags: [tooling, pnpm, ci, dependabot]
---

## Context

The runtime has no npm dependencies ([ADR-0003](0003-dependency-free-node-runtime.md)), but development
needs tools, starting with the Markdown linter. The first version of that setup used npm. The owner's other
projects (autopilot, agentic-kit) use pnpm and pin it with the `packageManager` field, and asked for the
latest compatible pnpm here. pnpm 12.8.1 is current and supports Node 18 and newer, so it covers our Node
24 and 26.

## Decision

We will install development tools with pnpm. `package.json` pins the exact version in `packageManager`
(`pnpm@12.8.1`), and CI reads that field through `pnpm/action-setup`, so the version is stated in one
place. The lockfile is `pnpm-lock.yaml`, and CI installs with `--frozen-lockfile`. No other package
manager's lockfile is kept. Dependabot's `npm` ecosystem also reads `pnpm-lock.yaml`, so it keeps the
tools current, including pnpm itself.

Only the lint job installs anything. The test jobs run on plain Node with nothing installed, and users
install nothing.

We rejected keeping npm (it differs from the owner's other projects) and yarn or bun (no reason to add
another tool).

## Consequences

**Positive:** one package manager across the owner's projects; a strict, fast, frozen install; the version
is pinned in one field.

**Negative:** contributors need pnpm (Corepack or `pnpm/action-setup`); a globally installed pnpm may be
older than the pin.

**Neutral:** the runtime's dependency-free rule is unchanged and still enforced.

## Verification

`tests/package-manager.test.mjs` fails if `packageManager` is not an exact pnpm version, if a lockfile from
another package manager appears, if CI installs with npm or without a frozen lockfile, or if the
documentation tells contributors to use `npm run`. `tests/runtime-dependencies.test.mjs` still enforces
the dependency-free runtime.

## Related

- [ADR-0003](0003-dependency-free-node-runtime.md)
- `.github/workflows/ci.yml`, `.github/dependabot.yml`, `package.json`

## Implementation status

Implemented. `pnpm-lock.yaml` replaces `package-lock.json`; CI's lint job uses `pnpm/action-setup`.
