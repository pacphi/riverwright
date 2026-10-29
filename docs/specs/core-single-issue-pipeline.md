# Riverwright — Spec 1: the single-issue core

| Field | Value |
|---|---|
| Status | Approved 2026-09-29 |
| Date | 2026-09-29 |
| Scope | Spec 1 of 3: the single-issue pipeline, state, guardrails, roles, write-up, evidence export, and the Claude Code reference adapter |
| Follows | Spec 2 (the other five host adapters), Spec 3 (batch mode) |
| Research | [`docs/research/evidence-base.md`](../research/evidence-base.md) |
| Story | "Paddling Upstream" artifact, <https://claude.ai/artifact/RtwXsztmgYHXu2smHgvcqU> |

## 1. Intent

**What the user asked for.** A repeatable way to contribute fixes to upstream dependencies: fork the
upstream repo, start from an issue the user filed (or a symptom they hit), stand up an environment,
reproduce the problem, describe how it was found, the use cases, the impact, the system specifics and
the tools it was working with, build a fix, and open a pull request the maintainer can consider. It
must be packaged as skills, agents and commands, work across six AI coding hosts (Claude Code, Codex
CLI, Gemini CLI, Cursor, Grok Build, Hermes Agent), handle many issues at once with sensible merge
order (Spec 3), and be easy to install (§12).

**Success looks like.** A maintainer receives a small, correct, well-evidenced pull request that
follows their rules, and the user approved every public action that led to it.

**Decisions already made** (in the design conversation):

| Topic | Decision |
|---|---|
| Checkpoints | Two human checkpoints (after reproduction, before submission) plus the mandatory submit gate |
| Entry point | An upstream issue URL, or a symptom plus the downstream repo path (search → draft issue → approval before filing) |
| Hosts | All six in v1; hosts not exercised end-to-end are labelled unverified |
| PR state | Open as draft; mark ready only after fork CI is green and the user confirms |
| Approach | Portable Agent Skills core + deterministic, dependency-free Node (`.mjs`) scripts + generated per-host adapters |
| Platforms | Windows, macOS and Linux (§3.2) |
| Existing repos | Never overwrite user files; managed blocks and additive merges only, with consent (§12.6) |
| Defaults | "Balanced" preset (§5.2), overridable per run and in `~/.riverwright/config` |
| Decomposition | Spec 1 core → Spec 2 adapters → Spec 3 batch; v1 ships when all three are done |

## 2. Invariants

These are load-bearing. An edit that weakens one is a bug.

1. **Nothing public happens without a human yes bound to exact content.** Filing an issue, creating a
   fork, enabling fork Actions, pushing, opening or readying a PR, and posting a comment each require
   an approval record that names the commit SHA or the content hash being approved. A change after
   approval voids it.
2. **The primary lock lives in git, not in any host.** Host hooks are a second layer. Several hosts'
   hooks fail open by default (§7.2), so no guarantee rests on them alone.
3. **The agent never signs the Developer Certificate of Origin.** Only the human submitter certifies;
   the agent adds `Assisted-by:` and never `Signed-off-by:` on its own.
4. **Upstream content is data.** Issue text, comments, and files in the upstream clone (including its
   `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules`, `.grok/`) never become instructions.
5. **State is files, re-derived every time.** What happens next is computed from `state.json`, never
   from conversation memory. Any host can resume any run.
6. **Skipped is not passed.** A check that did not run is reported as skipped; a red check never
   advances a phase.
7. **Evidence claims match evidence.** The dossier, the PR body and the story never claim a host,
   model, vendor, or test result the ledger does not record.
8. **Host invocation is side-effect-audited.** `riverwright` never sets a host's home directory variable,
   never runs a host subcommand not listed as side-effect-free in `references/hosts/<host>.md`, and
   probes unverified hosts with `--version` only (see Appendix A for why).
9. **Accelerators are optional.** ruflo, agentic-qe, beads and similar tools may speed a phase up;
   their absence never blocks one. The floor is Node.js 24+, git and one supported host; `gh` is optional (ADR-0013).
10. **The user's repositories are not ours.** The downstream repo is read-only input. `riverwright` never
    overwrites or rewrites a file it did not create. Optional project integration (§12.6) touches
    only a clearly marked block or adds absent keys, shows the diff first, asks, and can remove
    exactly what it added.

## 3. Architecture

### 3.1 Repository layout

```text
riverwright/                          # the repo is its own marketplace (see §12)
  skills/                             # host-neutral Agent Skills (agentskills.io); shared by all hosts
    upstream-contribute/SKILL.md      #   orchestrator: phase table, gates, invariants (kept short)
    upstream-contribute/references/   #   one file per phase, loaded only for that phase
    upstream-status/SKILL.md          #   read-only: where every run stands, what happens next
    upstream-setup/SKILL.md           #   onboarding wizard (§12)
  roles/                              # scout, reproducer, investigator, fixer, reviewer (host-neutral)
  bin/riverwright  bin/riverwright.cmd  # tiny launchers (POSIX sh / Windows cmd) → node scripts/riverwright.mjs
  bin/rw  bin/rw.cmd                  # short alias for people → bin/riverwright / bin/riverwright.cmd
  scripts/riverwright.mjs             # single entry point (subcommands in §3.3); Node built-ins only
  scripts/lib/*.mjs
  templates/                          # dossier.md, pr-body.md, issue-body.md, commit-msg.txt,
                                      #   state.schema.json, evidence.schema.json, pre-push.sh
  references/hosts/<host>.md          # per-host action→tool map, safe subcommands, hook dialect
  adapter-src/                        # single source for commands, agents, hooks, permission rules
  tools/generate-adapters.mjs         # dev-time generator; CI fails when output is stale
  .claude-plugin/marketplace.json     # the repo root is only the marketplace: source ./plugin (ADR-0011)
  plugin/                             # GENERATED plugin folder: the only thing users receive (Spec 1 ships the Claude adapter)
  .codex-plugin/ gemini-extension.json commands/ agents/ .cursor-plugin/ .hermes-plugin/ …  # Spec 2
  docs/  tests/
  CLAUDE.md  AGENTS.md  GEMINI.md     # contributor instructions: the invariants above
```

Gemini CLI requires fixed `commands/`, `agents/` and `hooks/` directories at the extension root, so
those root directories belong to the Gemini adapter. The Claude adapter is generated into `plugin/`, together
with a copy of `bin/`, `scripts/`, `templates/`, `skills/`, `roles/` and `references/`, and `plugin/.claude-plugin/plugin.json`
describes it; contributor files are never copied ([ADR-0011](../adr/0011-generated-plugin-folder-marketplace-at-root.md)).

### 3.2 Runtime

Required: **Node.js 24 or newer** (Node 24 is the LTS baseline; CI also runs Node 26, which becomes LTS on 2026-10-28), `git`, one
supported host. Optional: Docker Desktop, OrbStack or another Docker engine for the container tier
(WSL2 on Windows).

**Why Node, not bash.** One codebase runs on Windows, macOS and Linux; JSON, paths and processes are
built in; and a guard written in bash fails *open* on Windows machines without bash. The
superpowers Windows hook launcher (`hooks/run-hook.cmd`) exits 0 when it cannot find bash, which is
the right call for a context hook but the wrong one for a safety guard. Node is already how
agentic-kit, autopilot's tooling, Codex, Gemini CLI and the generator run.

**Rules for `scripts/`:**

- **No npm runtime dependencies** (development tools such as the Markdown linter are `devDependencies`, never installed for users). Only Node built-ins (`node:fs`, `node:path`, `node:child_process`,
  `node:crypto`, `node:test`, `node:readline`, `node:util` `parseArgs`). Installing the plugin is a
  file copy; there is never a package-install step for users.
- **Launchers.** `bin/riverwright` (POSIX sh) and `bin/riverwright.cmd` (Windows) find `node` and run
  `scripts/riverwright.mjs`. If Node is missing they print how to install it and exit 1, or exit 2 when
  called as a hook, so a missing runtime denies instead of allowing. `bin/rw` and `bin/rw.cmd` are a
  short alias for people that run those launchers with the same arguments and exit codes.
- **Hooks** are generated as `node "<plugin root>/scripts/riverwright.mjs" hook <host>`, a command line that
  works unchanged in cmd.exe, PowerShell and sh. The entry point converts any exception to exit 2.
