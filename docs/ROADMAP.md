# Riverwright: product requirements and roadmap

**Last updated:** 2026-09-29 · **Current milestone:** M2, the plugin · **Version:** 0.1.0 (pre-release)

This is the living statement of what Riverwright must do, what exists, and what is proven. Every use case
and feature has an ID and a status, and links to its design, its code and its evidence. It is checked by
`tests/roadmap.test.mjs`: an invented status word, a broken link, or an "implemented" claim with no code
fails the build.

Riverwright is an approval-gated toolkit that reproduces bugs in upstream dependencies, fixes them,
proposes the pull request, then follows the thread until the fix ships and helps you drop the workaround.
Nothing here is ready to use yet. See [the documentation map](README.md) for the rest of the documents.

## Status keywords

A feature moves through these in order. It never skips one, and it never moves forward without the evidence
the keyword promises.

| Status | Meaning | Evidence required |
|---|---|---|
| `proposed` | Named and wanted; the shape is not yet designed | none |
| `designed` | Written in a spec that the owner has reviewed | a link to the spec |
| `planned` | A task-level implementation plan exists | a link to the plan |
| `in-progress` | Being built now | a link to the plan or branch |
| `implemented` | Built, with tests, on `develop` | a link to code or tests |
| `verified` | Proven: the tests pass in CI on Ubuntu, macOS and Windows, or the behavior was seen working | an `https` link to a CI run, pull request or recorded run |
| `released` | Shipped in a tagged release | an `https` link to the release |
| `deferred` | Decided against for now, with a reason | the reason, in the decision log |
| `dropped` | Decided against | the reason, in the decision log |

These match the three evidence levels the [illustrated story](story/paddling-upstream.html) shows: designed,
tested on the practice project, and seen in a real run.

## Milestones

| ID | Milestone | Status | Target | Exit criteria |
|---|---|---|---|---|
| M0 | Foundations | `verified` | pre-release | public repository, licence, CI, core spec, evidence base, decision records, documentation layout |
| M1 | Runtime | `verified` | v0.1 | the `riverwright` command with state, approvals, guard, hook, classifier, project integration and evidence export; tests green on 3 operating systems and 2 Node versions |
| M2 | Plugin | `designed` | v0.2 | skills, roles, templates and the checkup and setup commands; the guard installed into a clone; credential separation; the Claude Code plugin passes `claude plugin validate --strict` and installs from a local marketplace |
| M3 | Proof | `designed` | v0.3 | fixture repository; end-to-end run in three hosts; captured hook payloads; the first real upstream run, every public step approved; the story rewritten from real evidence |
| M4 | Six hosts | `designed` | v0.4 | Codex, Gemini CLI, Cursor, Grok Build and Hermes adapters generated and each exercised on the fixture |
| M5 | Batch | `proposed` | v0.5 | scan an upstream's issues, detect twins, work independent fixes in parallel lanes, order and pace the pull requests |
| M6 | Follow | `designed` | v0.6 | register the thread a run opens, follow it to release, report status, import agentic-kit's registry |
| M7 | Adopt and correspond | `proposed` | v0.7 | draft the adoption change in your repository, draft friendly replies, nudges and supplements, all approval-gated |
| M8 | Launch | `proposed` | v1.0 | directory listings, trademark search done, install paths verified on every host |

## Use cases

