# Riverwright implementation roadmap

Spec: [`docs/superpowers/specs/2026-09-29-riverwright-core-design.md`](../specs/2026-09-29-riverwright-core-design.md)

Spec 1 is built through three plans. Each ends with working, tested software. Plans 2 and 3 are written
in full once the interfaces from the plan before them exist in code, so they are written against real
names and types rather than guesses.

| Plan | Builds | Done when |
|---|---|---|
| **1. Runtime** ([plan](2026-09-29-riverwright-plan-1-runtime.md)) | `riverwright` launchers (and the short alias `rw`) and CLI; paths, atomic writes, process spawning (with Windows `.cmd` handling); sanitize; approvals and terminal confirmation; the state machine and ledger; the git pre-push guard; host hook entry and dialects; managed blocks, additive JSON merge, diffs; project integration and removal (`riverwright setup --project`); fingerprint; evidence export | `node --test` passes on ubuntu-latest, macos-latest and windows-latest, and the evidence contract test matches the story in `docs/story/` |
| **2. Plugin** | Skills (`upstream-contribute` + one reference per phase, `upstream-status`, `upstream-setup`), roles, dossier/PR/issue/commit templates, `riverwright doctor`, the `riverwright setup` wizard, `riverwright init` (clone, disabled upstream push URL, empty credential helper, pre-push hook, worktree), policy scanner, `riverwright dispatch`, `riverwright submit`/`post` with `--dry-run`, the adapter generator and the Claude Code plugin + marketplace manifests | `claude plugin validate --strict` passes; the plugin installs from a local marketplace; `riverwright submit --dry-run` lists exactly the approved actions; generated-adapter drift check is clean |
| **3. Proof** | The fixture repo (`agentic-incubator/riverwright-fixture`), end-to-end runs in Claude Code, Codex and Gemini CLI, captured hook payloads replacing documented ones, the first real upstream run (candidate `ruvnet/ruflo#3509`), and the story rewrite (Spec 1 §11.1) | Spec 1 §15 done criteria; the story describes how the toolkit actually worked, with evidence |

After the core (Plans 1 to 3), the same product grows in three more specs that share one thread record
([design](../specs/2026-09-29-riverwright-thread-record-design.md)): **Spec 3 batch mode** (scan, twins, lanes, pacing),
**Spec 4 follow and report** (follow threads until the fix ships) and **Spec 5 adopt and correspond** (remove the
workaround, keep the conversation friendly). Each gets its own plan once the one before it exists in code.

Plan 3 contains outward actions (creating the fixture repository, pushing to a real fork, opening a real
pull request). Each is a human-approval step for the user, never an executor step.
