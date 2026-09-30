# upstream-pr-filer — Spec 1: the single-issue core

| Field | Value |
|---|---|
| Status | Draft for review |
| Date | 2026-09-29 |
| Scope | Spec 1 of 3: the single-issue pipeline, state, guardrails, roles, write-up, evidence export, and the Claude Code reference adapter |
| Follows | Spec 2 (the other five host adapters), Spec 3 (batch mode) |
| Research | [`docs/research.md`](../../research.md) |
| Story | "Paddling Upstream" artifact, https://claude.ai/artifact/RtwXsztmgYHXu2smHgvcqU |

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
| Defaults | "Balanced" preset (§5.2), overridable per run and in `~/.upstream-pr/config` |
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
8. **Host invocation is side-effect-audited.** `upf` never sets a host's home directory variable,
   never runs a host subcommand not listed as side-effect-free in `references/hosts/<host>.md`, and
   probes unverified hosts with `--version` only (see Appendix A for why).
9. **Accelerators are optional.** ruflo, agentic-qe, beads and similar tools may speed a phase up;
   their absence never blocks one. The floor is Node.js 24+, git, gh and one supported host.
10. **The user's repositories are not ours.** The downstream repo is read-only input. `upf` never
    overwrites or rewrites a file it did not create. Optional project integration (§12.6) touches
    only a clearly marked block or adds absent keys, shows the diff first, asks, and can remove
    exactly what it added.

## 3. Architecture

### 3.1 Repository layout

```
upstream-pr-filer/                    # the repo is its own marketplace (see §12)
  skills/                             # host-neutral Agent Skills (agentskills.io); shared by all hosts
    upstream-contribute/SKILL.md      #   orchestrator: phase table, gates, invariants (kept short)
    upstream-contribute/references/   #   one file per phase, loaded only for that phase
    upstream-status/SKILL.md          #   read-only: where every run stands, what happens next
    upstream-setup/SKILL.md           #   onboarding wizard (§12)
  roles/                              # scout, reproducer, investigator, fixer, reviewer (host-neutral)
  bin/upf  bin/upf.cmd                # tiny launchers (POSIX sh / Windows cmd) → node scripts/upf.mjs
  scripts/upf.mjs                     # single entry point (subcommands in §3.3); Node built-ins only
  scripts/lib/*.mjs
  templates/                          # dossier.md, pr-body.md, issue-body.md, commit-msg.txt,
                                      #   state.schema.json, evidence.schema.json, pre-push.sh
  references/hosts/<host>.md          # per-host action→tool map, safe subcommands, hook dialect
  adapter-src/                        # single source for commands, agents, hooks, permission rules
  tools/generate-adapters.mjs         # dev-time generator; CI fails when output is stale
  .claude-plugin/ adapters/claude/    # generated (Spec 1 ships the Claude adapter)
  .codex-plugin/ gemini-extension.json commands/ agents/ .cursor-plugin/ .hermes-plugin/ …  # Spec 2
  docs/  tests/
  CLAUDE.md  AGENTS.md  GEMINI.md     # contributor instructions: the invariants above
```

Gemini CLI requires fixed `commands/`, `agents/` and `hooks/` directories at the extension root, so
those root directories belong to the Gemini adapter. The Claude adapter lives under
`adapters/claude/` and is referenced by custom paths in `.claude-plugin/plugin.json`.

### 3.2 Runtime

Required: **Node.js 24 or newer** (Node 24 is the LTS baseline; CI also runs Node 26, which becomes LTS on 2026-10-28), `git`, `gh` (authenticated), one
supported host. Optional: Docker Desktop, OrbStack or another Docker engine for the container tier
(WSL2 on Windows).

**Why Node, not bash.** One codebase runs on Windows, macOS and Linux; JSON, paths and processes are
built in; and a guard written in bash fails *open* on Windows machines without bash. The
superpowers Windows hook launcher (`hooks/run-hook.cmd`) exits 0 when it cannot find bash, which is
the right call for a context hook but the wrong one for a safety guard. Node is already how
agentic-kit, autopilot's tooling, Codex, Gemini CLI and the generator run.

