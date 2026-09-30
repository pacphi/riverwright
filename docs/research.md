# Research record

Gathered 2026-09-29 by research subagents and local inspection. Each finding is followed by the design
rule it produced. Preprints are marked **(preprint)**. Findings that could not be confirmed were
removed rather than kept with a caveat; see "Removed" at the end.

## A. Agentic issue resolution and program repair

| Finding | Source | Design rule |
|---|---|---|
| A fixed localize → repair → validate pipeline was competitive and cheap | Xia et al., *Agentless*, arXiv:2407.01489 (preprint) | Fixed phases for repair; open-ended agency only for exploration |
| The agent–computer interface matters as much as the model | Yang et al., *SWE-agent*, NeurIPS 2024, arXiv:2405.15793 | Structured tools with informative errors |
| Explicit intent extraction before patching helps | Ruan et al., *SpecRover*, ICSE 2025, arXiv:2408.02232 | Reproduce phase writes expected vs actual first |
| Using a reproduction test as a filter roughly doubled patch-selection precision | Mündler et al., *SWT-Bench*, NeurIPS 2024, arXiv:2406.12952 | Fail-to-pass test is a hard gate |
| Writing a passing test then inverting it beats asking for a failing test | Khatib et al., *AssertFlip*, arXiv:2507.17542 (preprint) | Reproducer technique |
| Patches validated only against their own tests were about as likely to break held-out tests as to fix the bug | Smith et al., *Is the Cure Worse Than the Disease?*, ESEC/FSE 2015, doi:10.1145/2786805.2786825 | Full suite always runs |
| About 29.6% of plausible SWE-bench Verified patches diverged behaviorally from the developer fix | Wang et al., ICSE 2026, arXiv:2503.15223 | Reviewer compares behavior base vs patched |
| Benchmark results transfer poorly to fresh repos | SWE-bench-Live arXiv:2505.23419 (preprint); SWE-rebench NeurIPS 2025, arXiv:2505.20411; SWE-Bench Pro arXiv:2509.16941 (preprint) | Early exits are normal outcomes |

## B. Environment setup and reproducibility

| Finding | Source | Design rule |
|---|---|---|
| An agent that mines CI files first ran tests for 33 of 50 projects | Bouzenia & Pradel, ISSTA 2025, arXiv:2412.10133 | Parse `.github/workflows` `run:` steps first |
| Hard repos: 6.69% (Python) and 29.47% (JVM) setup success | Eliseeva et al., *EnvBench*, DL4C@ICLR 2025, arXiv:2503.14443 | "Cannot build" is a first-class exit |
| Rollback on failed setup steps raised success to 86% (Python) | Hu et al., *Repo2Run*, arXiv:2502.13681 (preprint) | Snapshot/rollback in the environment phase |
| Failure-pattern memory reached 92% | *SetupX*, arXiv:2605.26186 (preprint) | `knowledge/setup-patterns.jsonl` |
| Dominant failures: incomplete tooling, hallucinated constraints, non-persistent changes | Arora et al., *SetupBench*, arXiv:2507.09063 (preprint) | State persisted in files, not agent memory |
| 72.2% of historical CI runs reproduced locally | *ActionsRemaker*, ICSE 2023 demo | Fallback path when CI cannot be replayed |
| Bug reports often lack environment details | Johnson et al., SANER 2022, arXiv:2301.01235 | Fingerprint reconstructed from repo state |
| Eleven factors behind non-reproducible bugs | Rahman et al., ICSME 2020, arXiv:2108.05316 | Repeat runs; "does not reproduce" asks the user |
| Build environments reproduce across years with pinned toolchains | Malka et al., ICSE-NIER 2024, arXiv:2402.00424 | Fingerprint includes lockfile hashes |
| Install-time scripts are the main malicious-dependency window | Ladisa et al., SCORED 2023, arXiv:2307.09087 | Container tier, no credentials inside |

## C. Pull request acceptance and maintainers