- **Git's pre-push hook** is a three-line POSIX sh file (Git for Windows ships sh) that `exec`s
  `node … riverwright.mjs guard pre-push`.
- **Child processes.** `git` and `gh` run through `execFile` with argument arrays, never a shell
  string. Host CLIs installed through npm are `.cmd` files on Windows, which Node refuses to spawn
  without a shell (Node docs, "Spawning .bat and .cmd files on Windows"). `riverwright` runs the host's
  JavaScript entry with `node` directly when it can find it, and otherwise uses `cmd.exe /d /s /c`
  with strict quoting of every argument.
- **Paths and files.** `node:path` everywhere; `RIVERWRIGHT_HOME` defaults to `os.homedir()/.riverwright`;
  existing line endings (LF or CRLF) are preserved on every write; writes are atomic (temp file +
  rename) and keep the file mode.
- **Terminal confirmation** (`tty` approval mode) reads from `/dev/tty` on macOS and Linux and from
  `CONIN$` on Windows.
- **Later option, not v1:** a single-file executable per platform (Node single executable
  applications) to drop the Node requirement.

### 3.3 `riverwright` subcommands

| Subcommand | Purpose |
|---|---|
| `riverwright doctor` | Detect hosts, versions, auth, Docker, hook trust/consent state; print what is missing and how to fix it; change nothing |
| `riverwright init <issue-url \| --symptom …> [--downstream PATH]` | Create the workspace and run record |
| `riverwright state get\|advance\|stop` | The only writer of `state.json`; rejects illegal transitions |
| `riverwright sanitize` | Strip and report invisible, bidi and tag characters (§7.4); quote text as data |
| `riverwright fingerprint` | Record OS, arch, runtime/toolchain versions, lockfile hashes |
| `riverwright dispatch <role> <run>` | Run a role via the dispatch ladder (§8) |
| `riverwright approve checkpoint-1 <run>` | Record a human approval for the one gate that publishes nothing (§6) |
| `riverwright ledger verify --run <dir> [--head sha256:<hex>] [--seq <n>]` | Check the ledger chain, the receipt signatures and that no nonce was used twice; exit 0 full pass, 1 a problem, 2 receipts not sign-checked (§7.5) |
| `riverwright credential setup\|status\|remove` | Manage the sealed credential vault and show the credential routes Riverwright cannot close (§7.5). A person runs it in a terminal; an agent's shell command that runs it is denied (§7.2) |
| `riverwright credential push-key set <file.pub>\|show\|clear` | Record the optional hardware push key (§7.5) |
| `riverwright guard pre-push` | The git pre-push check (§7.1) |
| `riverwright hook <host>` | Host hook entry: reads the host's payload, answers in that host's deny dialect (§7.2) |
| `riverwright setup [--project] [--remove] [--dry-run] [--yes\|--no-input]` | Onboarding wizard (§12.3) and optional project integration (§12.6) |
| `riverwright submit <run> [--dry-run]` | Perform the approved public actions |
| `riverwright post <run> <kind>` | Post an approved issue or comment |
| `riverwright evidence export [--run R]` | Emit `evidence.json` for the story (§11) |

### 3.4 Workspace and state

Everything lives outside any repository, under `${RIVERWRIGHT_HOME:-~/.riverwright}/<owner>/<repo>/`:

```text
profile.json                 # recon output, shared across issues; refreshed when upstream HEAD moves
clone/                       # plain clone of upstream (no fork yet)
worktrees/issue-<n>/         # one worktree per run, branch riverwright/<n>-<slug>
ledger/
  events.ndjson              # append-only, hash-chained events for this repository, all runs (thread-record spec §9)
  events.lock                # present only while a writer holds the ledger
runs/issue-<n>/
  state.json                 # phase, status, gates, approvals (schema-validated)
  dossier.md                 # the evidence (§10)
  issue.sanitized.md  fingerprint.json  repro/  pr-body.md  commit-msg.txt
knowledge/setup-patterns.jsonl   # failure → fix memory per build tool and ecosystem (all runs)
```

The sealed credential is not per repository. It sits at the top of the workspace home: `vault/vault.json`, and
`vault/push-key.json` when a hardware push key is set (§7.5).

## 4. Inputs

- **Issue mode:** an upstream issue URL, plus optionally the downstream repo path.
- **Symptom mode:** a description (error text, command, versions) plus the downstream repo path. The
  intake phase searches upstream issues by error signature; if none match, it drafts an issue from the
  upstream issue template and files it only after approval (`riverwright post`).

The downstream repo supplies the use case, the pinned upstream version, the call sites, and the tools
the upstream code was working with. Maintainers need all three.

## 5. The pipeline

### 5.1 Phases

| # | Phase | Role | Produces | May stop with |
|---|---|---|---|---|
| 0 | Intake | orchestrator | sanitized issue + comments; downstream context | closed, assigned, open PR exists; (symptom mode) duplicate found |
| 1 | Recon | scout | `profile.json`: build/test/lint commands (CI `run:` steps → Makefile/package scripts → README), DCO/CLA, commit convention, changelog rule, PR template, AI-policy verdict (allowed / disclosure required / banned / unclear) | AI contributions banned; unclear → ask the user |
| 2 | Environment | orchestrator | clone, disabled upstream push URL, pre-push guard, worktree, tier choice, retrying build with snapshots, fingerprint | cannot build (report lists everything tried) |
| 3 | Reproduce | reproducer | fail-to-pass test in upstream's framework (generate-passing-then-invert); N runs on the downstream-pinned version and on upstream HEAD | reproduces only on pinned (already fixed upstream → report, suggest upgrade); does not reproduce (user decides) |
| ◆ | **Checkpoint 1** | human | approve, redirect, or stop | |
| 4 | Root cause | investigator | the causal chain from symptom to first faulty line | |
| 5 | Fix | fixer | smallest diff; failing test green; full suite, linters, formatter green; changelog when required | fix budget exhausted |
| 6 | Review | reviewer | schema-validated verdict: scope, overfitting, behavioral diff base vs patched, conventions, disclosure | review budget exhausted |
| 7 | Write-up | orchestrator | `pr-body.md`, `commit-msg.txt` with `Assisted-by:` | |
| ◆ | **Submit gate** | human | approve the diff, the body, and the listed public actions; DCO attestation when required | |
| 8 | Submit | `riverwright submit` | fork (if missing), enable fork Actions, push, fork CI, draft PR (`Fixes #n`, maintainer edits allowed), then `gh pr ready` after green + confirmation | |

Every early exit writes a report into the dossier and may draft an issue comment; posting it needs
approval. Follow-up work after maintainer review re-enters at phase 5 and passes the submit gate again.

### 5.2 Presets (default: Balanced)

| Setting | Frugal | **Balanced** | Thorough |
|---|---|---|---|
| Reproduction runs | 2 | 3 | 5 |
| Fix attempts | 2 | 3 | 5 |
| Review → fix rounds | 1 | 2 | 3 |
| Candidate patches ranked by execution | 1 | 1 | 3 |
| Container tier | only if repo ships Dockerfile/devcontainer | when Docker is present and the repo ships one or runs install scripts | always when Docker is present |
| Cross-vendor reviewer | if available | if available | required (stop if none) |

## 6. Human checkpoints and approvals

`riverwright approve` writes `{gate, run, sha|content_hash, approved_at, host, mode}` into `state.json` for
`checkpoint-1`. Approval modes for that gate:

| Mode | How the human confirms | Default for |
|---|---|---|
| `host-ask` | The host's own permission prompt on `riverwright approve` (generated rule) | Claude Code, Codex, Gemini CLI, Cursor, Grok Build (interactive) |
| `tty` | `riverwright approve` reads a typed confirmation from the terminal (`/dev/tty`, or `CONIN$` on Windows) | Hermes Agent (all modes); any host run headless; opt-in everywhere |

Hermes `-z/--oneshot` auto-bypasses approvals, so Hermes never offers `host-ask`; a public action there needs
a real terminal for the unlock (§7.5) or hands back to an interactive session.