**Rules for `scripts/`:**

- **No npm dependencies.** Only Node built-ins (`node:fs`, `node:path`, `node:child_process`,
  `node:crypto`, `node:test`, `node:readline`, `node:util` `parseArgs`). Installing the plugin is a
  file copy; there is never an `npm install` step.
- **Launchers.** `bin/upf` (POSIX sh) and `bin/upf.cmd` (Windows) find `node` and run
  `scripts/upf.mjs`. If Node is missing they print how to install it and exit 1, or exit 2 when
  called as a hook, so a missing runtime denies instead of allowing.
- **Hooks** are generated as `node "<plugin root>/scripts/upf.mjs" hook <host>`, a command line that
  works unchanged in cmd.exe, PowerShell and sh. The entry point converts any exception to exit 2.
- **Git's pre-push hook** is a three-line POSIX sh file (Git for Windows ships sh) that `exec`s
  `node … upf.mjs guard pre-push`.
- **Child processes.** `git` and `gh` run through `execFile` with argument arrays, never a shell
  string. Host CLIs installed through npm are `.cmd` files on Windows, which Node refuses to spawn
  without a shell (Node docs, "Spawning .bat and .cmd files on Windows"). `upf` runs the host's
  JavaScript entry with `node` directly when it can find it, and otherwise uses `cmd.exe /d /s /c`
  with strict quoting of every argument.
- **Paths and files.** `node:path` everywhere; `UPF_HOME` defaults to `os.homedir()/.upstream-pr`;
  existing line endings (LF or CRLF) are preserved on every write; writes are atomic (temp file +
  rename) and keep the file mode.
- **Terminal confirmation** (`tty` approval mode) reads from `/dev/tty` on macOS and Linux and from
  `CONIN$` on Windows.
- **Later option, not v1:** a single-file executable per platform (Node single executable
  applications) to drop the Node requirement.

### 3.3 `upf` subcommands

| Subcommand | Purpose |
|---|---|
| `upf doctor` | Detect hosts, versions, auth, Docker, hook trust/consent state; print what is missing and how to fix it; change nothing |
| `upf init <issue-url \| --symptom …> [--downstream PATH]` | Create the workspace and run record |
| `upf state get\|advance\|stop` | The only writer of `state.json`; rejects illegal transitions |
| `upf sanitize` | Strip and report invisible, bidi and tag characters (§7.4); quote text as data |
| `upf fingerprint` | Record OS, arch, runtime/toolchain versions, lockfile hashes |
| `upf dispatch <role> <run>` | Run a role via the dispatch ladder (§8) |
| `upf approve <gate> <run>` | Record a human approval bound to a SHA or content hash |
| `upf guard pre-push` | The git pre-push check (§7.1) |
| `upf hook <host>` | Host hook entry: reads the host's payload, answers in that host's deny dialect (§7.2) |
| `upf setup [--project] [--remove] [--dry-run] [--yes\|--no-input]` | Onboarding wizard (§12.3) and optional project integration (§12.6) |
| `upf submit <run> [--dry-run]` | Perform the approved public actions |
| `upf post <run> <kind>` | Post an approved issue or comment |
| `upf evidence export [--run R]` | Emit `evidence.json` for the story (§11) |

### 3.4 Workspace and state

Everything lives outside any repository, under `${UPF_HOME:-~/.upstream-pr}/<owner>/<repo>/`:

```
profile.json                 # recon output, shared across issues; refreshed when upstream HEAD moves
clone/                       # plain clone of upstream (no fork yet)
worktrees/issue-<n>/         # one worktree per run, branch upf/<n>-<slug>
runs/issue-<n>/
  state.json                 # phase, status, gates, approvals (schema-validated)
  ledger.jsonl               # append-only: every phase start/end, host, model, outcome, evidence paths
  dossier.md                 # the evidence (§10)
  issue.sanitized.md  fingerprint.json  repro/  pr-body.md  commit-msg.txt
knowledge/setup-patterns.jsonl   # failure → fix memory per build tool and ecosystem (all runs)
```

