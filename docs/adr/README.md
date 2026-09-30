# Architecture decision records

An ADR records why a consequential choice was made, so a later change is deliberate, not accidental. The
format follows the convention used across ruflo: numbered files, a frontmatter block, then Context,
Decision, Consequences, Verification, Related and Implementation status. Start from
[0000-template.md](0000-template.md).

**Rules**

- File name `NNNN-kebab-title.md`; numbers are never reused.
- Status is `Proposed`, `Accepted`, `Deprecated` or `Superseded by ADR-NNNN`.
- An accepted ADR is not rewritten. To change a decision, write a new ADR and mark the old one superseded.
  Only the Implementation status section is kept current.
- Every ADR appears in the table below. `tests/docs-layout.test.mjs` checks this.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-documentation-taxonomy.md) | Documents live in a fixed taxonomy; tool default locations are overridden | Accepted |
| [0002](0002-portable-skill-core-generated-adapters.md) | One portable skill core, with per-host adapters generated from one source | Accepted |
| [0003](0003-dependency-free-node-runtime.md) | A dependency-free Node runtime that works on Windows, macOS and Linux | Accepted |
| [0004](0004-three-locks-primary-lock-in-git.md) | Three independent locks; the primary lock lives in git, not in any host | Accepted |
| [0005](0005-approvals-bound-to-exact-content.md) | Human approval is bound to an exact commit or content hash; the agent never signs the DCO | Accepted |
| [0006](0006-fork-at-submit-gate-draft-pull-requests.md) | Work on a plain clone, create the fork only at the submit gate, open drafts | Accepted |
| [0007](0007-follow-and-adopt-loop-own-vocabulary.md) | Riverwright follows threads to release and adopts fixes, in its own vocabulary | Accepted |
| [0008](0008-never-overwrite-existing-repositories.md) | Existing repositories are never overwritten: managed blocks and additive merges only | Accepted |
