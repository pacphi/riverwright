# Implementation plans

Spec: [`docs/specs/core-single-issue-pipeline.md`](../specs/core-single-issue-pipeline.md)

**Approved by the owner on 2026-09-30:** Plans 2a, 2b and 2c, ADR-0012 and ADR-0013 (agents read GitHub through
`riverwright read`; Plan 2b is being revised to match). Execution: subagent-driven, starting with Plan 2a; the method
for 2b and 2c is decided after 2a. Nothing is built until the owner gives the go-ahead.

Spec 1 is built through three plans. Each ends with working, tested software. Plans 2a to 2c were written
against a verified scratch prototype of the plan before them, so they name real functions and types; Plan 3 is
written once Plan 2 exists in code.

| Plan | Builds | Done when |
|---|---|---|
| **1. Runtime** ([plan](2026-09-29-plan-1-runtime.md)) | `riverwright` launchers (and the short alias `rw`) and CLI; paths, atomic writes, process spawning (with Windows `.cmd` handling); sanitize; approvals and terminal confirmation; the state machine and ledger; the git pre-push guard; host hook entry and dialects; managed blocks, additive JSON merge, diffs; project integration and removal (`riverwright setup --project`); fingerprint; evidence export | `node --test` passes on ubuntu-latest, macos-latest and windows-latest, and the evidence contract test matches the story in `docs/story/` |
| **2a. Security foundation** ([plan](2026-09-30-plan-2a-security-foundation.md)) | The hash-chained ledger and `ledger verify`; the sealed credential vault and `riverwright credential`; signed receipts and the public gate (passphrase unlock, bounded in-process retry); the guard trusting receipts; `approve` narrowed to `checkpoint-1`; the ambient-credential audit; the guard installed into a clone; the optional FIDO2 push key; hooks that always carry `--home` and deny `riverwright credential` | `node --test` passes on the CI matrix; a forged approval, a reused or expired receipt and a rewritten ledger are each refused by the guard; the manual terminal checks are recorded and two independent security reviews are triaged |
| **2b. CLI, skills and publish** ([plan](2026-09-30-plan-2b-cli-skills-and-publish.md)) | `riverwright init` (clone, guard, worktree, run record, `--symptom`), `submit` and `post` with `--dry-run` on the 2a gate and a `node:https` GitHub client, `doctor`, the `setup` wizard, the templates, roles, the `upstream-contribute`, `upstream-status` and `upstream-setup` skills, and the safe-probe host references | `submit --dry-run` lists exactly the approved actions; every behavior that needs real GitHub is marked unverified until the first real run; a Codex security review of `submit` and `post` is triaged |
| **2c. Adapters and plugin** ([plan](2026-09-30-plan-2c-adapters-and-plugin.md)) | `adapter-src/` and `tools/generate-adapters.mjs` with a `--check` drift mode in CI; the Claude Code adapter, plugin and marketplace manifests; shell-tools-only hooks with a symbolic `--home`; generated hook-dialect blocks for the other five hosts (documented stubs); the install guide and team onboarding | `claude plugin validate --strict` passes on both manifests; the drift check is clean; the local-marketplace install is an owner step |
| **2d. Dispatch and policy scanner** (to be written after 2c) | `riverwright dispatch` (native subagent, else headless host, else inline; H-07) and the deterministic policy scanner for the recon phase (part of R-02) | written against the real 2a to 2c code |
| **Walking skeleton** ([checklist](2026-09-30-walking-skeleton-checklist.md)) | Owner-run checks of the assumptions the plans rest on: hidden typing on each OS, a fork-scoped token opening a pull request, pushing with the token in one child's environment, a leased push and the pre-push hook's input, the fork CI banner, and a real install from a `plugin/` folder | Results recorded in the checklist and appended to the research records; the plans adjusted where a check failed |
| **3. Proof** | The fixture repo (`pacphi/riverwright-fixture`), end-to-end runs in Claude Code, Codex and Gemini CLI, captured hook payloads replacing documented ones, the first real upstream run (candidate `ruvnet/ruflo#3509`), and the story rewrite (Spec 1 §11.1) | Spec 1 §15 done criteria; the story describes how the toolkit actually worked, with evidence |

After the core (Plans 1 to 3), the same product grows in three more specs that share one thread record
([design](../specs/thread-record-and-audit.md)): **Spec 3 batch mode** (scan, twins, lanes, pacing),
**Spec 4 follow and report** (follow threads until the fix ships) and **Spec 5 adopt and correspond** (remove the
workaround, keep the conversation friendly). Each gets its own plan once the one before it exists in code.

Plan 3 contains outward actions (creating the fixture repository, pushing to a real fork, opening a real
pull request). Each is a human-approval step for the user, never an executor step.