| ID | Use case | What you get | Features | Status |
|---|---|---|---|---|
| UC-1 | Fix a bug I already reported upstream | a reproduced, tested, reviewed draft pull request with a write-up, sent only after you approve the exact commit | R-01, R-02, R-03, R-04, R-05, R-06, R-07, R-08, R-09, R-10, R-11, S-01, S-02, S-03, S-04, S-05, S-08 | `designed` |
| UC-2 | I hit a symptom and no issue exists yet | a duplicate search, then a drafted issue you approve, then the same path as UC-1 | R-01, R-02, R-05 | `designed` |
| UC-3 | Work through many issues on one upstream | independent fixes in parallel, twins merged into one, a suggested merge order, a paced set of pull requests | B-01, B-02, B-03, B-04 | `proposed` |
| UC-4 | Add Riverwright to a repository that already has instruction files | changes shown as a diff, made only inside marked blocks or as absent keys, reversible, nothing committed for you | X-01, X-02, X-03 | `verified` |
| UC-5 | Use my preferred coding tool | the same workflow in Claude Code, Codex, Gemini CLI, Cursor, Grok Build or Hermes, and a run you can start in one and finish in another | H-01, H-02, H-03, H-04, H-05, H-06, H-07, H-08, D-01, D-04 | `designed` |
| UC-6 | Follow the thread until the fix ships and drop my workaround | a registry of threads, status reports, the release confirmed, and a draft change that removes the workaround | W-01, W-03, W-05, A-01 | `designed` |
| UC-7 | Keep the conversation with the maintainers friendly and honest | drafted replies, nudges and supplements in the right tone, posted only with your approval, disclosure of AI assistance | A-02, A-03, S-05 | `proposed` |
| UC-8 | Prove later what happened and why | an audit trail: who did what, on which evidence, with whose approval, with a tamper-evident ledger | W-01, W-02, R-11, S-05, E-01 | `designed` |
| UC-9 | Install it and get started without friction | one install per host, a read-only checkup that says what is missing, and a guided setup | D-01, D-02, D-03, D-07 | `designed` |

## Features

### Pipeline: one issue, start to finish

