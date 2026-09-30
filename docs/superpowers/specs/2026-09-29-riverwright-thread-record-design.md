# Riverwright thread record: the shared seam between filing, watching and adopting

| Field | Value |
|---|---|
| Status | Draft for review |
| Date | 2026-09-29 |
| Scope | The data format and rules that let a Riverwright run hand an upstream thread to the watcher (Spec 4) and the adopter (Spec 5). No watcher or adopter code is designed here. |
| Builds on | [Spec 1](2026-09-29-riverwright-core-design.md) §11, §12.6, §14 |
| Compatible with | agentic-kit's upstream watch (`src/lib/hook-audit/agentic-dependency-constraints.json`, `docs/upstream-watch.md`) |

## 1. Why this exists

Riverwright now covers a loop: find a problem in an upstream dependency, fix it, send it, then follow it
until the fix ships and the downstream repository can stop carrying a workaround. The middle of that loop
already exists (Spec 1). The end of it exists too, in agentic-kit: a registry of 125 upstream threads with a
daily checker, a ledger, and a dispatch step. What is missing is the join: when a run opens a pull request,
the watcher must learn about it without a person copying a URL into a JSON file.

This document defines the record both sides read and write. It is deliberately a **superset of agentic-kit's
existing watch entry**, so agentic-kit's file is valid input from the first day and agentic-kit can adopt the
shared module later without a migration.

## 2. Words used

| Term | Meaning |
|---|---|
| **Thread** | One upstream issue or pull request that matters to this repository. Ours (filed or opened by us), someone else's that we depend on, or one we only reference. |
| **Constraint** | A downstream workaround with a version gate, a retest date and a removal proof. Not an upstream thing: it lives in our repository and exists because of one or more threads. |
| **Run** | One Riverwright pipeline execution for one issue (Spec 1). |
| **Registry** | The repository's list of threads and constraints. Project data, committed with the code. |
| **Ledger** | The append-only history of what the watcher and the pipeline observed and did. |

A thread and a constraint stay separate records, joined by ids (`constraintIds` on a thread), exactly as in
agentic-kit. Merging them would make every upstream thread carry downstream policy.

## 3. Where things live