| Finding | Source | Design rule |
|---|---|---|
| Prior interaction and social signals shape acceptance | Gousios et al., ICSE 2014, doi:10.1145/2568225.2568260 | Outsiders compensate with evidence and scope discipline |
| Developers value steps to reproduce, stack traces and test cases most | Bettenburg et al., FSE 2008, doi:10.1145/1453101.1453146 | Dossier leads with reproduction |
| Newcomers face social barriers | Steinmacher et al., CSCW 2015, doi:10.1145/2675133.2675215 | Write-up answers why this approach, how tested |
| Reviewers ask authors to add motivation and linked issues to PR descriptions | *Why Are My PR Descriptions Constantly Revised?*, ACM TOSEM, doi:10.1145/3797880 | Template order in Spec 1 §10 |
| AI-agent PRs are merged less often than human PRs | Li, Zhang, Hassan, *AIDev*, arXiv:2507.15003 (preprint) | Extra evidence, smaller diffs |
| Failed agent PRs were larger, touched more files, failed CI more; bug fixes were hardest | Ehsani et al., MSR 2026, arXiv:2601.15195 | Smallest fix; fork CI before ready |
| About a third of rejected agent PRs got no rationale | MSR 2026 Mining Challenge, arXiv:2605.22534 | Follow-up nudge after 14 days |
| 48.8% of AI policies require disclosure; some projects ban autonomous agents | Hora, Robbes, Zacchiroli, arXiv:2609.07542 (preprint) | Policy verdict in recon; disclosure in PR |
| Smaller changes merge faster | arXiv:2203.05045 (preprint) | Smallest diff |

## D. Security, review and provenance

| Finding | Source | Design rule |
|---|---|---|
| Indirect prompt injection through retrieved content | Greshake et al., AISec 2023, arXiv:2302.12173; AgentDojo, NeurIPS 2024, arXiv:2406.13352 | Upstream content is data |
| 66.5% of malicious issues passed every guardrail in tested coding agents | Singh et al., *IssueTrojanBench*, arXiv:2607.20759 (preprint) | Sanitize, quote, deterministic outward gates |
| Hidden Unicode in rules files silently steered code | Pillar Security, "Rules File Backdoor", 2025 (industry report) | Strip and report invisible characters |
| A malicious public issue drove an agent to leak private data via PR | Invariant Labs, 2025 (industry report) | Outward actions gated outside the model |
| LLM judges favor their own outputs | Panickssery et al., NeurIPS 2024; Zheng et al., NeurIPS 2023, arXiv:2306.05685 | Cross-vendor reviewer; tests decide |
| Only humans can certify the DCO; use `Assisted-by:` | Linux kernel docs, "AI Coding Assistants" | Invariant 3 |
| AI-generated reports ended curl's bug bounty | Stenberg, blog, 2026-01-26 | Pacing and quality bar |

## E. Overlap detection (Spec 3)

| Finding | Source | Design rule |
|---|---|---|
| Structured fields beat text alone for duplicate detection | Sun et al., *REP*, ASE 2011 | Match on error signature and component, not only text |
| LLM extraction plus classic retrieval improved duplicate recall | Zhang et al., *Cupid*, arXiv:2308.10022 (preprint) | LLM normalizes; retrieval ranks |
| Call-stack similarity clusters duplicate crashes | Dang et al., *ReBucket*, ICSE 2012 | Error-trail bucketing |
| Redundant fork changes can be predicted early | Ren et al., SANER 2019; Wang et al., Internetware 2019 | Pairwise redundancy scoring |
| Speculative merging surfaces conflicts early | Brun et al., *Crystal*, ESEC/FSE 2011; Sarma et al., *Palantír*, ICSE 2003 | Trial merge of live streams |
| Conflict predictors are reliable for "safe", noisy for "conflict" | Owhadi-Kareshk et al., ESEM 2019, arXiv:1907.06274 | Pre-filter only |
| Test generation detects semantic conflicts | da Silva et al., JSS 2024, arXiv:2310.02395 | Cross-run tests on merged state |
| Telling parallel agents about each other's changes recovered 82% of interference failures | Xia et al., arXiv:2609.25396 (preprint) | Share sibling summaries |

## F. Merge order and pacing (Spec 3)