| ID | Feature | Status | Milestone | Where |
|---|---|---|---|---|
| R-01 | Intake: read the issue or symptom, quote it as data, find duplicates and stop conditions | `designed` | M2 | [spec §5](specs/core-single-issue-pipeline.md) |
| R-02 | Recon: build and test commands, contribution rules, AI-policy verdict | `designed` | M2 | [spec §5](specs/core-single-issue-pipeline.md) |
| R-03 | Environment: plain clone, sandbox tier, retrying build, fingerprint | `designed` | M2 | [spec §5](specs/core-single-issue-pipeline.md) |
| R-04 | Reproduce: a failing test in the project's own framework, run several times | `designed` | M2 | [spec §5](specs/core-single-issue-pipeline.md) |
| R-05 | Human checkpoints: after reproduction and at the submit gate | `designed` | M2 | [spec §6](specs/core-single-issue-pipeline.md) |
| R-06 | Root cause: the chain from symptom to the first faulty line | `designed` | M2 | [spec §5](specs/core-single-issue-pipeline.md) |
| R-07 | Fix: the smallest change, the full suite, the project's linters | `designed` | M2 | [spec §5](specs/core-single-issue-pipeline.md) |
| R-08 | Review: a fresh context, a different vendor where possible, behavior compared | `designed` | M2 | [spec §8](specs/core-single-issue-pipeline.md) |
| R-09 | Write-up: dossier, pull request body, commit message with `Assisted-by` | `designed` | M2 | [spec §10](specs/core-single-issue-pipeline.md) |
| R-10 | Submit: fork at the gate, guarded push, draft pull request, ready after fork CI | `designed` | M2 | [spec §5](specs/core-single-issue-pipeline.md), [ADR-0006](adr/0006-fork-at-submit-gate-draft-pull-requests.md) |
| R-11 | Run state machine with budgets, stop reasons and an event ledger | `verified` | M1 | [code](../scripts/lib/state.mjs), [tests](../tests/state.test.mjs), [CI](https://github.com/pacphi/riverwright/pull/1) |

### Safety: nothing public without you

| ID | Feature | Status | Milestone | Where |
|---|---|---|---|---|
| S-01 | Git pre-push guard bound to the approved commit and branch | `verified` | M1 | [code](../scripts/lib/guard.mjs), [tests](../tests/guard.test.mjs), [ADR-0004](adr/0004-three-locks-primary-lock-in-git.md), [CI](https://github.com/pacphi/riverwright/pull/1) |
| S-02 | Host hook entry with a deny dialect per host that fails closed (payload shapes come from documentation until captured in M3) | `verified` | M1 | [code](../scripts/lib/commands/hook.mjs), [tests](../tests/hook.test.mjs), [CI](https://github.com/pacphi/riverwright/pull/1) |
| S-03 | Command classifier that parses like a shell and denies what it cannot resolve | `verified` | M1 | [code](../scripts/lib/hooks/classify.mjs), [tests](../tests/classify-bypass.test.mjs), [CI](https://github.com/pacphi/riverwright/pull/1) |
| S-04 | Sanitizer for hidden characters in upstream text | `verified` | M1 | [code](../scripts/lib/sanitize.mjs), [tests](../tests/sanitize.test.mjs), [CI](https://github.com/pacphi/riverwright/pull/1) |
| S-05 | Approvals bound to an exact commit or content hash, with terminal confirmation | `verified` | M1 | [code](../scripts/lib/approvals.mjs), [tests](../tests/approvals.test.mjs), [ADR-0005](adr/0005-approvals-bound-to-exact-content.md), [CI](https://github.com/pacphi/riverwright/pull/1) |
| S-06 | Two independent security reviews and two hardening passes | `verified` | M1 | [tests](../tests/seams.test.mjs), [research](research/evidence-base.md), [CI](https://github.com/pacphi/riverwright/pull/1) |
| S-07 | Credential separation: push and API credentials reach only the submit and post commands, approvals kept outside the workspace | `proposed` | M2 | [spec §7](specs/core-single-issue-pipeline.md) |
| S-08 | Install the guard into a clone: disabled upstream push URL, empty credential helper, pre-push hook | `designed` | M2 | [spec §7.1](specs/core-single-issue-pipeline.md) |
| S-09 | Generated hooks always carry the workspace path and cover shell tools only | `designed` | M2 | [spec §7.2](specs/core-single-issue-pipeline.md) |

### Existing repositories: install without harm

| ID | Feature | Status | Milestone | Where |
|---|---|---|---|---|
| X-01 | Managed blocks in `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` | `verified` | M1 | [code](../scripts/lib/blocks.mjs), [tests](../tests/blocks.test.mjs), [ADR-0008](adr/0008-never-overwrite-existing-repositories.md), [CI](https://github.com/pacphi/riverwright/pull/1) |
| X-02 | Additive JSON merge, exact removal, backups outside the repository, ownership markers | `verified` | M1 | [code](../scripts/lib/project.mjs), [tests](../tests/project-remove.test.mjs), [CI](https://github.com/pacphi/riverwright/pull/1) |
| X-03 | `riverwright setup --project` with dry run and per-file consent | `verified` | M1 | [code](../scripts/lib/commands/setup.mjs), [tests](../tests/setup-cli.test.mjs), [CI](https://github.com/pacphi/riverwright/pull/1) |

### Distribution and onboarding

| ID | Feature | Status | Milestone | Where |
|---|---|---|---|---|
| D-01 | Claude Code plugin and marketplace from this repository | `designed` | M2 | [spec §12](specs/core-single-issue-pipeline.md) |
| D-02 | `riverwright doctor`: a read-only checkup that prints the fix for anything missing | `designed` | M2 | [spec §12.3](specs/core-single-issue-pipeline.md) |
| D-03 | `/upstream-setup` wizard: idempotent, dry-run, asks before each change | `designed` | M2 | [spec §12.3](specs/core-single-issue-pipeline.md) |
| D-04 | Install paths for Codex, Gemini CLI, Cursor, Grok Build and Hermes | `designed` | M4 | [spec §12.2](specs/core-single-issue-pipeline.md) |
| D-05 | Team onboarding through repository settings | `designed` | M2 | [spec §12.4](specs/core-single-issue-pipeline.md) |
| D-06 | Directory listings for each host's marketplace | `proposed` | M8 | [spec §12.5](specs/core-single-issue-pipeline.md) |
| D-07 | Launchers `riverwright` and `rw` for macOS, Linux and Windows | `verified` | M1 | [code](../bin/riverwright), [tests](../tests/launcher.test.mjs), [CI](https://github.com/pacphi/riverwright/pull/1) |

### Hosts

| ID | Feature | Status | Milestone | Where |
|---|---|---|---|---|
| H-01 | Claude Code reference adapter | `designed` | M2 | [spec §13](specs/core-single-issue-pipeline.md), [ADR-0002](adr/0002-portable-skill-core-generated-adapters.md) |
| H-02 | Codex adapter | `designed` | M4 | [host checks](research/evidence-base.md) |
| H-03 | Gemini CLI adapter | `designed` | M4 | [host checks](research/evidence-base.md) |
| H-04 | Cursor adapter | `designed` | M4 | [host checks](research/evidence-base.md) |
| H-05 | Grok Build adapter | `designed` | M4 | [host checks](research/evidence-base.md) |
| H-06 | Hermes Agent adapter | `designed` | M4 | [host checks](research/evidence-base.md) |
| H-07 | Dispatch ladder: native subagent, else headless process, else inline | `designed` | M2 | [spec §8](specs/core-single-issue-pipeline.md) |
| H-08 | Adapter generator from one source, with a drift check | `designed` | M2 | [spec §13](specs/core-single-issue-pipeline.md) |

### Batch: many issues at once

| ID | Feature | Status | Milestone | Where |
|---|---|---|---|---|
| B-01 | Scan an upstream's open issues and triage which to work | `proposed` | M5 | [research](research/evidence-base.md) |
| B-02 | Detect twin issues by error signature, then by files touched | `proposed` | M5 | [research](research/evidence-base.md) |
| B-03 | Lanes by touched files, trial merge, tests run across fixes together | `proposed` | M5 | [research](research/evidence-base.md) |
| B-04 | Pacing and merge order, with `Depends on #n` in each body | `proposed` | M5 | [research](research/evidence-base.md) |

### Follow and adopt: close the loop

| ID | Feature | Status | Milestone | Where |
|---|---|---|---|---|
| W-01 | Thread record and audit data model | `designed` | M6 | [spec](specs/thread-record-and-audit.md), [ADR-0007](adr/0007-follow-and-adopt-loop-own-vocabulary.md) |
| W-02 | Hash-chained event ledger with `ledger verify` | `designed` | M6 | [spec §9](specs/thread-record-and-audit.md) |
| W-03 | Follower: release confirmation, replies, staleness | `proposed` | M6 | [spec](specs/thread-record-and-audit.md) |
| W-04 | Read-only import from agentic-kit's upstream-watch registry | `designed` | M6 | [spec §11](specs/thread-record-and-audit.md) |
| W-05 | Status reports for threads and workarounds | `proposed` | M6 | [spec](specs/thread-record-and-audit.md) |
| A-01 | Adoption: a draft change in your repository that removes the workaround | `proposed` | M7 | [spec](specs/thread-record-and-audit.md) |
| A-02 | Correspondence drafts: replies, nudges and supplements, approval-gated | `proposed` | M7 | [spec](specs/thread-record-and-audit.md) |
| A-03 | Escalation ladder from a comment to a pull request | `proposed` | M7 | [spec](specs/thread-record-and-audit.md) |

### Evidence and the story

| ID | Feature | Status | Milestone | Where |
|---|---|---|---|---|
| E-01 | Evidence export feeding the story's badges | `verified` | M1 | [code](../scripts/lib/evidence.mjs), [tests](../tests/evidence-contract.test.mjs), [CI](https://github.com/pacphi/riverwright/pull/1) |
| E-02 | "Paddling Upstream" illustrated story with evidence badges (design version published) | `in-progress` | M3 | [story](story/paddling-upstream.html), [tests](../tests/evidence-contract.test.mjs) |
| E-03 | Story rewritten from real runs, in a 10-year-old's voice with a git primer | `designed` | M3 | [spec §11.1](specs/core-single-issue-pipeline.md) |

### Quality and process

| ID | Feature | Status | Milestone | Where |
|---|---|---|---|---|
| Q-01 | CI matrix: Ubuntu, macOS and Windows on Node 24 and 26 | `verified` | M1 | [workflow](../.github/workflows/ci.yml), [CI](https://github.com/pacphi/riverwright/pull/1) |
| Q-02 | Dependabot for GitHub Actions and npm | `implemented` | M0 | [config](../.github/dependabot.yml) |
| Q-07 | Markdown linting in CI and locally (`npm run lint:md`) | `implemented` | M0 | [config](../.markdownlint-cli2.jsonc), [workflow](../.github/workflows/ci.yml) |
| Q-08 | The runtime stays dependency-free, enforced by a test | `implemented` | M0 | [test](../tests/runtime-dependencies.test.mjs), [ADR-0003](adr/0003-dependency-free-node-runtime.md) |
| Q-03 | Fixture repository with planted bugs, including twins and a same-function pair | `designed` | M3 | [spec §15](specs/core-single-issue-pipeline.md) |
| Q-04 | Real captured hook payloads replacing documented ones | `proposed` | M3 | [plans](plans/README.md) |
| Q-05 | First real upstream run (candidate `ruvnet/ruflo#3509`), every public step approved | `designed` | M3 | [spec §15](specs/core-single-issue-pipeline.md) |
| Q-06 | Roadmap and documentation layout enforced by tests | `implemented` | M0 | [roadmap test](../tests/roadmap.test.mjs), [layout test](../tests/docs-layout.test.mjs) |

## Decisions

Each consequential decision has an [architecture decision record](adr/README.md). The ones that shape the
roadmap:

| Date | Decision | Record |
|---|---|---|
| 2026-09-29 | Fixed documentation taxonomy; tool default locations overridden | [ADR-0001](adr/0001-documentation-taxonomy.md) |
| 2026-09-29 | One portable skill core, adapters generated for six hosts | [ADR-0002](adr/0002-portable-skill-core-generated-adapters.md) |
| 2026-09-29 | Dependency-free Node runtime for Windows, macOS and Linux | [ADR-0003](adr/0003-dependency-free-node-runtime.md) |
| 2026-09-29 | Three locks; the primary lock lives in git | [ADR-0004](adr/0004-three-locks-primary-lock-in-git.md) |
| 2026-09-29 | Approvals bound to exact content; the agent never signs the DCO | [ADR-0005](adr/0005-approvals-bound-to-exact-content.md) |
| 2026-09-29 | Fork at the submit gate; draft pull requests | [ADR-0006](adr/0006-fork-at-submit-gate-draft-pull-requests.md) |
| 2026-09-29 | Follow and adopt in Riverwright's own vocabulary; named Riverwright | [ADR-0007](adr/0007-follow-and-adopt-loop-own-vocabulary.md) |
| 2026-09-29 | Existing repositories are never overwritten | [ADR-0008](adr/0008-never-overwrite-existing-repositories.md) |

## Risks and open items

| Item | Why it matters | Owner |
|---|---|---|
| The approval record is still a file an agent can write | until credential separation (S-07), a determined agent could forge consent | M2 |
| Hook payloads for Codex, Gemini, Cursor and Grok come from documentation | the deny logic is tested against assumed shapes until captured (Q-04) | M3 |
| Windows PowerShell 5.1 behavior is covered by CI, not by a local run | the first Windows run already found one fail-open bug | continuous |
| Trademark search for the name "Riverwright" is not done | required before any public launch | M8, owner |
| The thread-record spec awaits the owner's approval | Spec 4 and 5 design depends on it | owner |
| Whether agentic-kit switches to Riverwright's checker | affects how much the import must preserve | later |

## Keeping this document current

1. Update the status and links in the same change that alters them. A feature moves one keyword at a time.
2. When a milestone's exit criteria are all met, set it to `verified` and update **Current milestone** above.
3. Add a row to the change log below for every milestone change or notable decision.
4. `tests/roadmap.test.mjs` rejects unknown statuses, unknown milestones, dangling links, an `implemented`
   or later feature with no link to code, tests or CI, and a `verified` or `released` feature with no
   `https` evidence.
5. The pull request template asks whether this file changed.

## Change log

| Date | Change |
|---|---|
| 2026-09-29 | Markdown linting (markdownlint-cli2) added to CI and as `npm run lint:md`; a test pins the dependency-free runtime. |
| 2026-09-29 | Roadmap created. M0 and M1 verified (CI green on six jobs); M2 designed; the documentation layout and eight decision records adopted. |