| Data | Location | Who writes | Committed? |
|---|---|---|---|
| Project settings and registry pointer | `riverwright.json` at the repository root (created by `riverwright setup --project`) | the user; `setup` adds absent keys only | yes |
| Registry (threads + constraints) | either the `watch` and `constraints` keys inside `riverwright.json`, or an external file named by its `registry` key (agentic-kit's `src/lib/hook-audit/agentic-dependency-constraints.json` is a valid target) | Riverwright for entries it created; humans for the rest | yes |
| Run state and run ledger | `~/.riverwright/<owner>/<repo>/runs/issue-<n>/` (Spec 1 §3.4) | the pipeline | no |
| Watch ledger | tier 1 and 2: `~/.riverwright/<owner>/<repo>/watch/events.ndjson`; tier 3: an orphan branch in the repository (agentic-kit's `upstream-watch-ledger` model) | the watcher | tier 3 only |

The three watcher tiers (on demand, local schedule, opt-in GitHub Actions) are Spec 4's job. This record does
not depend on which one runs.

## 4. Thread record, `riverwright-thread/1`

Every field marked *(ak)* exists today in agentic-kit's registry with the same name and meaning.

```json
{
  "id": "ruvnet/ruflo#3509",
  "url": "https://github.com/ruvnet/ruflo/issues/3509",
  "kind": "issue",
  "relation": "filed",
  "title": "Codex backend starts a subcommand that no longer exists",
  "dependency": "ruflo",
  "doneWhen": {
    "state": "closed-completed",
    "release": { "channel": "npm", "name": "ruflo", "minVersion": null, "tagPattern": "v{version}", "bundledBy": [] }
  },
  "mapping": "mapped",
  "kitImpact": { "refs": ["constraint ruflo-codex-mcp-server"], "files": [] },
  "adjustment": "Once a Ruflo release contains the fix, stop pinning the wrapper and remove the constraint.",
  "status": "watching",
  "constraintIds": ["ruflo-codex-mcp-server"],
  "tracks": [],
  "history": [ { "date": "2026-10-02", "event": "filed" }, { "date": "2026-10-02", "event": "registered" } ],

  "origin": "riverwright-run",
  "run": {
    "id": "ruvnet/ruflo#3509",
    "kind": "real",
    "branch": "riverwright/3509-codex",
    "pr": { "url": "https://github.com/pacphi/ruflo/pull/12", "upstreamUrl": "https://github.com/ruvnet/ruflo/pull/3611", "state": "draft", "sha": "4e1a9c03b7d25f6e81a4c0d93b2f7e5a6c1d8b40" },
    "dossier": "runs/issue-3509/dossier.md"
  },
  "voice": { "lastOutbound": null, "pendingDraft": null }
}
```

**Fields carried over (ak):** `id`, `url`, `kind` (`issue` | `pr`), `relation`, `title`, `dependency`,
`doneWhen`, `mapping`, `kitImpact`, `adjustment`, `status`, `constraintIds`, `tracks`, `history`.

**Fields added by Riverwright** (agentic-kit ignores them; it never rewrites them):

| Field | Meaning |
|---|---|
| `origin` | `riverwright-run` (created by a pipeline run), `manual` (a person added it), or `imported` (read from a foreign registry). Riverwright edits only `riverwright-run` entries and the added fields of others. |
| `run` | Link to the pipeline run that produced the thread: run id, `kind` (`real` or `fixture`), the branch, the pull request (fork URL, upstream URL, state, approved SHA) and the dossier path. Absent for threads Riverwright did not create. |
| `voice` | Correspondence bookkeeping: when we last wrote upstream and what we have drafted but not posted (a content hash, never the text). Spec 5 uses it. |

**`relation`** is agentic-kit's set plus one value: `contributed` means we opened a pull request for someone
else's issue. `filed` (we opened the issue), `commented`, `referenced` and `tracking` are unchanged.

**`status` is agentic-kit's lifecycle, unchanged:** `watching` → `fixed-unreleased` → `released` →
`dispatched` → `adopted` → `retired`. Pull request details (draft, ready, changes requested, merged, closed)
live in `run.pr.state`, not in `status`, so an agentic-kit reader never meets a value it does not know.

## 5. Events

The ledger keeps agentic-kit's line format, so its tooling and notices keep working:

```text
UPSTREAM-WATCH <id> <event> <yyyy-mm-dd> [key=value ...]
```

agentic-kit's events are unchanged: `reply`, `acknowledged`, `closed`, `merged`, `released`, `reopened`,
`stale`, `retire-proposed`, `retest-due`, `idle`, `fired`, `dispatch-pr`.

Riverwright adds these, all written by the pipeline or the correspondence step, never by the watcher's
network reads:

| Event | Written when | Fields |
|---|---|---|
| `registered` | a run creates the entry | `run=` |
| `pr-opened` | `riverwright submit` opens the draft pull request | `pr=`, `sha=` |
| `pr-ready` | the pull request is marked ready after fork CI | `sha=` |
| `changes-requested` | a maintainer asks for changes and the run reopens at `fix` | `by=` |
| `draft-prepared` | a reply, nudge or supplement is drafted | `kind=`, `hash=` |
| `posted` | the human approved and `riverwright post` published it | `kind=`, `hash=`, `url=` |
| `adopt-drafted` | Spec 5 opened the downstream draft pull request | `pr=` |

Every `posted` line carries the content hash the human approved (Spec 1 §6), so the ledger shows that the
published text matched the approved text.

## 6. Who may change what

1. **The watcher records events and never changes `status`.** This is agentic-kit's rule and it is kept: a
   person, a run, or the adopter changes a status and adds a dated `history` line.
2. **A run creates its thread at the submit gate's completion,** not before. Registering is a local write
   (no public action, no approval). The entry starts at `status: watching`, `relation: filed` or
   `contributed`, with `history` `filed` (or `pr-opened`) and `registered`.
3. **Riverwright never rewrites a field it did not create.** For `origin: manual` or `imported` entries it
   may add `run` and `voice`, and nothing else. A hand-written adjustment or removal proof is never touched.
4. **Every public action stays behind its gate.** Posting an issue or comment uses the `post-issue` and
   `post-comment` gates (Spec 1 §6). Opening a pull request uses the submit gate. The registry never
   authorizes a publication. agentic-kit's per-dependency `issuePublication:
   explicit-user-approval-required` is the default for every dependency.
5. **Unknown fields survive.** A reader must preserve keys it does not recognize when it writes a file back,
   so agentic-kit and Riverwright can both edit one registry.
6. **Registry text from upstream is untrusted.** Titles, bodies and comments enter the record only after the
   sanitizer (Spec 1 §7.4), and are quoted as data wherever a model reads them.

## 7. Constraints

Riverwright reads agentic-kit's constraint shape and preserves it: `id`, `dependency`, `kind`,
`affected`, `releaseUrl`, `primaryEvidence`, `strategy`, `versionGate`, `expiryPolicy`, `nextRetestAt`,
`sunsetWhen`, `notification`. It creates constraints itself only at the adopt step (Spec 5), because a
constraint records work that exists in the downstream repository. Until then a thread's `constraintIds` may
be empty.

## 8. What each later spec gets from this

| Spec | Reads | Writes |
|---|---|---|
| **4 Watch and status** | threads, `doneWhen`, `dependency` policy, constraint retest dates | events; the report ("needs our reply", "released and actionable", …, agentic-kit's groups) |
| **5 Adopt and correspond** | threads with `status` `released`, `voice`, the dossier | `adopt-drafted`, `draft-prepared`, `posted`; status changes to `dispatched` and `adopted`, each with a `history` line |

## 9. Change to Plan 2

`riverwright submit` (Plan 2) must, after the draft pull request opens: create or update the thread record
as in §6.2, append `pr-opened`, and store the `run` link. `riverwright evidence export` gains a `threads`
count. Nothing else in Plan 2 depends on this document.

## 10. Decided and deferred

**Decided here:** the record is a superset of agentic-kit's watch entry; threads and constraints stay
separate; `status` stays agentic-kit's lifecycle; pull request state lives in `run.pr.state`; the watcher
never changes `status`; registering a thread is not a public action.

**Deferred to Spec 4:** the checker's tiers and scheduling; release confirmation for ecosystems beyond npm
and GitHub releases; how the support-window idea generalizes; the ledger branch and notices.

**Deferred to Spec 5:** correspondence templates and tone (agentic-kit's "Reporting upstream" five-part
report is the starting point); the escalation ladder from a nudge to a pull request; adoption pull requests
in the downstream repository.

**Deferred to the agentic-kit adoption:** whether agentic-kit keeps its own checker code or consumes
Riverwright's. This record is written so either choice works.