Public gates (`submit-gate`, `post-issue`, `post-comment`) have no separate `riverwright approve` step. The human
step is the **unlock** inside `riverwright submit` or `riverwright post` (§7.5): it always uses the terminal, on every
host, and it is what releases the credential. A host permission prompt cannot release the credential, so
`host-ask` and `--allow-host-ask-submit` do not apply to public gates ([ADR-0010](../adr/0010-sealed-credential-released-by-human-unlock.md)).
`checkpoint-1` publishes nothing and stays a plain `riverwright approve` record in either mode. No environment variable
chooses the mode. The submit-gate binding still names the run branch (`riverwright/<n>-<slug>`).

What is built (Plan 2a):

- `riverwright approve` accepts `checkpoint-1` only. Naming a public gate is refused with `USE_UNLOCK` and points at
  `riverwright submit` or `riverwright post`; the retired flags `--branch` and `--allow-host-ask-submit` are refused
  with a clear message. `--mode unlock` cannot be chosen here: only the gate records that mode, after a passphrase.
- The ledger names who acted (thread-record spec §8). In `tty` mode the human typed the first seven characters of the
  commit (or `yes` for content) at the terminal, so the `approval` event's actor is `human`. In `host-ask` mode the
  agent ran the command and the human's yes happened in the host's prompt, which Riverwright cannot see, so the actor
  is `agent` with the host, and the event says `confirmedVia: "host-prompt"`.
- A recorded approval is never proof for a public gate. `riverwright state begin submit` passes the gate only when
  the newest submit-gate receipt for the run is signed, anchored, unused, current and bound to the given commit
  (§7.5). It looks for that receipt the way the guard does: the vault and the ledger come from the account's own
  workspace (`~/.riverwright` of the account as the operating system records it), never from `RIVERWRIGHT_HOME`,
  `HOME` or a `--home` flag (refused from the command line), and `--run` must resolve, symlinks followed, to
  `<home>/<owner>/<repo>/runs/issue-<n>` with a matching run id. A run kept under a custom `RIVERWRIGHT_HOME`
  therefore cannot pass the submit station; it fails closed. This awaits the owner's decision.
- **When the submit station can begin** (ruling R40). The proof needs the newest receipt to be **unused**, and the
  gate writes the receipt just before its action and marks it used before `runPublicAction` returns (§7.5). So the
  proof passes only inside the action: before the unlock there is no receipt, and after the gate returns the receipt
  is used. `riverwright submit` therefore begins the submit station in its own process, inside the gate's action and
  before the push (§7.5 step 6). `riverwright state begin submit` run on its own from the command line is not part of
  the flow: it passes only while a gate's action is running, so it fails before the unlock and after the gate returns.

## 7. Guardrails

### 7.1 Lock 1: git (primary, every host)

- The clone's upstream remote push URL is `DISABLED_BY_RIVERWRIGHT`; local `credential.helper` is empty.
- `.git/hooks/pre-push` runs `riverwright guard pre-push`: allow only when the destination URL is the
  recorded fork (https on the default port, or ssh as `git@`; other schemes, ports and hosts never
  match), the ref is exactly the branch named in the submit-gate receipt, and the SHA equals the
  SHA the receipt signed.
- **Consent is a receipt, not a record.** The guard reads the newest submit-gate receipt for the run from the
  ledger and checks it against the public key in the vault (§7.5): signed, anchored to the ledger, unused, not
  expired and bound to a commit. `state.json` is not consulted for consent. A newer unlock supersedes every older
  receipt, so an older receipt never authorizes its commit again, and a used or expired newest receipt is not
  replaced by an older one. The newest receipt is chosen by its position in the ledger and then verified by that
  position, so a forged newer event is refused and never falls back to an older receipt.
- **Where a push may go.** A push to the upstream repository named in the receipt's run is refused in any URL
  form. The destination must also equal the fork the receipt signed (`host/owner/repo`), so a forged `fork.url` in
  `state.json` cannot send the approved commit anywhere else; a receipt that names no fork allows nothing. Deleting a
  branch, and pushing any branch not named `riverwright/…`, is refused.
- **Replacing the branch tip.** A push that does not fast-forward the remote branch is refused unless the receipt's
  `lease` equals the remote tip ([ADR-0012](../adr/0012-leased-force-push-for-resubmits.md)). With a lease, the
  only update allowed is replacing exactly that tip with the approved commit. Whether a push fast-forwards is decided
  by a walk over the commit history in Node that recomputes every object's hash from its content (SHA-1 or SHA-256,
  per the repository), follows parents only, stops at a cap (10,000 commits or 64 MiB read), and treats a mismatch, a missing object, a shallow
  boundary, a malformed commit or the cap as "not a fast-forward". It does not use `git merge-base`, because git does
  not check object hashes while it walks, and the clone is a place an agent can write.
- **The guard's own git.** Every git process the guard starts gets an environment built from an allowlist (`PATH`,
  `LANG`, `LC_ALL`, and on Windows `SYSTEMROOT`, `TEMP`, `TMP`, `PATHEXT`, `COMSPEC`), with no system or global
  config, no replace refs, no grafts and no lazy fetch. Variables from the pushing shell such as
  `GIT_TEST_COMMIT_GRAPH` or `GIT_ALTERNATE_OBJECT_DIRECTORIES` never reach it.
- **What the guard cannot stop.** Git connects to the remote before it runs the pre-push hook, so the guard stops
  the push, not the network connection. When git names no ref to update (everything up to date, or every ref
  refused by git itself, such as a stale `--force-with-lease`), the guard allows the empty push, after the same
  destination and receipt checks, and records "nothing to push". Every decision is written to the ledger; if it cannot be written, the push is refused.
- **Installing the guard** (`installGuard` in `scripts/lib/clone-guard.mjs`; `checkGuard` reports what is no
  longer true). It must be given only a workspace clone: it refuses a directory that is not the top of its own work
  tree (`NOT_CLONE_ROOT`), but given the root of a user's own repository it would replace that repository's local
  credential helpers. Before changing anything it refuses any `core.hooksPath` (even an empty one), an existing hook
  it did not write, a symbolic link or non-regular file in the hook's place, and a remote or push URL defined
  outside the clone's own config. Then it writes the hook (executable, carrying `--home`), removes the clone's local
  credential helpers and appends the empty reset, disables the push URL of every remote, and checks what git now
  resolves. It needs the workspace home and a script path that exists.
- The guard locates the run from the repository being pushed, not from environment variables or git
  config: `git rev-parse --show-toplevel` must be `<home>/<owner>/<repo>/worktrees/issue-<n>`,
  and `runs/issue-<n>/state.json` must carry the run id `<owner>/<repo>#<n>`. `<home>` is the `--home`
  written into the generated hook (`guard pre-push --home "<home>" -- "$@"`), or else `~/.riverwright` of
  the account as the OS records it; the guard and the host hooks never read `RIVERWRIGHT_HOME` or `HOME`
  from the environment. Commands a person runs (`init`, `setup`, `evidence`, `credential`) still honor
  `RIVERWRIGHT_HOME`. The checks that decide whether something public was approved do not: the guard (from its hook's
  `--home` or the account), and `ledger verify` and the submit proof of `state begin submit` (from the account only,
  §6 and §7.5). So a vault sealed under a custom `RIVERWRIGHT_HOME` is not the one `ledger verify` and the submit
  proof read; they fail closed rather than trust a home the environment chose. This awaits the owner's decision.
- The fork remote does not exist until the submit gate; `riverwright submit` alone supplies credentials for
  its own push (`-c credential.helper=…` scoped to that command).
- Agent-writable state is not a consent authority. `state.json`, the ledger and setup backups live under
  `RIVERWRIGHT_HOME`, which an agent with shell access can write, so Lock 1 stops accidental and
  injection-driven pushes, not a deliberate forger. The credential is what stops the forger: it is sealed and
  released only by the human's unlock (§7.5). The pre-push guard's receipt check is defense in depth: the public key
  it verifies against sits in a vault file the agent can replace.

### 7.2 Lock 2: host hooks (second layer)

