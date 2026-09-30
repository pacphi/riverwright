# Riverwright thread record and audit data model

| Field | Value |
|---|---|
| Status | Draft for review (revision 2) |
| Date | 2026-09-29 |
| Scope | The data Riverwright keeps about upstream threads, workarounds, correspondence and its own actions: what is stored, where, who may change it, and how it is audited. The checker (Spec 4) and the adopter (Spec 5) are designed later against this. |
| Builds on | [Spec 1](core-single-issue-pipeline.md) §3.4, §6, §7, §11 |
| Prior art | agentic-kit's upstream watch. Concepts are borrowed; its terms are not. See §11 for the import path. |

## 1. Why this exists

Riverwright runs a loop: find a problem in an upstream dependency, fix it, send it, then follow the thread
until the fix ships and the downstream repository can drop its workaround. The pipeline (Spec 1) covers the
first half. Following and adopting is the second half. When a run opens a pull request, the follower must
learn about it without a person copying a URL into a file, and every step in between must be explainable
later: who did what, on what evidence, with whose approval, and what happened next.

This document defines that data. It owns its own vocabulary. Anything borrowed from agentic-kit's upstream
watch is renamed to fit Riverwright, and §11 maps the old names to the new ones for importing.

## 2. Words used

| Term | Meaning |
|---|---|
| **Thread** | One upstream issue or pull request that matters to this repository: one we opened, one we commented on, one we only reference, or one of our own that waits on upstream. |
| **Workaround** | Something this repository carries because an upstream thread is unresolved: a pin, a shim, a guard. It has a version gate, a retest date and a removal proof. It lives in our repository, not upstream. |
| **Upstream** | An upstream project the repository depends on, with the rules for dealing with it (publication policy, evidence required, supported versions). |
| **Run** | One pipeline execution for one issue (Spec 1). |
| **Registry** | The repository's committed list of threads, workarounds and upstreams. |
| **Ledger** | The append-only, hash-chained history of everything Riverwright observed and did. |
| **Correspondence** | Every message we drafted, approved, posted or received on a thread. |

## 3. Three stores, split by what may be shared

Committed data is read by teammates and by public tooling. Local data may hold drafts, logs and
environment detail that must not leave the machine.

| Store | Contents | Location | Committed? |
|---|---|---|---|
| **Registry** | thread, workaround and upstream records; minimal and public-safe | `riverwright.json` (keys `threads`, `workarounds`, `upstreams`) or an external file named by its `registry` key | yes |
| **Run record** | everything about one run: state, approvals, evidence digests, cost, time, dossier, drafts | `~/.riverwright/<owner>/<repo>/runs/issue-<n>/` (Spec 1 §3.4) | no |
| **Ledger** | the event stream for the repository, hash-chained | `~/.riverwright/<owner>/<repo>/ledger/events.ndjson`; optional mirror on an orphan branch (Spec 4 tier 3) | mirror only |

**Rule:** the registry holds ids, URLs, titles, statuses and short public facts. It never holds a dossier,
a draft, a log, an environment fingerprint, a token or an email address. Those stay in the run record, and
the registry points at them by path or hash.

## 4. Thread record, `riverwright-thread/1`

