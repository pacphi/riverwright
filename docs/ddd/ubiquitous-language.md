# Ubiquitous language

One meaning per word. If code, a spec or a conversation uses a term differently, fix that one. The
**Context** column names the bounded context that owns the term (see [the context map](context-map.md)).
Terms marked *(planned)* are designed but not built.

## Pipeline

| Term | Meaning | Context |
|---|---|---|
| **Run** | One pipeline execution for one upstream issue, from intake to submission. Identified as `owner/repo#number`. | Pipeline |
| **Station** | One named step of a run: start, intake, recon, environment, reproduce, root-cause, fix, review, writeup, submit. A run passes each in order. | Pipeline |
| **Gate** | A point where a run cannot proceed without a human decision: `checkpoint-1`, `submit-gate`, `post-issue`, `post-comment`. | Pipeline |
| **Budget** | The limit on repeated attempts (fix attempts, review rounds). Exhausting it stops the run. | Pipeline |
| **Preset** | A named set of budgets and defaults: frugal, balanced, thorough. | Pipeline |
| **Stop** | Ending a run early, with a recorded reason, such as an issue already fixed or a project that bans AI contributions. | Pipeline |
| **Dossier** *(planned)* | The evidence document for a run: how the bug was found, its impact, the environment, the reproduction, the fix and the testing. | Pipeline |
| **Role** *(planned)* | A unit of delegated work with its own prompt and permissions: scout, reproducer, investigator, fixer, reviewer. | Pipeline |
| **Dispatch ladder** *(planned)* | How a role runs: the host's native subagent, else a headless process of an installed host, else inline. | Pipeline |

## Safety

| Term | Meaning | Context |
|---|---|---|
| **Lock** | One independent protection against unapproved publication: the git guard, the host hook, or a human action. | Safety |
| **Guard** | The git pre-push check that allows a push only to the recorded fork, on the run's branch, at the approved commit. | Safety |
| **Hook** | A host's before-tool callback. Riverwright's hook denies outward shell commands and fails closed. | Safety |
| **Classifier** | The conservative parser that decides whether a shell command could publish or weaken a lock. | Safety |
| **Approval** | A recorded human decision for a gate. | Safety |
| **Binding** | What an approval is tied to: a full commit SHA, or a SHA-256 of normalized content. A change voids the approval. | Safety |
| **Sanitizer** | Removes and reports hidden characters from upstream text before it is stored or shown to a model. | Safety |
| **Outward action** | Anything visible outside this machine: a push, a pull request, an issue, a comment, a fork. | Safety |

## Project integration

| Term | Meaning | Context |
|---|---|---|
| **Managed block** | A section of a user's file between `<!-- BEGIN riverwright -->` and `<!-- END riverwright -->`, the only text Riverwright edits there. | Project integration |
| **Additive merge** | Adding absent keys to a JSON file without changing any existing value. | Project integration |
| **Ownership marker** | A record, kept outside the repository, proving Riverwright created a file, so removal may delete it. | Project integration |

## Evidence and audit

| Term | Meaning | Context |
|---|---|---|
| **Fingerprint** | The recorded environment: OS, architecture, tool versions and lockfile hashes. | Evidence and audit |
| **Ledger** | The append-only, hash-chained history of events. | Evidence and audit |
| **Evidence level** | How much a claim is backed: designed, tested on the fixture, or seen in a real run; for hosts, documented, checked on the build machine, or tested end to end. | Evidence and audit |
| **Fixture** *(planned)* | A repository with planted bugs used to test the pipeline end to end. | Evidence and audit |

## Follow and adopt *(planned)*

| Term | Meaning | Context |
|---|---|---|
| **Upstream** | A project this repository depends on, with the rules for dealing with it. | Follow and adopt |
| **Thread** | One upstream issue or pull request that matters to this repository. | Follow and adopt |
| **Workaround** | Something the repository carries because an upstream thread is unresolved, with a version gate, a retest date and a removal proof. | Follow and adopt |
| **Registry** | The repository's committed list of threads, workarounds and upstreams. | Follow and adopt |
| **Adoption** | The change made in the downstream repository when a fix is released, ending in the workaround's removal. | Follow and adopt |
| **Correspondence** | Every message drafted, approved, posted or received on a thread. | Follow and adopt |
| **Voice** | The bookkeeping of what we last said upstream and what we have drafted but not posted. | Follow and adopt |

## Hosts

| Term | Meaning | Context |
|---|---|---|
| **Host** | A coding-agent product Riverwright runs in: Claude Code, Codex CLI, Gemini CLI, Cursor, Grok Build, Hermes Agent. | Host adapters |
| **Adapter** | The generated manifests, commands, agents and hooks that make Riverwright work in one host. | Host adapters |
| **Dialect** | How one host expresses a deny decision and a hook payload. | Host adapters |