Generated per host, active only for commands run under the workspace home (the hook command's `--home`), except
the credential rule below, which applies everywhere. They deny outward `gh` calls
(`pr create|ready|comment|edit`, `issue create|comment`, `repo fork`, `api` with a write method),
`git push --no-verify`, `-c core.hooksPath`, and edits to remote or credential config, unless the
command is `riverwright submit` or `riverwright post` as one plain command whose first word is the absolute path
of an installed launcher file, resolved to its real path (`bin/riverwright`, `bin/riverwright.cmd`, or
`scripts/riverwright.mjs` run by its own shebang); a program merely named `riverwright` gets no exemption, and
neither does the `rw` alias. Handing the launcher script to a runtime is not the launcher:
`node scripts/riverwright.mjs submit` (or `post`) is denied everywhere as `riverwright-publish-env` (ruling R37), so
skills and documents run the bin launcher directly.

Scope is decided from resolved paths: the payload cwd and every path in the command, after expanding
`~`, `$HOME`, `${HOME}`, `$RIVERWRIGHT_HOME` and `%USERPROFILE%`, following `cd` and `-C`, and resolving
symlinks. The classifier parses the command like a shell; anything it cannot resolve (a variable or
substitution as the program or git/gh subcommand, `eval`, code piped into a shell) is outward with
rule `unresolvable`. While any run is active, an outward command that contains an unresolved variable
or substitution is denied even outside the workspace, and so is an unreadable payload.

A generated hook command always carries `--home` with an absolute path; building one without it is refused
(`NO_HOME`), so no default or environment variable decides the workspace. The shell-tools-only matchers per host
arrive with the adapters (Plan 2c).

**An agent never runs `riverwright credential`.** A shell command that runs `riverwright credential` is denied in
every spelling the classifier can read (its limits are below), because sealing or removing the credential is done by the human in their own terminal. Unlike the
other rules, this one is always in scope: whatever the working directory, inside or outside the workspace, with or
without an active run, because the command acts on the account's vault wherever it runs. A hook sees only an agent's
tool calls, so this costs the human nothing. How it decides (the full rule and its limits are in the header of
`scripts/lib/hooks/classify.mjs`):

- **The subcommand slot.** The CLI dispatches on its first argument alone, so `riverwright credential` runs only
  when the word right after the program is `credential`. Each word is decoded the way the shell would (quotes,
  backslash escapes, ANSI-C `$'…'`, line continuations). For every word that is, or could be, riverwright, the next
  word is denied when it is `credential` (any case), or could be or could vanish into it: a variable or
  substitution, a glob that matches it, a brace, `%NAME%`, a PowerShell splat.
- **What counts as riverwright.** A literal `rw` or `riverwright` (as a name or last path component, with
  `.cmd`, `.mjs`, `.exe` and the like), `cli.mjs` or `credential.mjs`, a package such as `riverwright@latest`, or a
  path whose real path is one of the launcher files. A variable, glob or brace counts only where a program stands:
  in program position after the modelled wrappers, in the arguments of a wrapper that runs a program (`script`,
  `xargs`, `timeout`, `sudo` and others), as the script of `node` or `bun`, as the package of `npx` and the other
  runners, or as the first operand of a shell or interpreter. It never counts in an ordinary argument of an
  unknown program, so `rm "$A" "$B"` is allowed.
- **Nested commands** are read the same way: `sh -c`, `eval`, `ssh` remote commands and `ProxyCommand`,
  `git -c alias.x='!…'`, code piped into a shell, and assignments that are later run.
- **Known non-executing tools** (`grep`, `cat`, `ls`, `sed` and `awk` without their command-running forms, `find`
  without `-exec`, and others) do not have their arguments read as programs. `git` counts as non-executing only for
  a short allowlist of read-only subcommands, with no `-c`, no option that runs a command, and no alias of that
  name in any git config the hook can read; every other `git` command is read as one that may run its arguments.
  Every unknown program fails closed: its literal riverwright words are checked.

It **over-blocks by design** where a program may run its arguments, and these denials are machine-wide wherever
the hook is installed. Examples: `gh pr create --title 'rw credential fix'`, `git stash push -m 'rw credential
setup'`, `node "$S" "$A"`, `bash "$S" "$A"`, `xvfb-run cp "$A" "$B"`. Putting such text in a file and passing the file (`--body-file`, `git stash push -F`) avoids the credential denial;
`git commit -m` with that text is allowed, because `commit` is on the git allowlist.

**Its limits, stated plainly.** It reads one command line, so it cannot see a script file, Makefile or
`package.json` that the command runs, a command assembled from pieces or encoded (`base64 -d | sh`), a whole
command held in one variable and run elsewhere, or a renamed launcher it cannot resolve by path (a plain copy, a
hard link, a symlink reached by bare name through `PATH`). A shell reading a pipe it cannot read is only
`unresolvable`, which is denied in the workspace or during an active run, not machine-wide (otherwise every
installer pipe on the machine would be blocked). The command also needs a terminal to do harm, and a deliberate
agent running as the same user can reach the vault file without it. So this rule is a guard rail against accidents
and injected instructions; **the passphrase, typed by the human in their own terminal, is the real protection**
(§7.5).

The hook entry (`riverwright.mjs hook <host>`) converts every exception to exit code 2 and prints a deny
decision, and its launcher exits 2 when Node is missing, so a hook failure denies. Remaining per-host behavior, verified on this machine (evidence in `docs/research/evidence-base.md` §H):

| Host | Deny dialect | On hook crash/timeout | Adapter setting |
|---|---|---|---|
| Claude Code | exit 2, or `hookSpecificOutput.permissionDecision: "deny"` | per docs | standard |
| Codex | same shape as Claude | per docs; hooks require persisted trust | `riverwright doctor` checks trust |
| Gemini CLI | exit 2 or `{"decision":"deny"}`; Policy Engine rule | per docs | hook + policy rule |
| Cursor | exit 2 or `{"permission":"deny"}` | fail-open unless `failClosed: true` | `failClosed: true` |
| Grok Build 1.0.44 | exit 2, top-level `decision`, or `hookSpecificOutput.permissionDecision` (Claude verdicts honored) | non-2 exit fails open | exit-2 trap; Grok also loads Claude plugin hooks, so the generator must not double-register (§13) |
| Hermes Agent 0.21.5 | exit 2, `{"action":"block"}` or `{"decision":"block"}` | fail-open unless `fail_closed: true`; hooks do not fire until consented | `fail_closed: true`; `riverwright doctor` checks consent; headless needs `--accept-hooks` |

### 7.3 Lock 3: a human click

The **unlock** (§7.5): the human types the passphrase in a real terminal inside `riverwright submit` or
`riverwright post`, after seeing the exact payload. Host-native **ask** rules still guard `riverwright approve`
for `checkpoint-1` (Claude permission rules, Gemini Policy Engine `ask`, Codex approval policy, Cursor and Grok
permission rules) and are a courtesy prompt on `submit` and `post`, not the lock. Environment variables do not
change the mode.

**Residual risk, stated in user docs:** an agent with shell access that deliberately circumvents all
three layers can still push. The design makes accidental and injection-driven pushes fail and puts a
human action in front of every public step.

### 7.4 Untrusted input

- `riverwright sanitize` strips zero-width (U+200B–U+200D, U+2060, U+FEFF, U+180E), bidi controls (U+202A–U+202E,
  U+2066–U+2069), bidi marks (U+200E, U+200F, U+061C), soft hyphens (U+00AD), invisible operators
  (U+2061–U+2064), variation selectors (U+FE00–U+FE0F, U+E0100–U+E01EF) and tag characters
  (U+E0000–U+E007F), records what it found, and quotes the text into the dossier with provenance.
  Stripping U+FE0F can turn a colour emoji into its text form; the finding is reported.
- Upstream instruction files: subagents start without them where the host allows (Claude
  `omitClaudeMd`; Hermes `--ignore-rules`; headless runs from a neutral directory that reads the
  worktree by path). Anything suspicious in them is listed at Checkpoint 1.
- Container tier: non-root, worktree-only mount, no credentials in the container.

### 7.5 Credential separation: the sealed credential and the unlock

Decision and evidence: [ADR-0010](../adr/0010-sealed-credential-released-by-human-unlock.md),
[research](../research/credential-separation.md). Plan 2a built everything in this section except the `submit` and
`post` commands themselves, the `doctor` report and the push that uses the hardware key, which arrive in Plan 2b.
Nothing here has been checked in CI on all three systems or by the owner's manual checks yet (Plan 2a, Tasks 16
and 17).