```json
{
  "schema": "riverwright-thread/1",
  "id": "ruvnet/ruflo#3509",
  "url": "https://github.com/ruvnet/ruflo/issues/3509",
  "kind": "issue",
  "relation": "opened",
  "title": "Codex backend starts a subcommand that no longer exists",
  "upstream": "ruflo",
  "addresses": [],
  "waitsOn": [],
  "impact": {
    "summary": "Codex sessions started through the bridge exit immediately.",
    "severity": "high",
    "affectedVersions": ">=3.40.0 <3.46.0",
    "workaroundExists": true,
    "usedAt": ["src/bridge/launch.mjs"],
    "refs": []
  },
  "adoption": {
    "plan": "When a release contains the fix, drop the wrapper and remove the workaround.",
    "files": ["src/bridge/launch.mjs"],
    "removalProof": "the bridge starts Codex with the released package and the conformance suite passes"
  },
  "resolvedWhen": {
    "state": "closed-completed",
    "release": { "channel": "npm", "name": "ruflo", "minVersion": null, "tagPattern": "v{version}", "bundledBy": [] }
  },
  "status": "watching",
  "workaroundIds": ["ruflo-codex-launch-wrapper"],
  "links": { "relatedTo": [], "duplicateOf": null, "dependsOn": [], "supersededBy": null },
  "history": [
    { "date": "2026-10-02", "event": "opened" },
    { "date": "2026-10-02", "event": "registered" }
  ],
  "origin": "run",
  "imported": null,
  "run": {
    "id": "ruvnet/ruflo#3509",
    "kind": "real",
    "branch": "riverwright/3509-codex",
    "pr": { "url": "https://github.com/ruvnet/ruflo/pull/3611", "forkUrl": "https://github.com/pacphi/ruflo/tree/riverwright/3509-codex", "state": "draft", "approvedSha": "4e1a9c03b7d25f6e81a4c0d93b2f7e5a6c1d8b40" }
  },
  "voice": { "lastOutboundAt": null, "pendingDraftHashes": [] }
}
```

| Field | Meaning |
|---|---|
| `kind` | `issue` or `pr` |
| `relation` | `opened` (we opened this issue or pull request), `commented`, `referenced`, `internal` (our own tracking issue that waits on upstream threads) |
| `upstream` | key into `upstreams` |
| `addresses` | for a pull request we opened: the issue ids it fixes |
| `waitsOn` | for an `internal` thread: the upstream thread ids it waits for |
| `impact` | why this matters to us: who and what it hurts, how badly, over which versions, and where our code touches it |
| `adoption` | what we change when a fix is released, and the proof that the workaround can go |
| `resolvedWhen` | what counts as done upstream: the thread state, and the release (package channel and name, first fixed version, tag spelling, and the package that carries it to us when it arrives indirectly) |
| `status` | the lifecycle in §5 |
| `links` | relationships between threads (§8) |
| `origin` | `run` (created by a pipeline run), `manual` (added by a person), `imported` (§11) |
| `run` | link to the pipeline run: run id, `real` or `fixture`, branch, pull request URLs and state, the approved commit |
| `voice` | correspondence bookkeeping: when we last wrote upstream and hashes of drafts not yet posted (never the text) |

Pull request progress (draft, ready, changes requested, merged, closed) lives in `run.pr.state`, not in
`status`, so the lifecycle stays about the upstream fix.

## 5. Lifecycle

`watching` → `fixed` → `released` → `adopting` → `adopted` → `retired`, plus the terminal `declined`.

| Status | Meaning |
|---|---|
| `watching` | open upstream |
| `fixed` | closed as completed or merged; no release contains it yet |
| `released` | a published release contains the fix; our change is pending |
| `adopting` | a draft pull request in our repository makes the change |
| `adopted` | we rely on the fix; the workaround can go |
| `retired` | nothing left to watch |
| `declined` | closed as not planned or unmerged; the workaround stays and the reason is recorded |

**Only a person, a run or the adopter changes a status,** and each change adds a dated `history` line. The
follower records events and never changes a status (§9).

## 6. Workaround record, `riverwright-workaround/1`

`id`, `upstream`, `kind` (`pin`, `blocked-version`, `shim`, `guard`, `patch`), `affected` (versions),
`evidence` (primary source and date), `strategy`, `versionGate`, `retestPolicy`, `nextRetestAt`,
`sunsetWhen`, `owner` (who is responsible for removing it), `threadIds`, and `status` (`active`,
`retest-due`, `removal-proposed`, `removed`). A workaround is created by the adopter or by a person, never
by a run, because it records work that exists in the downstream repository.