## 4. Inputs

- **Issue mode:** an upstream issue URL, plus optionally the downstream repo path.
- **Symptom mode:** a description (error text, command, versions) plus the downstream repo path. The
  intake phase searches upstream issues by error signature; if none match, it drafts an issue from the
  upstream issue template and files it only after approval (`upf post`).

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
| 8 | Submit | `upf submit` | fork (if missing), enable fork Actions, push, fork CI, draft PR (`Fixes #n`, maintainer edits allowed), then `gh pr ready` after green + confirmation | |

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

`upf approve` writes `{gate, run, sha|content_hash, approved_at, host, mode}` into `state.json`.
Approval modes:

| Mode | How the human confirms | Default for |
|---|---|---|
| `host-ask` | The host's own permission prompt on `upf approve`/`upf submit` (generated rule) | Claude Code, Codex, Gemini CLI, Cursor, Grok Build (interactive) |
| `tty` | `upf approve` reads a typed confirmation from the terminal (`/dev/tty`, or `CONIN$` on Windows) | Hermes Agent (all modes); any host run headless; opt-in everywhere |

Hermes `-z/--oneshot` auto-bypasses approvals, so Hermes never offers `host-ask`; its submit gate
uses `tty` or hands back to an interactive session.

## 7. Guardrails

### 7.1 Lock 1: git (primary, every host)

- The clone's upstream remote push URL is `DISABLED_BY_UPF`; local `credential.helper` is empty.
- `.git/hooks/pre-push` runs `upf guard pre-push`: allow only when the destination URL equals the
  recorded fork URL, the ref is `refs/heads/upf/*`, and the SHA equals the run's `approved_sha`.
- The fork remote does not exist until the submit gate; `upf submit` alone supplies credentials for
  its own push (`-c credential.helper=…` scoped to that command).

### 7.2 Lock 2: host hooks (second layer)

Generated per host, active only for commands run under `$UPF_HOME`. They deny outward `gh` calls
(`pr create|ready|comment|edit`, `issue create|comment`, `repo fork`, `api` with a write method),
`git push --no-verify`, `-c core.hooksPath`, and edits to remote or credential config, unless the
command is `upf submit` or `upf post`.

The hook entry (`upf.mjs hook <host>`) converts every exception to exit code 2 and prints a deny
decision, and its launcher exits 2 when Node is missing, so a hook failure denies. Remaining per-host behavior, verified on this machine (evidence in `docs/research.md` §H):

| Host | Deny dialect | On hook crash/timeout | Adapter setting |
|---|---|---|---|
| Claude Code | exit 2, or `hookSpecificOutput.permissionDecision: "deny"` | per docs | standard |
| Codex | same shape as Claude | per docs; hooks require persisted trust | `upf doctor` checks trust |
| Gemini CLI | exit 2 or `{"decision":"deny"}`; Policy Engine rule | per docs | hook + policy rule |
| Cursor | exit 2 or `{"permission":"deny"}` | fail-open unless `failClosed: true` | `failClosed: true` |
| Grok Build 1.0.44 | exit 2, top-level `decision`, or `hookSpecificOutput.permissionDecision` (Claude verdicts honored) | non-2 exit fails open | exit-2 trap; Grok also loads Claude plugin hooks, so the generator must not double-register (§13) |
| Hermes Agent 0.21.5 | exit 2, `{"action":"block"}` or `{"decision":"block"}` | fail-open unless `fail_closed: true`; hooks do not fire until consented | `fail_closed: true`; `upf doctor` checks consent; headless needs `--accept-hooks` |

### 7.3 Lock 3: a human click

Host-native **ask** rules on `upf approve` and `upf submit` (Claude permission rules, Gemini Policy
Engine `ask`, Codex approval policy, Cursor and Grok permission rules), or `tty` mode (§6).

**Residual risk, stated in user docs:** an agent with shell access that deliberately circumvents all
three layers can still push. The design makes accidental and injection-driven pushes fail and puts a
human action in front of every public step.

### 7.4 Untrusted input