**Vault.** `riverwright credential setup|status|remove` manages one vault file per account at
`<home>/vault/vault.json` (a person runs this command, so `<home>` honors `RIVERWRIGHT_HOME`; see §7.1 for what
that means for the checks), schema `riverwright-vault/1`: the key-derivation name, parameters and salt, the cipher
(`aes-256-gcm`), a random 12-byte nonce, the ciphertext and tag, the public signing key and the creation time. The
ciphertext holds the GitHub token and the Ed25519 private key. The schema, the key-derivation parameters and the
public key are authenticated with the ciphertext, so changing any of them makes decryption fail.

- **Key derivation.** Argon2id at 64 MiB, 3 passes, parallelism 1 where `crypto.argon2` exists (Node 24.7 or
  newer), otherwise scrypt at N=2^17, r=8, p=1 with an explicit `maxmem`. Setup refuses anything weaker than the
  OWASP minimum (Argon2id 46 MiB, t=1, p=1; scrypt N=2^17, r=8, p=1) with `WEAK_KDF`.
- **Inputs.** The passphrase must be at least 12 characters after Unicode NFKC normalization; the token must be 8
  to 4096 printable characters with no spaces. Both are read from a hidden terminal prompt, never from an argument,
  the environment or standard input. No terminal (`NO_TTY`), or a terminal that cannot hide typing
  (`NO_ECHO_CONTROL`), means nothing is asked and nothing is written.
- **A wrong passphrase is told apart from a broken setup.** `BAD_PASSPHRASE` is reported only when decryption fails
  its authentication check. When the key derivation itself cannot run (an Argon2id vault opened on a Node without
  `crypto.argon2`, or not enough memory), the error is `VAULT_KDF_UNAVAILABLE` and says the passphrase was not
  tried.
- **The commands.** `setup` refuses to overwrite an existing vault unless given `--replace`, which shows the old
  fingerprint and keeps no copy. `remove` asks the human to type `remove`. `status` prints the vault path, the
  key-derivation name, the creation time, the credential routes below, and the public-key fingerprint last, so
  nothing printed above it can scroll it away or pose as it. Every value read from the file passes through the
  printable filter (control, bidi and format characters removed), and the creation time must be a plain ISO-8601
  UTC time or the vault is refused.

**Unlock** (`runPublicAction` in `scripts/lib/gate.mjs`; `submit` and `post` are thin callers of it):

1. Check everything that needs no human first: the gate is public, the binding is a full commit SHA or a
   `sha256:` content hash, the host is known (`UNKNOWN_HOST`), only the submit gate names a branch, a fork and a
   lease, and the run directory holds the run named (`RUN_MISMATCH`). The caller computes the binding from the live
   repository or the normalized text, never from a stored record.
2. Print the caller's summary with every line indented, so upstream text with a newline cannot produce a line that
   reads as Riverwright's own words, then the gate's own line: the exact commit or content, and for the submit gate
   the branch and the fork as `host/owner/repo`, and, when there is a lease, "it replaces commit `<lease>`, which that
   branch holds now". The caller may have read the fork from `state.json`, which an agent can write, so this line is
   what the human checks. Ambient-credential warnings follow.
3. Read the passphrase from the terminal; with no terminal, or one that cannot hide typing, refuse and change
   nothing. Three wrong passphrases stop with `UNLOCK_REFUSED`. Each refusal (wrong passphrase, Ctrl-C, a terminal
   failure, a payload that changed or could not be recomputed) appends an `unlock-refused` event, best effort.
4. Recompute the binding after the unlock; if it changed, stop with `PAYLOAD_CHANGED` before anything is signed.
5. Sign a `riverwright-receipt/1` and append it as the `approved` ledger event, **before** the action. The receipt
   is not claimed first (ruling R12): it stays unused while the action runs, because the pre-push guard needs a
   signed, unused receipt during `git push` (§7.1). The gate also writes an `unlock` approval into `state.json` as a
   record; nothing treats it as proof.
6. Call `action({ token, receipt, attempt, signal, deadline })`. The action (Plan 2b) may pass the token to one child
   process through its environment, never through an argument list or a file, and pushes the exact SHA by name.
   For the submit gate, `riverwright submit` passes `fork` (the gate refuses a submit gate without one, `BAD_CALL`),
   and its action **first begins the run's submit station** with the submit proof (§6), in the same process, while
   the receipt is still unused, and **then pushes** (ruling R40). Beginning the station after `runPublicAction`
   returns always fails (`GATE_NOT_APPROVED`), because the receipt is used by then.
   The action's result must not contain the token: the gate returns it to the caller unchanged, and only its error
   path is cleaned (Task 17 F5). Plan 2b checks each action's result for the token when it builds the actions.
7. Record the outcome once: a `receipt-consumed` event with `succeeded` or `failed`. If that record cannot be
   written after a success, the gate says so and asks the human to run `riverwright ledger verify`. The caller then
   appends `pr-opened` or `posted`.

**Retry without retyping.** A failure the action marks `transient` (network error, 5xx, rate limit) is retried in
the same process: at most 3 attempts within 2 minutes, with a 2-second then a 5-second wait, recomputing the payload
before each retry and stopping if it changed. The window is checked just before every attempt, and `signal` aborts
when it ends; an attempt that runs past it ends with `ACTION_TIMEOUT` and the warning that it may already have been
published. A definitive failure (authentication refused, a rejected push, a validation error) is not retried. The
token and the private key are held in that call's memory only and the references are dropped when it returns, so a
second run needs a new unlock. The limits are constants in code, not settings an agent could change.

A changed payload, a missing terminal, a wrong passphrase, a used receipt or a failed signature each stop the action
with nothing published.

**Receipts.** A receipt (`scripts/lib/receipt.mjs`) has the schema, eleven signed fields and an Ed25519 signature.
The signed bytes are the line `riverwright-receipt/1`, a newline, and a JSON array in this fixed order: `gate`,
`run`, `binding.kind`, `binding.value`, `branch`, `fork`, `lease`, `ledgerHead`, `seq`, `at`, `nonce`. A fixed
array means no value can be moved into its neighbor without changing the bytes, and a missing field is refused
rather than signed as `null`.

- `branch`, `fork` and `lease` belong to the submit gate and are `null` on the other gates. `fork` is required on a
  submit-gate receipt, as the fork's `host/owner/repo` (for example `github.com/you/repo`). `lease` is `null` or
  the full SHA of the fork branch tip the human approved replacing ([ADR-0012](../adr/0012-leased-force-push-for-resubmits.md));
  it cannot be all zeros, the approved commit itself, or a SHA of another length.
- `ledgerHead` and `seq` are the head and position the receipt's own event takes, written under the ledger lock, so
  a rewrite of any earlier history breaks the receipt.
- `nonce` is 32 lowercase hex characters. A receipt is valid for 10 minutes and may be dated at most 60 seconds
  ahead.
- **Old receipts fail closed.** A receipt signed before `fork` and `lease` existed has neither key. It cannot say
  which fork it approved, so it never authorizes anything, and `ledger verify` reports it as a problem: the human
  unlocks again.
- **One claim, one final outcome.** A receipt's life is read from the `receipt-consumed` lines that name its nonce:
  unused, then either `claimed` and later one final outcome (`succeeded` or `failed`), or one final outcome
  directly. Only an unused receipt authorizes anything. A claimed receipt is already used: it allows nothing except
  recording its final outcome, once. Any other set of lines also counts as used.

**What the action may throw.** The gate never rethrows what the action or `recompute` threw. It builds a new error
with one of the codes `ACTION_FAILED`, `RECOMPUTE_FAILED` or `ACTION_TIMEOUT`, and keeps only a short list of the
original's own fields in `details`: `code` (if it is a plain upper-case code), `status` (an integer), `stack`,
`stderr`, `stdout`, `causes` and `transient`. Each string is scrubbed of the token's raw, URL-encoded, base64 and
hex forms and of every 16-character piece of it, then checked again; if any form survives, or reading the error
throws, the error becomes a generic message with nothing attached.

- **Raw bytes are omitted** (ruling R13). A Buffer, typed array or similar anywhere in the error becomes the text
  `[N bytes omitted]` and is never decoded.