## 7. Upstream record, `riverwright-upstream/1`

`name`, `owner`, `publication` (default `explicit-user-approval-required`), `evidenceRequired` (installed
version, affected range, minimal reproduction, expected versus observed, artifact digest),
`retestPolicy`, `removalProof`, `supportedVersions` (how many recent minors we support and for how long,
with its basis), `policySnapshot` (§8, the contribution and AI-policy text as it stood), and `contact`
etiquette notes (for example "issue first", "release branches only", "no external merges seen").

## 8. Audit and tracking data

Each row says what is recorded, in which store, and why it is worth keeping.

| Area | What is recorded | Store | Why |
|---|---|---|---|
| **Actor and provenance** | for every event: actor type (`human`, `agent`, `watcher`, `import`), the account, the host id and version, the model, the Riverwright version and schema version | ledger | who did what, with which tool, so results can be explained and reproduced |
| **Time** | `at` (when it happened, upstream time for observed facts) and `recordedAt` (when we wrote it), both UTC | ledger | separates observed from recorded; exposes clock lies |
| **Evidence digests** | SHA-256 of the dossier, the diff, the reproduction test, the logs, the fingerprint, and the reviewer verdict; the base, head and approved commits; CI run URLs and results | run record, digests in ledger | the ledger proves what was approved without holding the content |
| **Approvals** | gate, binding (commit or content hash), mode (`host-ask` or `tty`), who, when, revoked or not | run record, event in ledger | consent is a fact with a receipt |
| **Policy snapshots** | the upstream's contribution and AI policy: URL, retrieval time, SHA-256 of the text, our verdict; DCO and CLA status; how the AI disclosure was worded (its hash) | run record, verdict on the upstream record | shows we complied with the rules as they stood on the day |
| **Decisions and stops** | every early exit and its reason; budgets used and left; reviewer vendor and verdict; why a candidate was rejected | run record | explains why nothing was sent, or why this fix and not another |
| **Reproduction quality** | how many runs, how many failed as expected, on the pinned version and on upstream HEAD; flakiness | run record | tells maintainers, and us, how solid the report is |
| **Impact** | who and what is affected, severity, versions, our call sites, whether a workaround exists | thread (`impact`) | drives priority and the adoption plan |
| **Relationships** | `relatedTo`, `duplicateOf`, `dependsOn` (for example "Depends on #n"), `supersededBy`, `addresses`, batch cluster id | thread `links`, run | dependency-ordered merging and duplicate handling (Spec 3) |
| **Correspondence** | every message: direction, thread, author login (public), kind (`report`, `reply`, `nudge`, `supplement`), content hash, approval reference, URL when posted, when received, latency since the last message | ledger; texts in the run record | proves posted text equals approved text; measures responsiveness |
| **Maintainer engagement** | first response time, review rounds, changes requested and their categories, approvals, merge or close and by whom | ledger (events), derived metrics | tells us which upstreams welcome help and how to pace |
| **Cost and effort** | tokens, estimated spend and wall-clock per phase and per run, by host and model; human waiting time at gates | run record | shows the real cost of a fix and the value of the approach |
| **Outcome** | `merged`, `merged-modified`, `superseded`, `fixed-elsewhere`, `declined`, `withdrawn`, `expired`; time from report to merge, to release, to adoption | thread (`history`, outcome event), metrics | the measurable benefit, and material for the story |
| **Security observations** | hidden-character findings by sanitizer, injection flags, guard and hook allow and deny counts with reasons | ledger | evidence that the locks worked, and early warning when they do not |
| **Compliance** | DCO attestation (who, when, which commit), license and CLA notes, disclosure wording | run record | the human's certification is recorded with the commit it covered |
| **Adoption** | the change that removed a workaround: pull request, commit, removal proof result, date | thread, workaround, ledger | closes the loop with evidence |

