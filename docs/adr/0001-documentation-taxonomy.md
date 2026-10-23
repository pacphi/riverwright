---
id: ADR-0001
title: Documents live in a fixed taxonomy; tool default locations are overridden
status: Accepted
date: 2026-09-29
authors:
  - pacphi
tags: [documentation, taxonomy, adr, ddd, superpowers]
---

## Context

Design documents were being written to `docs/superpowers/specs/` and `docs/superpowers/plans/`, the
defaults of the superpowers skills. That puts a tool's name in the project's structure, mixes kinds of
document by the tool that produced them, and gives no home for decisions or the domain model.

Two neighbouring projects already show a workable shape. Ruflo keeps numbered ADRs with a frontmatter
block and a Context, Decision, Consequences, Verification, Related and Implementation-status body, and has
Domain-Driven Design tooling built on bounded contexts, ubiquitous language and context maps.
agentic-kit keeps `docs/adr`, `docs/ddd`, `docs/plans` and a change rule tying them together. The
superpowers skills themselves say a user's preferred location overrides their default.

## Decision

We will organize `docs/` by the kind of question a document answers, not by the tool that wrote it:
`adr/` (why), `ddd/` (words and boundaries), `specs/` (what), `plans/` (how), `research/` (evidence),
`story/` (the walkthrough), and, when first needed, `guides/`, `reference/` and `archive/`, plus one
`ROADMAP.md` (status). Naming rules differ by kind: ADRs are numbered and immutable once accepted, specs
are living and undated, plans are dated snapshots.

The rules and the override live in `AGENTS.md`, which `CLAUDE.md` and `GEMINI.md` import, so every host
reads the same instruction. A skill that offers a default location is told to use these folders instead.

We rejected keeping `docs/superpowers/`: it ties the structure to one tool. We rejected a flat `docs/`:
it gives no rule for where a new document goes.

## Consequences

**Positive:** one obvious place for each kind of document; decisions and vocabulary get homes; the same
layout is readable by every host and tool.

**Negative:** documents produced by tools must be moved or redirected; a small enforcement test must be
kept in step with the layout.

**Neutral:** the two existing specs and Plan 1 moved, with their links fixed.

## Verification

`tests/docs-layout.test.mjs` fails if `docs/` gains an unlisted top-level entry, a `docs/superpowers/`
folder, a badly named spec, plan or ADR, an unindexed ADR, or a broken link in the indexed documents.
`tests/roadmap.test.mjs` keeps `docs/ROADMAP.md` honest.

## Related

- [AGENTS.md](../../AGENTS.md#documentation-layout), the rules and the override
- [docs/README.md](../README.md), the map
- [ADR template](0000-template.md)

## Implementation status

Implemented. The folders, indexes, instruction files and both tests exist.