- **The caller's contract** (ruling R14). A caller must decode tool output to UTF-8 strings itself before it throws,
  and must not pre-serialize it (`JSON.stringify`, `util.inspect`, `encodeURIComponent`). UTF-16 text that was
  serialized before it reached the gate can only be made generic, never recovered. The token must never go into
  error text, an argument list or a file.
- **`details.stack`** is the gate's own cleaned message over the original's frame lines. Its first line is never
  taken from the original; the class name is kept only when it is a plain identifier (so `TimeoutError` and
  `AbortError` stay readable). A frozen `Error.prepareStackTrace` makes every action error generic, and an error from
  another realm shows no stack (ruling R15).
- The remaining accepted limits (a token cut into pieces shorter than 16 characters, a deliberately obfuscated
  token, fields over 1 MiB read only in part) are listed in the header of `scripts/lib/gate.mjs`.

**Ledger verify.** `riverwright ledger verify --run <dir>` checks the hash chain, every receipt's signature,
position and anchor, and the `receipt-consumed` lines (each names an earlier receipt, carries a known outcome, and
follows the life above; no nonce appears in two receipts; no `approved` event lacks its receipt). It reads the public
key from the vault of the account's own workspace only, never from `RIVERWRIGHT_HOME`; `--home` is refused from the
command line. Exit codes: **0** a full pass (or no receipts to check), **1** a problem was found, **2** the chain is
fine but there are receipts and no vault at the account's workspace, so their signatures were not checked and this
is not a full pass. Without `--head` and `--seq` from a place the agent cannot write, it says that it cannot tell a
cleanly cut tail from a shorter valid ledger.

**Ambient credentials.** `riverwright credential status` reports the credential routes an agent could use without
Riverwright: token variable names (`GH_TOKEN`, `GITHUB_TOKEN` and their enterprise forms; never values), `gh` login
state (exit status only), a `gh` config file's presence, configured git credential helpers, the number of keys an SSH
agent holds, and private key file names in `~/.ssh` (only the first 100 bytes of each file are read, to see whether
it is a private key). It says what each means. A probe that cannot decide (a tool missing, a timeout, an unexpected
exit code, an unreadable folder) reports an "unchecked" finding rather than silence, so the audit never reads as safe
when it could not tell. `riverwright doctor` shows the same report once it exists (Plan 2b). Riverwright cannot
remove the user's own login.

**Optional hardware push key.** A FIDO2 `sk-` SSH key may sign the push only; pull requests and comments still use
the sealed token. `riverwright credential push-key set <file.pub>` records the key in `<home>/vault/push-key.json`
after checking that the public key is an `sk-` type and the private key file exists next to it (its contents are
never read). Every use re-reads and re-parses the public key and fails closed (`BAD_PUSHKEY`) unless it is still the
saved `sk-` type, so an edited config cannot point at an ordinary key. The push command is
`ssh -F /dev/null -o IdentityFile=none -i "<key>" -o IdentitiesOnly=yes -o IdentityAgent=none
-o CertificateFile=none -o PKCS11Provider=none -o ProxyCommand=none -o PubkeyAcceptedAlgorithms=<the sk types>`
(`-F NUL` on Windows), set as `GIT_SSH_COMMAND` in Riverwright's own spawn, never through the agent's shell. It
ignores the user's and the system's SSH configuration, so no other identity, proxy command or PKCS#11 provider can
be added (ignoring a file is not editing it, so ADR-0008 holds). The cost: the owner's host aliases, ports and
`ProxyJump` do not apply to this one push. This awaits the owner's decision. Riverwright cannot tell from the public key whether the key was made to
require a touch (`-O verify-required`). The push that uses this key arrives with `submit` (Plan 2b), and the touch
and PIN behavior are checked by hand (Plan 2a, Task 16); `-F NUL` on Windows is tested only as text.

**Limits, stated plainly.** The result is tamper-evident and injection-resistant, not tamper-proof.

- An agent that reads the terminal or the unlock process's memory, or that uses an ambient `gh` login, can still
  publish. Memory hygiene is best effort: JavaScript strings and key objects cannot be zeroed.
- The public key that verifies receipts lives in a file the agent can replace, so `ledger verify` and the guard
  prove consistency with that key, and the human trusts the key because they saw its fingerprint at setup. A
  deliberate agent running as the same user can forge a vault and re-chain the ledger.
- **Tail replay** (ruling R9). Rewriting or editing history before a receipt is detected. Removing the tail is
  not: if the last lines, such as the `receipt-consumed` event, are cut off, the shorter chain still verifies and a
  used receipt looks unused again until it expires (10 minutes). Only an anchor the agent cannot write closes this: a
  `--head` and `--seq` the human kept for `ledger verify`, or a published mirror of the head (Spec 4).
- **Crash window** (ruling R12). The receipt is written before the action and stays unused while it runs. If the
  process dies during the action, the receipt stays usable until it expires (10 minutes), bound to the exact SHA,
  branch and fork. In that window the guard would allow a push of exactly that commit by any route that has a
  credential, such as an ambient SSH key.
- The guard and the hooks stop accidents and injected instructions, not a deliberate forger with the same account.
- Windows: the terminal prompt, `/dev/null` as git's global config and graft file in the guard, `-F NUL` for the
  push key, and tests skipped on Windows have not been run on Windows yet.
- A separate operating-system user or a sandbox is the only route to full separation and is documented, not built.

## 8. Roles and dispatch

| Role | Access | Tier | Hands off |
|---|---|---|---|
| scout | read + `riverwright read` | small | `profile.json` |
| reproducer | edit + shell, worktree only | default | test + Reproduction section |
| investigator | read + shell | default | Root cause section |
| fixer | edit + shell, worktree only | default | diff + Fix section |
| reviewer | read-only, fresh context | strong, other vendor when available | JSON verdict |

Handoffs are files only; each role starts cold from `state.json`, the dossier and the diff, and returns
a summary of 10 lines or fewer. Dispatch ladder: native subagent → headless process of an installed
host (with output schema and budget caps where supported) → inline after writing a handoff file.
`review.vendor = auto` selects a host whose model family differs from the fixer's; the ledger records
the actual host and model, and the dossier says so plainly when review was same-vendor.

Headless commands per host (verified on this machine unless marked):

| Host | Headless form | Structured output | Read-only mode |
|---|---|---|---|
| Claude Code | `claude -p` | `--output-format json --json-schema` | `--permission-mode plan` |
| Codex | `codex exec` | `--output-schema` | `-s read-only` |
| Gemini CLI | `gemini -p` | `--output-format json` | `--approval-mode plan` |
| Cursor | `cursor-agent -p` | `--output-format json` | `--mode plan` |
| Grok Build | `grok -p` | `--json-schema` | `--permission-mode plan` |
| Hermes Agent | `hermes -z` (approvals bypassed) | `--usage-file` for cost only | none; reviewer role not dispatched headless to Hermes |

## 9. Setup memory

`knowledge/setup-patterns.jsonl` records each build failure and the fix that worked, keyed by build
tool and ecosystem, and is consulted by phase 2 before retrying. ruflo memory is an optional mirror.

## 10. Write-up

**Dossier sections:** how it was found (downstream narrative); use cases; impact (who, severity,
workaround); system specifics (table from `fingerprint.json`); tools involved (from the downstream
lockfile/environment); reproduction (steps + test); root cause; fix; testing done (commands and
results, repeat runs, full suite, behavioral diff); alternatives considered; AI disclosure.

**PR body:** the upstream PR template when present; otherwise one-sentence what and why → `Fixes #n`
→ motivation → minimal reproduction → root cause → change → testing → alternatives → AI-assistance
disclosure phrased for their policy. Long evidence goes in `<details>` blocks.

**Commit:** their convention; what and why; `Assisted-by: <host>:<model>`; `Signed-off-by` only after
the human attests at the submit gate; `Co-Authored-By` only when the upstream policy asks for it.

**Follow-up:** `upstream-status` tracks each PR and drafts a polite nudge after 14 quiet days
(configurable); posting needs approval.

## 11. Evidence export (the story stays honest)

`riverwright evidence export` reads ledgers and writes `evidence.json` (schema in
`templates/evidence.schema.json`):