- `upf sanitize` strips zero-width (U+200B–U+200D, U+2060, U+FEFF, U+180E), bidi controls (U+202A–U+202E,
  U+2066–U+2069), bidi marks (U+200E, U+200F, U+061C), soft hyphens (U+00AD), invisible operators
  (U+2061–U+2064), variation selectors (U+FE00–U+FE0F, U+E0100–U+E01EF) and tag characters
  (U+E0000–U+E007F), records what it found, and quotes the text into the dossier with provenance.
  Stripping U+FE0F can turn a colour emoji into its text form; the finding is reported.
- Upstream instruction files: subagents start without them where the host allows (Claude
  `omitClaudeMd`; Hermes `--ignore-rules`; headless runs from a neutral directory that reads the
  worktree by path). Anything suspicious in them is listed at Checkpoint 1.
- Container tier: non-root, worktree-only mount, no credentials in the container.

## 8. Roles and dispatch

| Role | Access | Tier | Hands off |
|---|---|---|---|
| scout | read + `gh` reads | small | `profile.json` |
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

`upf evidence export` reads ledgers and writes `evidence.json` (schema in
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

### 12.1 Principles (cited in `docs/research.md` §I)

- **One repository, native install per host.** The repo carries every host's manifest (the pattern
  superpowers uses) and is its own marketplace. Each host installs it through its own plugin manager;
  we never write a host's config files ourselves.
- **Detect, explain, then ask.** Onboarding is a read-only `upf doctor` plus an optional wizard that
  shows the exact command for each step, supports `--dry-run` and `--no-input`, and asks before any
  change outside its own directory (clig.dev guidance on configuration consent; `brew doctor` model).
- **One version source.** All manifests are generated with the same version; CI validates each with
  the host's own validator where one exists (`claude plugin validate --strict`,
  `gemini extensions validate`, `grok plugin validate`).

### 12.2 Install commands (primary channel)

| Host | Install | How `upf` is found |
|---|---|---|
| Claude Code | `claude plugin marketplace add agentic-incubator/upstream-pr-filer` then `claude plugin install upstream-pr-filer@upstream-pr-filer` (in session: `/plugin install …`) | `bin/upf` (and `bin/upf.cmd` on Windows) is on the Bash tool's PATH while the plugin is enabled |
| Codex | `codex plugin marketplace add agentic-incubator/upstream-pr-filer` then `codex plugin add upstream-pr-filer@upstream-pr-filer` | skill falls back to its own bundle path (below) |
| Gemini CLI | `gemini extensions install https://github.com/agentic-incubator/upstream-pr-filer --auto-update` | `${extensionPath}/bin/upf` in commands; skill fallback |
| Cursor | Once listed: `/add-plugin upstream-pr-filer` (or Customize → Install; team import via dashboard). Until listed: `cursor-agent --plugin-dir <clone>` (`cursor-agent plugin` only exposes `marketplace`). **Unverified** | skill fallback |
| Grok Build | `grok plugin install agentic-incubator/upstream-pr-filer` (user adds `--trust` themselves) | `GROK_PLUGIN_ROOT` in hooks; skill fallback |
| Hermes Agent | `hermes plugins install agentic-incubator/upstream-pr-filer` (user chooses `--enable`). **Unverified**: read from `plugins_cmd_install.py`, not exercised | skill fallback |

