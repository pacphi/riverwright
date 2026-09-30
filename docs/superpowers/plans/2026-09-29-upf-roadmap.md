# upstream-pr-filer implementation roadmap

Spec: [`docs/superpowers/specs/2026-09-29-upstream-pr-filer-core-design.md`](../specs/2026-09-29-upstream-pr-filer-core-design.md)

Spec 1 is built through three plans. Each ends with working, tested software. Plans 2 and 3 are written
in full once the interfaces from the plan before them exist in code, so they are written against real
names and types rather than guesses.

| Plan | Builds | Done when |
|---|---|---|
| **1. Runtime** ([plan](2026-09-29-upf-plan-1-runtime.md)) | `upf` launchers and CLI; paths, atomic writes, process spawning (with Windows `.cmd` handling); sanitize; approvals and terminal confirmation; the state machine and ledger; the git pre-push guard; host hook entry and dialects; managed blocks, additive JSON merge, diffs; project integration and removal (`upf setup --project`); fingerprint; evidence export | `node --test` passes on ubuntu-latest, macos-latest and windows-latest, and the evidence contract test matches the story in `docs/story/` |
| **2. Plugin** | Skills (`upstream-contribute` + one reference per phase, `upstream-status`, `upstream-setup`), roles, dossier/PR/issue/commit templates, `upf doctor`, the `upf setup` wizard, `upf init` (clone, disabled upstream push URL, empty credential helper, pre-push hook, worktree), policy scanner, `upf dispatch`, `upf submit`/`post` with `--dry-run`, the adapter generator and the Claude Code plugin + marketplace manifests | `claude plugin validate --strict` passes; the plugin installs from a local marketplace; `upf submit --dry-run` lists exactly the approved actions; generated-adapter drift check is clean |
| **3. Proof** | The fixture repo (`agentic-incubator/upf-fixture`), end-to-end runs in Claude Code, Codex and Gemini CLI, captured hook payloads replacing documented ones, the first real upstream run (candidate `ruvnet/ruflo#3509`), and the story rewrite (Spec 1 §11.1) | Spec 1 §15 done criteria; the story describes how the toolkit actually worked, with evidence |

Plan 3 contains outward actions (creating the fixture repository, pushing to a real fork, opening a real
pull request). Each is a human-approval step for the user, never an executor step.
