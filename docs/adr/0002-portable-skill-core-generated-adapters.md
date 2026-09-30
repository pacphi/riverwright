---
id: ADR-0002
title: One portable skill core, with per-host adapters generated from one source
status: Accepted
date: 2026-09-29
authors:
  - pacphi
tags: [architecture, hosts, skills, adapters]
---

## Context

The product must work in six coding hosts: Claude Code, Codex CLI, Gemini CLI, Cursor, Grok Build and
Hermes Agent. All six load Agent Skills (`SKILL.md`), but they differ in plugin manifests, command
formats, hook schemas and subagent mechanisms. We checked each installed host's help, source or binary
(see [the evidence base](../research/evidence-base.md), section H).

## Decision

We will write the workflow once, as host-neutral Agent Skills plus role prompts and a small runtime, and
generate each host's manifests, commands, agents and hooks from one source. Subagent roles run as the
host's native subagent where it exists, else as a headless process of an installed host, else inline.
State is plain files, so a run started in one host can be finished in another.

We rejected six hand-written plugins (they would drift apart) and a standalone orchestrator that drives
every host headlessly (another runtime to install, and it fights each host's own checkpoint experience).

## Consequences

**Positive:** one place to change behavior; a new host is an adapter, not a rewrite; cross-vendor review
is possible because roles can run in a different host.

**Negative:** a generator and a drift check must be maintained; some host features (for example Codex
subagents, which are off by default) cannot be assumed.

**Neutral:** hosts not yet exercised end to end are labelled as such.

## Verification

CI fails if generated adapter files are stale (planned with the generator). Each host's evidence level is
recorded in `docs/story/evidence.json` and in the roadmap.

## Related

- [Core spec](../specs/core-single-issue-pipeline.md), sections 3, 8 and 13
- [Evidence base](../research/evidence-base.md), sections H and I

## Implementation status

Designed. The Claude Code adapter and the generator are Plan 2; the other five hosts follow.