**Skill fallback:** every skill that calls `upf` tries `upf` on PATH first, then the `bin/upf` in its
own bundle (resolved from the skill file's location, which each host reports), and otherwise tells the
user to run `/upstream-setup`. The wizard can offer to symlink `~/.local/bin/upf` to the installed
bundle, with consent.

**Limits to document:** claude.ai and Cowork do not install plugins that ship `bin/`; the Claude Code
CLI and desktop app do. `${CLAUDE_PLUGIN_ROOT}` is not set inside Bash-tool calls, which is why
`bin/upf` exists.

### 12.3 Onboarding flow

1. **`upf doctor`** (read-only; non-zero exit when something required is missing). Checks the OS,
   Node version, git,
   `gh` and `gh auth status` scopes; Docker/OrbStack; each host's presence and version using only the
   side-effect-free probes in `references/hosts/<host>.md` (Appendix A); whether the upstream-pr-filer
   adapter is installed per host (Claude `claude plugin list`, Gemini `gemini extensions list`, Grok
   `grok plugin list`, Codex `codex plugin list`, Cursor and Hermes by reading their plugin directories —
   never by running `hermes` or `cursor`); hook trust or consent where hosts require it (Codex trust,
   Hermes allowlist, Grok trust). Prints each gap with the exact command to fix it and its evidence
   level (docs only / verified in binary or source / tested here).
2. **`/upstream-setup`** (a skill in every host; `upf setup` in a terminal). Walks the doctor report as a
   checklist, offers the per-host install command for any host that lacks the adapter, sets
   `~/.upstream-pr/config` (preset, approval mode, reviewer vendor), offers the `~/.local/bin/upf`
   symlink, and ends with a dry run against the fixture repo (`upf init … --dry-run`). Idempotent;
   `--dry-run`, `--yes`, `--no-input` supported.
3. **Claude SessionStart hook** runs `upf doctor --quiet` at most once a day and prints one line only
   when something needs attention. It never changes anything.

**The wizard never:** edits a host's settings or config files, installs packages or hosts, runs
`gh auth login`, stores tokens, passes `--trust` or `--enable` for the user, or opens anything public.

### 12.4 Team onboarding

A repository can prompt its contributors to install the plugin in Claude Code with
`.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "upstream-pr-filer": { "source": { "source": "github", "repo": "agentic-incubator/upstream-pr-filer" } }
  },
  "enabledPlugins": { "upstream-pr-filer@upstream-pr-filer": true }
}
```

The marketplace registers after the workspace trust dialog. Equivalent notes for Cursor team import
and Grok marketplaces go in `docs/install.md`.

### 12.5 Secondary channels and listings

- `npx skills add agentic-incubator/upstream-pr-filer` installs the skills only (no `bin/upf`, hooks
  or agents); the skills detect the missing runtime and point to the full install.
- Listings, after v1 passes its gate: Claude plugin directory (claude.ai/directory/manage), the Codex
  plugin directory, the Gemini extension gallery (GitHub topic `gemini-cli-extension`), the Cursor
  marketplace (open source, manual review), and a PR to `xai-org/plugin-marketplace` with a pinned
  40-character SHA. Hermes catalog submission is unverified.
- Watch **Agent Plugins v1** (agent-plugins.org), a vendor-neutral plugin manifest Hermes already
  reads; if the other hosts adopt it, it can replace several generated manifests.

### 12.6 Project integration (existing repositories such as agentic-kit)

Installing the plugin writes nothing into any repository: skills, agents and hooks load from the
host's plugin cache, and runs live in `~/.upstream-pr`. A repository only changes if its owner runs
`upf setup --project` (or chooses it in `/upstream-setup`), which is useful when a team wants every
contributor's agent to know that upstream fixes go through upstream-pr-filer.

**Default: plan, show, ask.** `upf setup --project --dry-run` prints the plan and a unified diff for
every file; without `--dry-run` it asks once per file. `upf setup --project --remove` reverses
exactly what was added. A second run with nothing to change is byte-identical.

**What it may touch, and how:**

| Target | Method |
|---|---|
| `AGENTS.md` (read by Codex, Cursor, Grok Build, Hermes) | Managed block, appended |
| `CLAUDE.md` | Managed block only if it does not already import or link `AGENTS.md` |
| `GEMINI.md` | Managed block only if Gemini is not configured to read `AGENTS.md` |
| `.cursor/rules/upstream-pr-filer.mdc` | New file owned by upstream-pr-filer, only if absent |
| `.claude/settings.json` | Add `extraKnownMarketplaces` / `enabledPlugins` entries only if absent (§12.4) |
| `.upstream-pr.json` | New project config owned by upstream-pr-filer: the upstreams this repo depends on, preferred preset, and an optional pointer to an existing registry such as agentic-kit's `src/lib/hook-audit/agentic-dependency-constraints.json` |

**Managed block format.** The same sentinel convention agentic-kit, ruflo and agentic-qe already use
in this user's files, so the tools coexist:

```markdown
<!-- BEGIN upstream-pr-filer -->
<!-- Managed by upstream-pr-filer 1.x. Update: upf setup --project · Remove: upf setup --project --remove -->
## Upstream contributions
Fixes to upstream dependencies go through upstream-pr-filer (`/upstream-contribute`).
Never push to an upstream remote directly. Project settings: `.upstream-pr.json`.
<!-- END upstream-pr-filer -->
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
- Before any write, a copy goes to `~/.upstream-pr/backups/<repo>/<timestamp>/` (outside the
  repository, so `git status` stays clean), and the write is atomic.
- Nothing is committed. The user reviews and commits the change like any other edit.

## 13. Adapter generation (Claude reference in Spec 1)

`tools/generate-adapters.mjs` renders `adapter-src/` into each host's native files. Spec 1 ships the
Claude Code output (plugin manifest, commands, agents, hooks, permission rules) and the generator's
per-host plumbing; Spec 2 fills in the other five. Because Grok Build loads installed Claude Code
plugins (observed with `grok inspect`), the Grok adapter either relies on that path or ships its own
hook, never both; the fixture test asserts exactly one hook fires per command.

## 14. Integration seams (designed in Spec 3)

- **agentic-kit upstream watch.** `pacphi/agentic-kit` keeps a registry of upstream threads
  (`src/lib/hook-audit/agentic-dependency-constraints.json`, lifecycle `watching → fixed-unreleased →
  released → dispatched → adopted → retired`) with a per-dependency publication rule of
  `explicit-user-approval-required`. Spec 3 may read `watch` entries as batch input and propose a
  `relation: filed` entry after a PR opens; both stay behind the same approval gates.
- **Batch mode.** Scan, triage, twin detection, touch-set lanes, trial merge, pacing, `Depends on #n`.

## 15. Testing and done criteria

- Static: Agent Skills frontmatter lint, per-host manifest validation, generated-adapter drift check,
  markdownlint and prettier.
- `node:test` (built in, no dependencies), run in CI on **ubuntu-latest, macos-latest and
  windows-latest**: `upf state` illegal transitions; `upf guard` refuses upstream, wrong branch, SHA
  mismatch, pre-gate push; `upf sanitize` fixtures; `upf fingerprint` fields; policy-scanner samples;
  launchers deny when Node is missing; Windows `.cmd` host spawning with hostile arguments.
- Project-integration tests (§12.6): block insert, update, removal; CRLF files; orphaned BEGIN;
  symlinked `CLAUDE.md → AGENTS.md`; `@AGENTS.md` imports; read-only files; JSON with comments
  refused; a second run changes nothing (byte-identical).
- Hook contract tests: recorded payloads per host → exact deny output and exit code; includes a
  crashing hook script (must deny) for every host.
- Fixture repo `agentic-incubator/upf-fixture`: reproducible bug, flaky bug, bug fixed at HEAD,
  AI-banned policy branch, a duplicate pair and a same-function pair (for Spec 3).
- **Spec 1 done when:** the reproducible fixture bug reaches the submit gate in Claude Code, Codex and
  Gemini CLI; each early-exit fixture stops with the right reason; every guard and hook-contract test
  passes; `upf submit --dry-run` lists exactly the approved actions. Cursor, Grok Build and Hermes run
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

- 2026-09-29: user review. `upf` moves from bash to dependency-free Node `.mjs` for Windows, macOS
  and Linux (§3.2, §15); new invariant 10 and §12.6 on respecting existing repositories (managed
  blocks, additive JSON merges, consent, backups outside the repo); §11.1 story rewrite after
  end-to-end proof.
- 2026-09-29: §12 distribution and onboarding added from the distribution research (`docs/research.md` §I).
- 2026-09-29: first draft. §7.2 table from binary/source
  inspection (Claude, Codex, Gemini rows from docs research; Cursor from its built-in `create-hook`
  skill; Grok from strings embedded in the 1.0.44 binary; Hermes from `agent/shell_hooks.py`).
