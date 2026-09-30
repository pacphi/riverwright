# Riverwright documentation

Riverwright is in design and early implementation. This page is the map. The rules for where a document
goes are in [AGENTS.md](../AGENTS.md#documentation-layout) and were decided in
[ADR-0001](adr/0001-documentation-taxonomy.md).

## Start here

| If you want to know | Read |
|---|---|
| What exists, what is next, and what is proven | [ROADMAP.md](ROADMAP.md) |
| Why something was decided | [adr/](adr/README.md) |
| What a word means, and how the system is divided | [ddd/](ddd/README.md) |
| What a feature must do | [specs/](specs/core-single-issue-pipeline.md) |
| How the work is being built | [plans/](plans/README.md) |
| What evidence the design rests on | [research/](research/evidence-base.md) |
| The illustrated walkthrough | [story/](story/paddling-upstream.html) |

## The folders

| Folder | Holds | Naming |
|---|---|---|
| [adr/](adr/README.md) | Architecture decision records, one per decision | `NNNN-kebab-title.md` |
| [ddd/](ddd/README.md) | Ubiquitous language, context map, one document per bounded context | `kebab-name.md` |
| [specs/](specs/core-single-issue-pipeline.md) | Requirements, behavior and data formats | `kebab-name.md`, no date |
| [plans/](plans/README.md) | Task-level implementation plans and their index | `YYYY-MM-DD-kebab-name.md` |
| [research/](research/evidence-base.md) | Cited evidence behind decisions | `kebab-name.md` |
| [story/](story/paddling-upstream.html) | The illustrated walkthrough and its evidence file | fixed |

`guides/` (how to use it), `reference/` (commands, config, schemas) and `archive/` (superseded material)
are created when their first document exists.

## How the kinds of document relate

- A **spec** says what to build. A **plan** says how, in tasks, and names its spec.
- An **ADR** says why a consequential choice was made, and is never edited after it is accepted.
- The **domain model** fixes the words and the boundaries, so specs, code and tests use one language.
- The **roadmap** links to all of them and states where each feature stands.
- **Research** holds the sources; an ADR or spec cites it instead of repeating it.