```json
{ "generatedAt": "…", "runs": [ { "id": "ruvnet/ruflo#3509", "kind": "fixture|real",
  "stations": { "intake": {"status": "passed", "at": "…", "host": "claude-code", "model": "…",
  "artifact": "dossier#intake"} , "…": {} }, "pr": {"url": null, "state": null} } ],
  "hosts": { "grok-build": {"level": "verified-binary", "version": "1.0.44"} } }
```

The story publishes `evidence.json` as a sidecar file and loads it with a relative `fetch()`. Each
station and host shows one of three levels, with a static default in the markup so the page is
complete without the file:

1. **designed** (default), 2. **tested on the fixture**, 3. **observed in a real upstream run**.

Host rows use: **docs only**, **verified in installed source or binary**, **tested here**.

### 11.1 Story rewrite after end-to-end proof (a v1 deliverable)

Badges alone are not enough. Once the fixture end-to-end run and the first real upstream run have
both happened, "Paddling Upstream" is rewritten from a design walkthrough into an account of how the
toolkit actually works and what it achieved:

- **Voice:** written for a 10-year-old, warm and plain; clarity wins over brevity, so the story may
  grow. Every new idea is introduced before it is used.
- **Git, explained carefully:** a short illustrated primer before the journey, one idea at a time,
  each with an everyday picture and the real word: repository, commit (and its fingerprint, the
  SHA), branch, clone, fork, remote, push, pull request, CI checks, merge. No git word appears in the
  story before it has been explained.
- **Real, not planned:** each station shows what happened in the recorded runs (the actual test that
  failed, the actual fix size, the actual checks, the time taken, the maintainer's response), taken
  from `evidence.json` and the dossier, with links.
- **Benefit, measured:** time from issue to pull request, what the human still decided, what the
  guards blocked, and for the agentic-kit chapter what changed downstream when the fix landed.
- **Honest gaps:** anything that has not been proven stays labelled as such.

The rewrite is a task in the implementation plan, scheduled after the first real run, and v1 is not
done until it ships.

## 12. Distribution and onboarding

### 12.1 Principles (cited in `docs/research/evidence-base.md` §I)

- **One repository, native install per host.** The repo carries every host's manifest (the pattern
  superpowers uses) and is its own marketplace. Each host installs it through its own plugin manager;
  we never write a host's config files ourselves.
- **Detect, explain, then ask.** Onboarding is a read-only `riverwright doctor` plus an optional wizard that
  shows the exact command for each step, supports `--dry-run` and `--no-input`, and asks before any
  change outside its own directory (clig.dev guidance on configuration consent; `brew doctor` model).
- **One version source.** All manifests are generated with the same version; CI validates each with
  the host's own validator where one exists (`claude plugin validate --strict`,
  `gemini extensions validate`, `grok plugin validate`).

### 12.2 Install commands (primary channel)

| Host | Install | How `riverwright` is found |
|---|---|---|
| Claude Code | `claude plugin marketplace add pacphi/riverwright` then `claude plugin install riverwright@riverwright` (in session: `/plugin install …`) | `bin/riverwright` and its short alias `bin/rw` (and the `.cmd` files on Windows) are on the Bash tool's PATH while the plugin is enabled |
| Codex | `codex plugin marketplace add pacphi/riverwright` then `codex plugin add riverwright@riverwright` | skill falls back to its own bundle path (below) |
| Gemini CLI | `gemini extensions install https://github.com/pacphi/riverwright --auto-update` | `${extensionPath}/bin/riverwright` in commands; skill fallback |
| Cursor | Once listed: `/add-plugin riverwright` (or Customize → Install; team import via dashboard). Until listed: `cursor-agent --plugin-dir <clone>` (`cursor-agent plugin` only exposes `marketplace`). **Unverified** | skill fallback |
| Grok Build | `grok plugin install pacphi/riverwright` (user adds `--trust` themselves) | `GROK_PLUGIN_ROOT` in hooks; skill fallback |
| Hermes Agent | `hermes plugins install pacphi/riverwright` (user chooses `--enable`). **Unverified**: read from `plugins_cmd_install.py`, not exercised | skill fallback |