**What is never stored:** tokens or secrets, email addresses, raw environment variables, or full text of
third-party comments beyond a quoted excerpt with its source. Third-party author names appear only as the
public login already on the thread.

**Retention:** the registry keeps every thread until it is `retired`, then keeps the record. Run records
keep their digests indefinitely and their large artifacts (logs, drafts) for a configurable period,
default 180 days. `riverwright watch export --redact` writes a shareable report without local paths.

## 9. Ledger events

One JSON object per line in `events.ndjson`:

```json
{
  "schema": "riverwright-event/1",
  "seq": 41,
  "at": "2026-10-02T14:03:11Z",
  "recordedAt": "2026-10-02T14:03:12Z",
  "thread": "ruvnet/ruflo#3509",
  "run": "ruvnet/ruflo#3509",
  "event": "pr-opened",
  "actor": { "type": "agent", "host": "claude-code", "hostVersion": "2.1.284", "model": "claude-opus-5-5", "riverwright": "0.1.0", "account": "pacphi" },
  "data": { "pr": "https://github.com/ruvnet/ruflo/pull/3611", "sha": "4e1a9c03b7d25f6e81a4c0d93b2f7e5a6c1d8b40" },
  "evidence": [ { "kind": "diff", "sha256": "b1946ac92492d2347c6235b4d2611184b1946ac92492d2347c6235b4d261118" }, { "kind": "dossier", "sha256": "3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b" } ],
  "prev": "sha256:9f2c1e7d4ab86f03c5e92b17d84a6f1e0c3b5d7a92e4f861a0b3c7d5e9f12a48"
}
```

`prev` is the SHA-256 of the previous line, so editing, removing or reordering an earlier event breaks the
chain. `riverwright ledger verify` walks the chain and reports the first break.

**Event names:**

| From | Events |
|---|---|
| the pipeline | `opened`, `registered`, `run-started`, `station-passed`, `station-failed`, `stopped`, `approved`, `pr-opened`, `pr-ready`, `changes-requested`, `draft-prepared`, `posted` |
| the follower (Spec 4) | `reply`, `acknowledged`, `closed`, `merged`, `released`, `reopened`, `stale`, `retest-due`, `checked`, `check-failed` |
| the adopter (Spec 5) | `adoption-drafted`, `adopted`, `workaround-removed`, `retired` |
| a person | `reviewed`, `status-changed`, `note` |

**Limits, stated plainly:** the chain makes edits visible, but an agent that can write the file could
rewrite the whole chain. Two things narrow that. First, the chain head is copied into the registry
(`ledgerHead`) at each commit, so a rewritten history no longer matches what is in git. Second, the
optional orphan-branch mirror (Spec 4) publishes the head where the agent's local write cannot change it.

## 10. Who may change what

1. **The follower records events and never changes a status.**
2. **A run registers its thread when the submit station completes,** not before. Registering is a local
   write, not a public action, so it needs no approval. It starts at `watching`, `relation: opened`, with
   `history` `opened` and `registered`.
3. **Riverwright edits only records it created.** For `origin: manual` or `imported` records it may add
   `run` and `voice` and nothing else; a hand-written `adoption` or `removalProof` is never touched.
4. **Every public action stays behind its gate.** Posting an issue or comment uses `post-issue` and
   `post-comment`; opening a pull request uses the submit gate. The registry never authorizes a
   publication; the default `publication` for every upstream is `explicit-user-approval-required`.
5. **Unknown fields survive.** Any reader that rewrites a file must keep keys it does not recognize.
6. **Text from upstream is untrusted.** It enters a record only after the sanitizer (Spec 1 §7.4) and is
   quoted as data wherever a model reads it.

## 11. Importing from agentic-kit's upstream watch

agentic-kit's registry already tracks 125 threads. Riverwright can adopt them without touching agentic-kit's
file and without agentic-kit changing anything.

```bash
riverwright watch import --from <path to agentic-dependency-constraints.json> [--dry-run]
```

