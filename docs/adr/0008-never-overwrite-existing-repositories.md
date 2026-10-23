---
id: ADR-0008
title: Existing repositories are never overwritten: managed blocks and additive merges only
status: Accepted
date: 2026-09-29
authors:
  - pacphi
tags: [integration, safety, agents-md, claude-md, gemini-md]
---

## Context

Riverwright is installed into repositories that already have instruction files (`AGENTS.md`, `CLAUDE.md`,
`GEMINI.md`), settings files and other tools' sections. The owner's own tools already mark their sections
with `<!-- BEGIN name -->` and `<!-- END name -->`. Overwriting or reformatting a user's file destroys
their work and their trust.

## Decision

We will change a repository only when the owner runs `riverwright setup --project`, which shows every diff,
asks per file, and can be reversed exactly. It edits only text between its own markers, adds JSON keys only
where absent, preserves line endings and a missing final newline, writes to one canonical instruction file
when others link or import it, refuses symlinks that leave the repository, keeps backups outside the
repository, and never commits. Removal restores exactly what was added and needs an ownership marker
before it deletes a file it created.

## Consequences

**Positive:** safe to install anywhere; coexists with other tools' blocks.

**Negative:** more code than a simple file write; a settings file with comments is left alone and a
snippet is printed instead.

**Neutral:** installing the plugin itself writes nothing into a repository.

## Verification

Tests cover CRLF files, a missing final newline, orphaned markers, look-alike marker names, symlinks,
planted backup manifests, read-only files and uncommitted changes; a second run is byte-identical.

## Related

- [Core spec](../specs/core-single-issue-pipeline.md), section 12.6
- Prior art: agentic-kit's block writer

## Implementation status

Implemented and verified in CI.
