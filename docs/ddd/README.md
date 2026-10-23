# Domain model

These documents fix the words Riverwright uses and the boundaries between its parts, so specs, code,
tests and conversation say the same thing. They describe the system as designed, and mark anything not yet
built. The approach follows the Domain-Driven Design vocabulary used across ruflo: bounded contexts, a
ubiquitous language and a context map.

## Documents

| Document | Purpose |
|---|---|
| [Ubiquitous language](ubiquitous-language.md) | The canonical meaning of each term, and which context owns it |
| [Context map](context-map.md) | The bounded contexts, what each owns, where its code lives, and how they relate |

Further documents are added one per bounded context when that context is designed in detail (for example
the pipeline, safety, and follow-and-adopt contexts).

## Change rule

A change that introduces or changes a domain concept should:

1. name the bounded context that owns it;
2. use or extend the ubiquitous language, adding the term here first;
3. keep the context's invariants, or come with an ADR that explains why they change;
4. add executable coverage for any new invariant; and
5. update the roadmap and any affected spec.

When documentation and behavior disagree, treat it as drift to resolve, not a reason to redefine a term
quietly. Where a term is planned but not built, this model says so and does not present it as shipped.
