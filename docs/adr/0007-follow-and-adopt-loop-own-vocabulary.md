---
id: ADR-0007
title: Riverwright follows threads to release and adopts fixes, in its own vocabulary
status: Accepted
date: 2026-09-29
authors:
  - pacphi
tags: [scope, follow, adopt, audit, agentic-kit, naming]
---

## Context

Sending a pull request is not the end. The downstream repository still carries a workaround until the fix
ships, and the conversation with the maintainer needs care. agentic-kit already runs this loop by hand and
with a daily checker over 125 tracked threads. The product needed one name that covers filing, following
and adopting, and a record that a pipeline run and a follower can both use. The owner asked for
agentic-kit's ideas, not its terms.

## Decision

We will fold following and adopting into the product as later specs, sharing one thread record. The record
and its audit model use Riverwright's own vocabulary (impact, adoption, resolvedWhen, workaround, upstream,
and the lifecycle watching, fixed, released, adopting, adopted, retired, declined). A read-only, idempotent
import maps agentic-kit's registry and ledger into it. The product is named Riverwright, with the command
`riverwright` and the alias `rw`.

## Consequences

**Positive:** a run registers the thread it opens; the audit trail is one hash-chained ledger; agentic-kit
can adopt the shared module later without a forced migration.

**Negative:** a mapping to maintain; the follower and adopter are large pieces of later work.

**Neutral:** whether agentic-kit switches to Riverwright's checker is left open.

## Verification

The thread-record spec defines the field mapping and is checked when the import is built.

## Related

- [Thread record and audit model](../specs/thread-record-and-audit.md)
- [Roadmap](../ROADMAP.md)

## Implementation status

Designed (draft awaiting approval). Implementation is Specs 4 and 5, after the plugin.