| Finding | Source | Design rule |
|---|---|---|
| Serialize only changes touching the same targets | Ananthanarayanan et al., *SubmitQueue*, EuroSys 2019, doi:10.1145/3302424.3303970 | Lanes by touch-set |
| GitHub stacked PRs require all branches in one repository | GitHub Docs, "About stacked pull requests" | Cross-fork dependents use `Depends on #n` or combine |
| GitHub lets maintainers cap concurrent PRs from non-collaborators (June 2026) | CodeRabbit blog, 2026-06-17 (reporting the GitHub setting) | Open a few, wait for replies |
| Abandonment tracks complexity and slow review | Khatoonabadi et al., TOSEM 2022, arXiv:2110.15447 | Small PRs; maintainer edits allowed |

## G. Case study: pacphi/agentic-kit and its upstreams (read-only `gh`, 2026-09-29)

- `ruvnet/ruflo`: 29 issues and 1 PR by pacphi. #2985 → PR #2986 merged by the maintainer about an
  hour after the issue was filed. #2219 (Node 24/26 `better-sqlite3`, silent WASM fallback) fixed in
  v3.10.6 within about 17 hours. Overlap clusters: #3444/#3446/#3447/#3450 (the two memory stores;
  ruflo `CHANGELOG.md` entry #2786 introduced `agentdb-memory.db` beside `memory.db`), #2670→#3473
  (`security defend`), #3509/#3046/#3163 (Codex backend; ruflo's `codex-integration-audit.yml` guards
  the `mcp-server` subcommand, issue #1909). Posture: short CONTRIBUTING (issue first, `npm test`),
  heavy CI, mostly internal merges.