**Skill fallback:** every skill that calls `riverwright` tries `riverwright` on PATH first, then the `bin/riverwright` in its
own bundle (resolved from the skill file's location, which each host reports), and otherwise tells the
user to run `/upstream-setup`. The wizard can offer to symlink `~/.local/bin/riverwright` to the installed
bundle, with consent.

**Limits to document:** claude.ai and Cowork do not install plugins that ship `bin/`; the Claude Code
CLI and desktop app do. `${CLAUDE_PLUGIN_ROOT}` is not set inside Bash-tool calls, which is why
`bin/riverwright` exists.

### 12.3 Onboarding flow

1. **`riverwright doctor`** (read-only; non-zero exit when something required is missing). Checks the OS,
   Node version, git,
   `gh` (optional: its presence is information, and a login is reported as an ambient credential route); Docker/OrbStack; each host's presence and version using only the
   side-effect-free probes in `references/hosts/<host>.md` (Appendix A); whether the Riverwright
   adapter is installed per host (Claude `claude plugin list`, Gemini `gemini extensions list`, Grok
   `grok plugin list`, Codex `codex plugin list`, Cursor and Hermes by reading their plugin directories —
   never by running `hermes` or `cursor`); hook trust or consent where hosts require it (Codex trust,
   Hermes allowlist, Grok trust). Prints each gap with the exact command to fix it and its evidence
   level (docs only / verified in binary or source / tested here).
2. **`/upstream-setup`** (a skill in every host; `riverwright setup` in a terminal). Walks the doctor report as a
   checklist, offers the per-host install command for any host that lacks the adapter, sets
   `~/.riverwright/config` (preset, approval mode, reviewer vendor), offers the `~/.local/bin/riverwright`
   symlink, and ends with a dry run against the fixture repo (`riverwright init … --dry-run`). Idempotent;
   `--dry-run`, `--yes`, `--no-input` supported.
3. **Claude SessionStart hook** runs `riverwright doctor --quiet` at most once a day and prints one line only
   when something needs attention. It never changes anything.

**The wizard never:** edits a host's settings or config files, installs packages or hosts, runs
`gh auth login`, stores tokens, passes `--trust` or `--enable` for the user, or opens anything public.

### 12.4 Team onboarding

A repository can prompt its contributors to install the plugin in Claude Code with
`.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "riverwright": { "source": { "source": "github", "repo": "pacphi/riverwright" } }
  },
  "enabledPlugins": { "riverwright@riverwright": true }
}
```

The marketplace registers after the workspace trust dialog. Equivalent notes for Cursor team import
and Grok marketplaces go in `docs/install.md`.

### 12.5 Secondary channels and listings

- `npx skills add pacphi/riverwright` installs the skills only (no `bin/riverwright`, hooks
  or agents); the skills detect the missing runtime and point to the full install.
- Listings, after v1 passes its gate: Claude plugin directory (claude.ai/directory/manage), the Codex
  plugin directory, the Gemini extension gallery (GitHub topic `gemini-cli-extension`), the Cursor
  marketplace (open source, manual review), and a PR to `xai-org/plugin-marketplace` with a pinned
  40-character SHA. Hermes catalog submission is unverified.
- Watch **Agent Plugins v1** (agent-plugins.org), a vendor-neutral plugin manifest Hermes already
  reads; if the other hosts adopt it, it can replace several generated manifests.

### 12.6 Project integration (existing repositories such as agentic-kit)

Installing the plugin writes nothing into any repository: skills, agents and hooks load from the
host's plugin cache, and runs live in `~/.riverwright`. A repository only changes if its owner runs
`riverwright setup --project` (or chooses it in `/upstream-setup`), which is useful when a team wants every
contributor's agent to know that upstream fixes go through Riverwright.

**Default: plan, show, ask.** `riverwright setup --project --dry-run` prints the plan and a unified diff for
every file; without `--dry-run` it asks once per file. `riverwright setup --project --remove` reverses
exactly what was added. A second run with nothing to change is byte-identical.

**What it may touch, and how:**

| Target | Method |
|---|---|
| `AGENTS.md` (read by Codex, Cursor, Grok Build, Hermes) | Managed block, appended |
| `CLAUDE.md` | Managed block only if it does not already import or link `AGENTS.md` |
| `GEMINI.md` | Managed block only if Gemini is not configured to read `AGENTS.md` |
| `.cursor/rules/riverwright.mdc` | New file owned by Riverwright, only if absent |
| `.claude/settings.json` | Add `extraKnownMarketplaces` / `enabledPlugins` entries only if absent (§12.4) |
| `riverwright.json` | New project config owned by Riverwright: the upstreams this repo depends on, preferred preset, and an optional pointer to an existing registry such as agentic-kit's `src/lib/hook-audit/agentic-dependency-constraints.json` |

**Managed block format.** The same sentinel convention agentic-kit, ruflo and agentic-qe already use
in this user's files, so the tools coexist:

```markdown
<!-- BEGIN riverwright -->
<!-- Managed by Riverwright 1.x. Update: riverwright setup --project · Remove: riverwright setup --project --remove -->
## Upstream contributions
Fixes to upstream dependencies go through Riverwright (`/upstream-contribute`).
Never push to an upstream remote directly. Project settings: `riverwright.json`.
<!-- END riverwright -->
```

**Rules** (edge cases match agentic-kit's `src/lib/blocks.mjs`):

- Only text between our own BEGIN/END markers is ever replaced. Everything else in the file is
  preserved byte for byte, including other tools' blocks.
- A BEGIN without an END is treated as damaged: a fresh block is appended and the user is told;
  nothing after the orphaned marker is deleted.
- Line endings, encoding and a missing final newline are preserved.
- One canonical target: if `CLAUDE.md` is a symlink to `AGENTS.md`, or contains an `@AGENTS.md`
  import, only `AGENTS.md` gets the block. Symlinks are never replaced by regular files.
- The block stays under 15 lines, because instruction files cost every session context.
- JSON files are parsed strictly; only absent keys are added and existing values are never changed.
  A file that fails to parse or contains comments is not edited; the snippet is printed for the user
  to paste instead.
- Read-only files, files with uncommitted changes to the target lines, and files inside the upstream
  clone are never edited.
- Before any write, a copy goes to `~/.riverwright/backups/<repo>/<timestamp>/` (outside the
  repository, so `git status` stays clean), and the write is atomic.
- Nothing is committed. The user reviews and commits the change like any other edit.

## 13. Adapter generation (Claude reference in Spec 1)

`tools/generate-adapters.mjs` renders `adapter-src/` into each host's native files. Spec 1 ships the
Claude Code output (plugin manifest, commands, agents, hooks, permission rules) and the generator's
per-host plumbing; Spec 2 fills in the other five. Because Grok Build loads installed Claude Code
plugins (observed with `grok inspect`), the Grok adapter either relies on that path or ships its own
hook, never both; the fixture test asserts exactly one hook fires per command.

## 14. Integration seams

- **Follow and adopt (Specs 4 and 5).** The thread record, the audit and tracking data model, and the rules for who may
  change what are defined in [the thread-record design](thread-record-and-audit.md), in Riverwright's
  own vocabulary. It includes a read-only import from agentic-kit's upstream-watch registry, so its existing threads carry
  over. `riverwright submit` registers the thread it opens; posting anything upstream stays behind the approval gates,
  with `explicit-user-approval-required` as the default for every upstream. Spec 3 (batch) may read the registry as
  batch input.
- **Batch mode.** Scan, triage, twin detection, touch-set lanes, trial merge, pacing, `Depends on #n`.

## 15. Testing and done criteria

- Static: Agent Skills frontmatter lint, per-host manifest validation, generated-adapter drift check,
  markdownlint and prettier.
- `node:test` (built in, no dependencies), run in CI on **ubuntu-latest, macos-latest and
  windows-latest**: `riverwright state` illegal transitions; `riverwright guard` refuses upstream, wrong branch, SHA
  mismatch, pre-gate push; `riverwright sanitize` fixtures; `riverwright fingerprint` fields; policy-scanner samples;
  launchers deny when Node is missing; Windows `.cmd` host spawning with hostile arguments.
- Project-integration tests (§12.6): block insert, update, removal; CRLF files; orphaned BEGIN;
  symlinked `CLAUDE.md → AGENTS.md`; `@AGENTS.md` imports; read-only files; JSON with comments
  refused; a second run changes nothing (byte-identical).
- Hook contract tests: recorded payloads per host → exact deny output and exit code; includes a
  crashing hook script (must deny) for every host.
- Fixture repo `pacphi/riverwright-fixture`: reproducible bug, flaky bug, bug fixed at HEAD,
  AI-banned policy branch, a duplicate pair and a same-function pair (for Spec 3).
- **Spec 1 done when:** the reproducible fixture bug reaches the submit gate in Claude Code, Codex and
  Gemini CLI; each early-exit fixture stops with the right reason; every guard and hook-contract test
  passes; `riverwright submit --dry-run` lists exactly the approved actions. Cursor, Grok Build and Hermes run
  the same fixture before they lose the unverified label.
- **First real run** (after the above): one upstream issue chosen with the user (candidate:
  `ruvnet/ruflo#3509`), every public action approved individually; its ledger feeds the story.

## Appendix A — host invocation hazards (observed 2026-09-29)

| When | Command | Side effect | Rule it created |
|---|---|---|---|
| 2026-09-29 | `cursor agent --help` (Cursor IDE CLI) | Downloaded and installed `cursor-agent` 2026.09.28-64d2043 (≈620 MB) into `~/.local/share/cursor-agent` with `~/.local/bin` symlinks | Never invoke `cursor agent`; probe `cursor-agent --version` only |
| 2026-09-29 | `codex mcp-server --help` (a subcommand Codex 0.158 does not have) | None, only because `--help` was present: Codex forwards an unknown word as a prompt and would start a session | Probe only subcommands confirmed in `codex --help`; never a guessed name |
| 2026-09-29 | `hermes hooks test …` with `HERMES_HOME` set to a temporary directory | Bootstrap rebuilt TUI/web/desktop in the shared install and rewrote `~/.hermes/hermes-agent/.hermes/bin/{hermes,hermes-acp}` to use the temporary directory's Python | Never set `HERMES_HOME`; Hermes hook checks use `hermes hooks list/doctor` against the user's real home, with consent |

## Revision note

- 2026-10-29: Plan 2a built (branch `plan-2a-security`, not yet merged or checked in CI). §3.3 gains
  `ledger verify` and `credential push-key`; §3.4 moves the ledger to `<owner>/<repo>/ledger/events.ndjson` (it was
  `runs/issue-<n>/ledger.jsonl`) and places the vault; §6 records what `approve` and the submit proof now do; §7.1
  says the guard trusts the newest verified receipt, the signed fork and the lease, and which commands honor
  `RIVERWRIGHT_HOME`; §7.2 adds the credential rule; §7.5 describes the vault, the gate, receipts, `ledger verify`,
  the ambient audit and the hardware push key as built, and corrects one claim: a receipt can outlive a crashed
  process for up to 10 minutes (the crash window).
- 2026-09-29: Name. The product upstream-pr-filer is renamed **Riverwright**. The command `upf` is
  `riverwright`, with the short alias `rw`; `UPF_HOME` and every other `UPF_*` variable are
  `RIVERWRIGHT_*`; the workspace is `~/.riverwright` (was `~/.upstream-pr`); the project config is
  `riverwright.json` (was `.upstream-pr.json`); schema ids, run branches, the git config key, the
  managed-block slug and the plugin/marketplace ids use `riverwright`. Behavior is unchanged, and the
  entries below use the new names.
- 2026-09-29: user review. `riverwright` moves from bash to dependency-free Node `.mjs` for Windows, macOS
  and Linux (§3.2, §15); new invariant 10 and §12.6 on respecting existing repositories (managed
  blocks, additive JSON merges, consent, backups outside the repo); §11.1 story rewrite after
  end-to-end proof.
- 2026-09-29: §12 distribution and onboarding added from the distribution research (`docs/research/evidence-base.md` §I).
- 2026-09-29: first draft. §7.2 table from binary/source
  inspection (Claude, Codex, Gemini rows from docs research; Cursor from its built-in `create-hook`
  skill; Grok from strings embedded in the 1.0.44 binary; Hermes from `agent/shell_hooks.py`).
