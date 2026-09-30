# Plugin and marketplace layout: research record

Gathered 2026-09-30 by two read-only research agents and first-hand inspection of the plugins installed on the
build machine. It supports a decision about where the Riverwright plugin lives in the repository (a future ADR).
Evidence levels: **opened** (page or file read in full), **summarized** (a fetch tool summarized the page; only
quoted lines are used), **observed** (a command was run or a file was read on this machine), **reported** (an
agent's account of a public repository, not re-checked), **analogy** (another ecosystem).

## 1. The question

Riverwright is both a CLI (`bin/`, `scripts/`, `templates/`) and an agent plugin. The core spec §3.1 makes the
repository root the plugin root and the marketplace. The owner asked whether a `plugin/` subdirectory is closer to
standard practice, because users will balk at anything that overwrites or interferes with their own established
configuration. An earlier plan proposed moving the contributor `CLAUDE.md` to `.claude/CLAUDE.md` so that
`claude plugin validate --strict` passes.

## 2. What an install does to a user's machine

| Finding | Source | Level |
|---|---|---|
| Claude Code does not load a `CLAUDE.md` at a plugin root | Anthropic, plugins components reference, code.claude.com/docs/en/plugins/components | opened |
| Install writes `enabledPlugins` to the settings file of the chosen scope (`user`: `~/.claude/settings.json`; `project`: `.claude/settings.json`; `local`: `.claude/settings.local.json`); adding a marketplace writes `extraKnownMarketplaces`; state lives under `~/.claude/plugins/` | Anthropic, plugins install and loading pages, code.claude.com/docs/en/plugins/install and /loading | opened |
| A plugin's own `settings.json` affects only `agent` and `subagentStatusLine`, and "User settings over plugin defaults" | Anthropic, plugins components reference | opened |
| Repository-declared marketplaces register only after the workspace trust dialog | Anthropic, host-marketplace page, code.claude.com/docs/en/plugins/host-marketplace | opened |
| Installed plugins sit in `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, one folder per version | this machine: 16 marketplaces, several plugins with multiple cached versions | observed |
| Nothing found that writes to a user's `~/.claude/CLAUDE.md` | same | observed |

So a plugin install adds entries to a settings file and populates its own cache. It does not rewrite the user's own
instruction files. The proposed `.claude/CLAUDE.md` is inside the repository, not in `~/.claude`.

## 3. What is copied, and what the validator says

| Finding | Source | Level |
|---|---|---|
| A git marketplace is cloned whole to `~/.claude/plugins/marketplaces/<name>/`; the installed plugin is copied to the cache | Anthropic, loading and troubleshooting pages | opened |
| "Files outside the plugin directory aren't copied"; component paths that escape the plugin root are rejected | Anthropic, loading page | opened |
| The cache of `openai-codex` holds only the contents of its `plugins/codex/`, not the repository | this machine | observed |
| A relative `source` "must start with `./`", `"."` means the marketplace root itself, and `..` fails validation; the docs recommend a relative path for a plugin in a subdirectory of the marketplace repository | Anthropic, marketplace reference, code.claude.com/docs/en/plugins/marketplace-reference | opened |
| `claude plugin validate --strict .` with a root `CLAUDE.md` passes for a root-plugin layout; validating `.claude-plugin/plugin.json` directly fails with "CLAUDE.md at the plugin root is not loaded as project context" | scratch copy `mk-a`, Claude Code 2.1.285 | observed |
| A `version` mismatch between the marketplace entry and `plugin.json` fails `--strict`; matching versions pass | `mk-a` | observed |
| Marketplace at the repository root with the plugin in `plugin/` and a root `CLAUDE.md`: `validate --strict .` and `validate --strict ./plugin` both pass | scratch copy `mk-b` | observed |
| `validate` reads only files inside the marketplace directory, so it says nothing about symlinks that point outside | Anthropic, create-marketplace page | opened |
| A symlink inside a plugin to elsewhere in the same marketplace is dereferenced (the target is copied); a link outside the marketplace is skipped | Anthropic, host-marketplace page | opened (documentation only; not tested on a real install) |
| A top-level `bin/` in a plugin is rejected by claude.ai, Cowork and organization sync | Anthropic, components and host-marketplace pages | opened |
| `${CLAUDE_PLUGIN_ROOT}` is the version-specific cache directory; it is substituted in skills, agents, commands and hooks | Anthropic, loading page | opened |

The strict-validation failure that motivated the `CLAUDE.md` move applies only when the plugin manifest is validated
on its own in a root-plugin layout. In a `plugin/` layout it cannot arise.

## 4. Practice: how public repositories are laid out

### 4.1 On this machine (observed): 16 unique marketplaces

| Layout | Marketplaces | Root `CLAUDE.md` in the repo |
|---|---|---|
| Plugin at the repository root (`source: "./"`) | beads, cc-blueprint-toolkit, n8n-mcp-skills, spring-m11n, ui-ux-pro-max | 4 of 5 |
| Plugin in a subfolder | openai-codex (`./plugins/codex`), claude-autopilot, rust-optimizer, gh-issue-marketplace, ruvnet-brain (`./plugin`), claude-plugins-official (`./plugins/*`) | claude-autopilot and rust-optimizer keep it at the repo root, outside the plugin |
| Many plugins or a curated list | awesome-claude-skills, life-sciences, superpowers-marketplace, severity1, equity-research | n/a |

Eight cached plugins, including superpowers 6.4.1, contain a root `CLAUDE.md`. It ships inert.

### 4.2 Public repositories (reported): 21 read on 2026-09-30

| Pattern | Count | Examples |
|---|---|---|
| Single plugin at the repository root | 4 | obra/superpowers, ChromeDevTools/chrome-devtools-mcp, anthropics/skills, gemini-cli-extensions/security |
| Code repository: marketplace at the root, plugin in a subfolder | 6 | spotify/save-to-spotify (`plugin/`), gastownhall/beads, stripe/ai, ServiceNow/sdk, BrainBlend-AI/atomic-agents, getsentry/cli |
| `plugins/<name>` monorepo | 8 | anthropics/claude-code, anthropics/claude-plugins-official, wshobson/agents, ruvnet/ruflo, openai/plugins, cursor/plugins |
| Separate marketplace repository | 2 | obra/superpowers-marketplace, xai-org/plugin-marketplace |

In the official Anthropic marketplace (314 entries): 52 relative paths, 164 `url`, 98 `git-subdir`. The `git-subdir`
entries include code repositories that ship a plugin folder, such as `spotify/save-to-spotify` with `path: plugin`
and `getsentry/cli`.

**How subfolder plugins reach their CLI.** None bundles a copy inside the plugin. spotify, beads and sentry install
the CLI separately and find it on PATH; chrome-devtools-mcp uses a pinned `npx` package. Riverwright differs: its
hooks must fail closed when Node is missing, so its launcher has to travel with the plugin.

**Stated reasons.** Root plugin: one install path that works on every host (superpowers serves seven or more hosts
from its root). Subfolder: separation, in beads' words a way to "audit which components actually belong in the
plugin" (beads PR 988, unmerged; the plugin later landed in `plugins/beads`). Monorepo: a catalog. Separate
marketplace: curation.

### 4.3 Costs of shipping a whole repository (reported)

- obra/superpowers issue 1774: the plugin shipped an `evals` submodule whose long paths broke installs on Windows;
  fixed by no longer shipping it. github.com/obra/superpowers/issues/1774
- obra/superpowers issue 2181: Hermes's install scanner returned a "dangerous" verdict with 213 findings, scanning
  test folders and flagging documentation that mentions `CLAUDE.md` or `AGENTS.md` as "persistence". Thirty-two of
  the findings were inside `skills/` itself, so trimming the repository would not clear it. github.com/obra/superpowers/issues/2181
- Beads issue 985 and the follow-up: a first subfolder attempt found only the skills, and a shared `agents/` folder
  holding another host's file broke Claude's manifest validation (issue 3741). Subfolder moves have their own
  failure modes.
- Where complaints about plugins touching user configuration exist (beads issue 462: a setup command changed global
  hooks; sentry's `sentry cli setup` writes skills into `~/.claude`), the cause was an explicit setup step, not the
  repository layout.

## 5. The other hosts (summarized; help text observed)

| Host | Where the manifest must sit | Subfolder support |
|---|---|---|
| Codex 0.158 | reads `.agents/plugins/marketplace.json`, and a legacy `.claude-plugin/marketplace.json`; entries are `./`-prefixed from the marketplace root | `git-subdir`; `marketplace add --sparse <PATH>` |
| Gemini CLI 0.61 | `gemini-extension.json` "in the absolute root of the repository or the release archive" | none; `extensions install` has only `--ref` |
| Cursor | root `plugin.json` or `.cursor-plugin/plugin.json`; multi-plugin repositories use `.cursor-plugin/marketplace.json` with `metadata.pluginRoot` | via `metadata.pluginRoot` |
| Grok Build 1.0.44 | reads Claude marketplaces and plugins | `grok plugin install` accepts `@ref` and `#subdir` |
| Hermes 0.21.5 | `plugin.yaml` | a subdirectory install "downloads only that folder's files" (not reproduced) |

**Gemini is the real leak risk.** A `GEMINI.md` in an extension directory is loaded as extension context unless
`contextFileName` is set, and the manifest must sit at the repository root. Riverwright's root `GEMINI.md`
(`@AGENTS.md`) is contributor guidance and would reach every Gemini user of a root-level extension. Three third-party
Gemini extensions (stripe/ai, chrome-devtools-mcp, superpowers) keep a root `gemini-extension.json` even when their
other hosts use subfolders.

## 6. Layout options for a repository that ships a CLI and a plugin

| Option | What users receive | Contributor churn | Validator | Main risks |
|---|---|---|---|---|
| **A. Root plugin** (today's spec) | the whole repository per user: docs, plans, tests | none | marketplace passes; the plugin manifest needs the `CLAUDE.md` move | cache bloat; Windows long paths (superpowers 1774); scanner false positives (superpowers 2181); a root `GEMINI.md` leaks to Gemini users |
| **B. `plugin/` holding the only copy of the runtime** | only `plugin/` | high: `scripts/`, `bin/`, `templates/`, skills and roles move, and every path in the tests, CI and the three plans changes | passes | large one-time rewrite; tests import `../plugin/scripts/lib/...` |
| **C. `plugin/` generated from root sources** | only `plugin/` | small: a generator step and a drift check (2c already plans both); tests and plans unchanged | passes | committed duplicate files; contributors may edit the copy (the drift check catches it) |
| **D. `plugin/` with symlinks to root sources** | only `plugin/`, after dereferencing | low | passes (proves nothing about install) | Windows checkouts without symlink support break; behavior on a real install untested |

## 7. Not verified

- A real install and symlink dereferencing (nothing was installed).
- Whether `CLAUDE_PLUGIN_ROOT` reaches the Bash tool for `bin/` scripts (the docs name hook, MCP and LSP processes).
- Codex, Cursor, Grok and Hermes copy rules, and whether Hermes can install from a subfolder.
- Whether the hosts load an `AGENTS.md` or `CLAUDE.md` that sits in an installed plugin's root.
- The public-repository counts in 4.2 and the issue accounts in 4.3 are an agent's reports, not re-checked here.
- The literature: one 2026 study of 1,926 Claude marketplace repositories (arXiv 2608.28497, snippet only) does not
  address layout. No scholarly source on separating a distributable from its development repository was found; the
  Homebrew tap and VS Code `.vscodeignore` practices are analogies only.