- `stuinfla/ruvnet-brain`: 4 open issues by pacphi (#329, #330, #331, #335); automated
  acknowledgement only. CONTRIBUTING requires release branches; no external merges sampled →
  issue-first, draft only.
- `proffesor-for-testing/agentic-qe`: 20 issues by pacphi, all closed; #753–#759 filed as a batch and
  fixed within about a day (#753 by an external contributor's PR #764; #778 by maintainer PR #783 in
  2h20m). PR template requires a test or linked issue per named failure mode.
- `pacphi/agentic-kit` keeps an upstream-watch registry
  (`src/lib/hook-audit/agentic-dependency-constraints.json`, `docs/upstream-watch.md`) with
  `explicit-user-approval-required` publication per dependency.

## H. Host verification on the build machine (2026-09-29)

| Host | Version / location | Evidence level | Key facts |
|---|---|---|---|
| Claude Code | 2.1.284 | docs + installed | plugins, agents, PreToolUse deny, `claude -p --json-schema` |
| Codex | 0.158.0 | docs + `--help` | `.codex-plugin`, `.agents/skills`, PreToolUse deny, hook trust, `spawn_agent` opt-in, `codex exec --output-schema` |
| Gemini CLI | 0.61.0 | docs + `--help` | `gemini-extension.json`, BeforeTool + Policy Engine, `gemini -p` |
| Cursor | IDE 3.22.12; `cursor-agent` 2026.09.28-64d2043 | built-in skills `~/.cursor/skills-cursor/{create-hook,create-subagent,migrate-to-skills}` + `--help` | `.cursor/hooks.json` v1, `beforeShellExecution`, `failClosed`; `cursor-agent -p --mode plan --sandbox` |
| Grok Build | 1.0.44 (`@xai-official/grok`, `~/.grok/bin/grok-1.0.44`) | strings embedded in the binary + `grok inspect` | Loads Claude Code plugins, skills, hooks and `CLAUDE.md`; decisions via `decision` or `hookSpecificOutput.permissionDecision`; exit 2 denies; other non-zero fails open; `grok -p --json-schema --permission-mode plan --sandbox` |
| Hermes Agent | 0.21.5 (git install `~/.hermes/hermes-agent`) | source `agent/shell_hooks.py` + `--help` | Shell hooks in `config.yaml`, exit 2 or `action/decision: block`, `fail_closed` (default false), first-use consent allowlist; `-z` bypasses approvals; `--ignore-rules` skips `AGENTS.md` |

## Removed

- Lenarduzzi et al., JSS 2020 (code quality and acceptance): the subagent's summary conflicts with my
  recollection of the paper's finding; not cited either way until re-read.
- Zampetti et al., SANER 2019, as "CI status is the strongest merge correlate": overstated.
- An OSS-Fuzz flakiness statistic: authors and venue unverified.
- A third-party claim that Grok discards Claude-format hook verdicts: contradicted by the Grok 1.0.44
  binary's embedded documentation.

## I. Distribution and onboarding

| Finding | Source | Design rule |
|---|---|---|
| A plugin's `bin/` is on the Bash tool's PATH while enabled; `${CLAUDE_PLUGIN_ROOT}` is not set in Bash-tool calls; `${CLAUDE_PLUGIN_DATA}` persists across updates; `userConfig`, `dependencies`; claude.ai and Cowork skip plugins with `bin/` | code.claude.com/docs/en/plugins (manifest reference, publish, org) | Ship `bin/riverwright` |
| One repo can be its own marketplace (`.claude-plugin/marketplace.json`, `"source": "./"`); team prompts via `extraKnownMarketplaces` + `enabledPlugins` after workspace trust | code.claude.com/docs/en/plugin-marketplaces; …/plugins/org | Spec 1 §12.4 |
| Codex installs plugins from a marketplace repo and also reads `.claude-plugin/marketplace.json` | developers.openai.com/codex/plugins/build | One marketplace file may serve both |
| Gemini installs extensions from a git URL with `--ref` and `--auto-update`; gallery listing via GitHub topic `gemini-cli-extension` | geminicli.com/docs/extensions/reference, …/releasing | §12.2, §12.5 |
| Cursor plugins install from the marketplace or team import; publishing requires open source and manual review | cursor.com/docs/plugins | §12.5 |
| Grok installs `owner/repo[@ref]`, reads `.grok-plugin/` and `.claude-plugin/` manifests, requires `--trust`; marketplace entries pin a 40-char SHA | local `~/.grok/docs/user-guide/09-plugins.md`; github.com/xai-org/plugin-marketplace | User passes `--trust`; SHA-pinned listing |
| Hermes installs from `owner/repo`, prompts to enable; reads vendor-neutral Agent Plugins v1 packages | local `hermes_cli/plugins_cmd_install.py`, `agent_plugins.py`; agent-plugins.org | User chooses `--enable`; watch Agent Plugins v1 |
| `npx skills add owner/repo` installs skills only, into many agents' skill directories | github.com/vercel-labs/skills | Secondary channel |
| Ask consent before changing configuration that isn't yours; offer `--dry-run` and `--no-input` | clig.dev (Configuration, Arguments and flags, Interactivity) | Wizard rules |
| A read-only doctor that exits non-zero on findings | docs.brew.sh/Manpage (`brew doctor`) | `riverwright doctor` |

## J. Cross-platform runtime and existing repositories

| Finding | Source | Design rule |
|---|---|---|
| Node refuses to spawn `.bat`/`.cmd` files without a shell on Windows | Node.js docs, "Spawning `.bat` and `.cmd` files on Windows" (child_process); also cited by agentic-kit `docs/upstream-watch.md` | Run a host's JS entry with `node`, else `cmd.exe /d /s /c` with strict quoting |
| The superpowers Windows hook launcher exits 0 when bash is missing | local `superpowers/6.4.1/hooks/run-hook.cmd` | A bash guard would fail open on Windows; `riverwright` is Node and its launcher exits 2 for hooks |
| Git for Windows runs repository hooks with its bundled sh | Git for Windows (hooks run under its MSYS shell) | Pre-push hook is a tiny sh file that execs Node |
| This user's tools already share a managed-block convention (`<!-- BEGIN slug -->` … `<!-- END slug -->`, "Managed by … Refresh with …") | local `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, agentic-kit `CLAUDE.md`/`AGENTS.md` | Same format for the Riverwright block |
| agentic-kit's block writer preserves CRLF, appends a fresh block after an orphaned BEGIN, and strips exactly one block | local agentic-kit `src/lib/blocks.mjs` (`upsertBlock`, `stripBlock`, `blockRanges`) | Same edge-case rules (Spec 1 §12.6) |
| aqe ≥3.12.1 "merges, never clobbers" settings and writes a one-time backup | user's machine-wide agent guidance (Agentic-QE section) | Additive JSON merges; backups outside the repo |