The import is **read-only** on the source, **idempotent** (records are matched by the original id, kept in
`imported.id`), and **additive** (it never overwrites a record a person has edited). Each imported record has
`origin: "imported"` and `imported: { "from": "agentic-kit-upstream-watch", "id": "<original id>", "at": "<date>" }`.
Running it again picks up new entries and reports what changed. Whether agentic-kit later consumes
Riverwright's checker instead of its own is a separate decision that this design leaves open.

**Field mapping**

| agentic-kit | Riverwright |
|---|---|
| `id`, `url`, `kind`, `title` | same |
| `relation` `filed` / `commented` / `referenced` / `tracking` | `opened` / `commented` / `referenced` / `internal` |
| `dependency` | `upstream` |
| `doneWhen` | `resolvedWhen` (same `state` and `release` fields) |
| `mapping` | dropped; whether we carry a change is implied by `impact` and `adoption` |
| `kitImpact` (`refs`, `files`) | `impact` (`refs`, `usedAt`) |
| `adjustment` | `adoption.plan` |
| `constraintIds` | `workaroundIds` |
| `tracks` | `waitsOn` |
| `status` `watching` / `fixed-unreleased` / `released` / `dispatched` / `adopted` / `retired` | `watching` / `fixed` / `released` / `adopting` / `adopted` / `retired` |
| `history` events | same, with `filed` becoming `opened` |
| `constraints[]` | `workarounds[]`: `kind`, `affected`, `versionGate`, `nextRetestAt`, `sunsetWhen` kept; `primaryEvidence` → `evidence`; `expiryPolicy` → `retestPolicy`; `notification` → correspondence requirements on the linked upstream |
| `dependencyPolicies[]` | `upstreams[]`: `issuePublication` → `publication`; `evidenceRequired`, `retestPolicy`, `removalProof` kept; `supportWindow` → `supportedVersions` |
| `watchPolicy` | the follower's settings: home repository, our logins, stale limit, automated-reply patterns, ledger branch, notification target, adoption branch prefix |
| ledger lines `UPSTREAM-WATCH <id> <event> <date> k=v` | event objects with `actor.type: "import"`, the original line kept in `data.original` |

Anything without a home in the table is preserved under `imported.extra` so nothing is lost.

## 12. What the later specs get from this

| Spec | Reads | Writes |
|---|---|---|
| **4 Follow and report** | threads, `resolvedWhen`, `upstreams`, workaround retest dates | events; reports |
| **5 Adopt and correspond** | threads with status `released`, `voice`, the dossier, `upstreams.contact` | `adoption-drafted`, `draft-prepared`, `posted`; status changes with `history` |

## 13. Change to Plan 2

After the draft pull request opens, `riverwright submit` must: register the thread (§10.2), append
`pr-opened` and the hash-chained event with its evidence digests, write the `run` link, and store the
policy snapshot and approval receipts in the run record. `riverwright evidence export` gains thread and
metric counts. Every ledger writer in Plan 1 (`appendEvent`) moves to the `riverwright-event/1` shape with
`seq`, `actor` and `prev`. That change belongs to Plan 2's first task, so the runtime and the record agree
from the start.

## 14. Decided and deferred

**Decided here:** Riverwright-native vocabulary with an import mapping (§11); three stores split by what may
be shared (§3); thread, workaround and upstream as separate records; the lifecycle in §5 with `declined`;
pull request state in `run.pr.state`; a hash-chained JSON ledger with the limits stated (§9); the audit
model in §8; the registry never holds drafts, logs or secrets.

**Deferred to Spec 4:** the follower's tiers and schedule; release confirmation beyond npm and GitHub
releases; how `supportedVersions` generalizes; the ledger mirror and notifications.

**Deferred to Spec 5:** correspondence templates and tone; the escalation ladder from a nudge to a pull
request; adoption pull requests in the downstream repository.

**Deferred:** whether agentic-kit switches to Riverwright's checker after the import.
