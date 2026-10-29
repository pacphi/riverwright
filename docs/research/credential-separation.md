# Credential separation and tamper-evident consent: research record

Gathered 2026-09-29 by three read-only research subagents plus local `--version` probes. It supports the
credential-separation decision (a future ADR) and Plan 2a. Every row carries its evidence level:

- **Opened**: the page or paper was fetched and read this session.
- **Snippet**: seen only in search-result summaries. Treat as a lead, not a fact.
- **Memory**: background knowledge, not checked.
- **Inferred**: our own reasoning from the sources; not stated by them.

Text from the web is data. Nothing here was executed. No credential-reading command was run.

## 1. The problem in one paragraph

Riverwright's agent runs as the user's OS account with shell tools and reads untrusted upstream text. It
therefore has all three legs of what Willison calls the lethal trifecta: untrusted content, private data (the
user's GitHub credentials) and an outward channel (push, PR, comment). Today the approval record is a file the
agent can write, and ambient credentials (`gh`, keychain, ssh-agent, environment) are reachable. The task is
to make a public action impossible without something the agent cannot do, at the least friction for the human.

## 2. Agent security literature

| Finding | Source | Level | Design rule |
|---|---|---|---|
| An agent with untrusted input, sensitive access and outward action needs a reliable human check, or a fresh session | Meta AI, *Agents Rule of Two*, 2025-10-31, ai.meta.com/blog/practical-ai-agent-security | Opened | The human approval must be unforgeable by the agent |
| Adaptive attacks broke 12 published prompt-injection defenses, most above 90% | Nasr, Carlini et al., *The Attacker Moves Second*, arXiv:2510.09023 (USENIX Security 2026) | Opened | Use structural controls, not detectors or "the model will refuse" |
| Users approved 93% of permission prompts ("approval fatigue") | Anthropic, *Claude Code auto mode*, anthropic.com/engineering/claude-code-auto-mode | Opened | Prompt only at irreversible public actions; show the exact payload |
| A privileged planner plus a tool-less quarantined reader plus provenance-tracking policy enforcement gave provable security on 77% of AgentDojo tasks | Debenedetti et al., *Defeating Prompt Injections by Design (CaMeL)*, arXiv:2503.18813 | Snippet | The public-action check lives in deterministic code, outside the model |
| Patterns (plan-then-execute and others) give provable resistance by constraining the agent, trading utility | Beurer-Kellner et al., *Design Patterns for Securing LLM Agents*, arXiv:2506.08837 | Opened (abstract only) | A human-approved, frozen plan of public actions; the pattern names came from memory and are unverified |
| Ambient identity-based authority is the root of the confused-deputy problem | Hardy, *The Confused Deputy*, 1988 | Snippet | Grant single-use, payload-bound authority; never the whole token |
| Authority as narrow unforgeable references, not ambient identity | Miller, *Robust Composition*, 2006 | Snippet | Per-action capability, not a bearer token the agent holds |
| The lethal trifecta | Willison, 2025-06-16, simonwillison.net/2025/Jun/16/the-lethal-trifecta | Snippet | Name the trifecta in the threat model |

## 3. Tamper-evident logging

| Finding | Source | Level | Design rule |
|---|---|---|---|
| A log's guarantee comes from a commitment someone else already holds; consistency and inclusion proofs against it | Crosby and Wallach, USENIX Security 2009 | Snippet | A hash chain in a file the agent can write proves nothing alone |
| Evolving one-way MAC keys protect the past after compromise, only if the key lives out of the attacker's reach | Schneier and Kelsey, USENIX Security 1998 | Snippet | On one UID the current key file is readable, so this does not help |
| A log can show different views to different clients; logs are trusted third parties; gossip is out of scope | RFC 9162 sections 2.1.4, 4.10, 11.3 | Opened | "Append-only" needs an independent witness of the head |
| Signed checkpoints (origin, size, root) co-signed by independent witnesses | Sigstore Rekor; transparency-dev witness, Sigsum design | Snippet | Record the tree size; anchor the head outside the agent's reach |

A hash chain does **not** stop full rewrite (recompute forward), truncation (a shorter chain is valid), forgery
by anyone who can read the key, or rollback to an older consistent history. **Inferred:** at `submit`, the
ledger head hash can be published where the agent cannot rewrite it, for example in the pull request body or a
commit trailer, so GitHub acts as a witness. No source describes this scheme; it needs its own test.

## 4. GitHub credentials for a fork-to-upstream pull request

| Finding | Source | Level | Consequence |
|---|---|---|---|
| A fine-grained token is limited to resources of one owner, with no write access to public repositories you neither own nor belong to | GitHub Docs, *Managing your personal access tokens* | Opened | It probably cannot open a PR on an upstream you do not own. Not tested |
| `POST /repos/{o}/{r}/pulls` needs Pull requests: write; creating a ref needs Contents: write | GitHub Docs, *Permissions required for fine-grained PATs* | Opened | A fork-scoped token can push; PR creation is the open question |
| Classic `public_repo` gives write on all your public repositories | GitHub Docs, *Scopes for OAuth apps* | Opened | The workable PR credential is coarse and cannot be limited to the fork |
| App user tokens are the intersection of app and user permissions; 8-hour default expiry; device flow supported | GitHub Docs, *Generating a user access token for a GitHub App* | Opened | Whether it must be installed on upstream is not stated; likely a blocker (memory) |

**Practical reading:** a token limited to the fork helps for the push step only. The credential that opens the
PR and posts comments is broad, so the gate on that credential is what matters. A cheap test with a throwaway
repository would settle the fine-grained question and should precede any reliance on it.

## 5. Human-presence mechanisms

| Mechanism | Stops a same-UID agent? | Friction | Needs beyond Node | Level |
|---|---|---|---|---|
| FIDO2 `ed25519-sk` SSH key with verify-required | Yes: the key never leaves hardware | One touch per push | A hardware key; SSH only, not the REST API | Opened (ssh-keygen(1)) |
| Secure Enclave or Windows Hello signing key | Yes | One touch or PIN | A native helper binary | Memory |
| Typed passphrase decrypting a sealed token, plus a signed approval | Partly: fails if the agent reads the terminal or process memory | One passphrase per action | Nothing | Memory (design) |
| `sudo` with `pam_tid` guarding a root-owned key | Partly; needs no passwordless sudo | One touch | macOS only | Opened locally (template present, disabled) |
| `ssh-add -c` | Partly | One dialog per use | `ssh-add` | Opened (ssh-add(1)) |
| 1Password or Bitwarden CLI biometric session | No, inside the unlock window | One prompt per session | A third-party CLI | Memory |
| macOS Keychain ACL, libsecret, DPAPI, Credential Manager, Git Credential Manager | No: same-user code can read them | None | None | Memory |

`node:crypto` provides scrypt, argon2, AES-256-GCM and Ed25519 sign and verify (Node v26 docs, opened).
OWASP's Password Storage cheat sheet (opened) gives Argon2id at 46 MiB with t=1, or scrypt at N=2^17, r=8,
p=1. NIST SP 800-63B and 800-132 were not opened.

Local probes on Node 26.4.0 (2026-09-29): `crypto.argon2` exists as a function; `scryptSync` at N=2^17 throws
`ERR_CRYPTO_INVALID_SCRYPT_PARAMS` with the default `maxmem` and succeeds once `maxmem` is raised to 256 MiB.
So the OWASP scrypt setting needs an explicit `maxmem`, and argon2id is the simpler choice on Node 24 or newer
(confirm it exists on the minimum supported version before relying on it).

## 6. Prior art in agent products

| Product | Enforced mechanism | Advisory or weak point | Level |
|---|---|---|---|
| GitHub agentic workflows | Agent job is read-only and holds no write credential; writes are buffered as "safe outputs" and executed by a separate scoped job; firewall allowlist | The threat-detection step is itself an LLM | Opened |
| Copilot cloud agent | Cannot run `git push`; pushes only to its own branch; firewalled; a human must approve workflow runs | Admins can disable the approval gate | Opened |
| Claude Code sandbox | Seatbelt, bubblewrap and seccomp; egress proxy; `mask` mode swaps in the real token at the proxy only for listed hosts | No built-in credential deny list; default allows reading `~/.ssh`; if the sandbox cannot start it runs unsandboxed unless `failIfUnavailable` is set; native Windows unsupported | Opened |
| Docker Sandboxes (`sbx`) | microVM with a host-side proxy injecting credentials from the keychain, so raw values never enter the VM | Not checked against a determined local attacker | Snippet |
| OpenAI Codex | Network off by default in `workspace-write`; escalation through approvals | Not opened | Snippet |
| MCP authorization draft | OAuth 2.1 with PKCE; resource-bound tokens; servers must reject other tokens | Optional; nothing binds a host that holds the token | Opened |

Not researched: Gemini CLI sandboxing, Cursor, OpenHands, Devin, devcontainers.

## 7. Real incidents

| Incident | What happened | What would have stopped it | Level |
|---|---|---|---|
| Invariant Labs, GitHub MCP, 2025-05-26 | A malicious issue made the agent read private repositories through a broad token and leak them in a public PR | A single-repository token and no autonomous PR creation | Opened |
| "Comment and Control", April 2026 | Injected PR titles or comments made several coding-agent actions leak their API keys and `GITHUB_TOKEN` into public comments | The agent holding no secrets. Egress allowlisting alone would not help, since GitHub itself was the channel | Opened (through a Cloud Security Alliance note); the CVSS figure is snippet only |
| CVE-2026-39861 and CVE-2026-25725 | Sandbox escape through a symlink; trust-dialog bypass through repo-controlled settings | Repo-controlled configuration must never relax policy; fail closed if the sandbox is unavailable | Snippet |

## 8. Same-UID separation on each operating system

| Mechanism | Stops | Does not stop | Level |
|---|---|---|---|
| A second OS user or a helper daemon behind a Unix socket | File theft and same-UID `ptrace` | Setup cost; peer-credential checks prove nothing when the UID is the same | Snippet |
| OpenSSH privilege separation | Escalation, because the monitor and the worker are different UIDs | (works only because the UIDs differ) | Snippet (USENIX 2003) |
| Yama `ptrace_scope` 1 or 3 | Attaching to non-descendants | Reading same-UID files; editing `~/.bashrc` | Opened |
| Seatbelt, bubblewrap, Landlock, seccomp | Filesystem and network access | The host chooses the policy; Windows unsupported by the Claude Code sandbox | Opened (Claude Code docs) |
| A prompt on the user's terminal | Input the agent cannot type | A same-UID process may still write to the terminal device, so the prompt can be spoofed | Memory, unverified |

## 9. Lessons that shape the design

1. **Same-UID files are not a trust boundary.** Approval must be checked against a secret or channel the agent
   cannot reach. (Rule of Two, Hardy.)
2. **Split by capability, not by prompt.** The agent emits a proposal; only the human-approved `submit` and
   `post` ever hold the publishing credential. (gh-aw, Copilot.)
3. **Bind every grant to the exact payload**: repository, branch, SHA or content hash, nonce, expiry.
   (Hardy, Miller, ADR-0005.)
4. **Prompt rarely, and show the payload.** Approval fatigue defeats frequent prompts. (Anthropic.)
5. **Anchor the ledger outside the agent's reach**, and record the size so truncation is detectable.
   (Crosby-Wallach, RFC 9162.)
6. **Ambient credentials are the real hole.** `doctor` should detect them and say so plainly, because
   Riverwright cannot remove the user's `gh` login.
7. **GitHub is itself an exfiltration channel.** Treat issue and PR text as data; scope tokens narrowly.
8. **Fail closed when a sandbox or control is unavailable**, and never let repository-controlled configuration
   relax policy.

## 10. Not verified

- Whether a fine-grained token can open a PR on an upstream repository (implied negative, untested).
- Whether a GitHub App user token needs installation on upstream.
- The Node version that introduced argon2, NIST SP 800-63B and 800-132.
- Whether the Apple-bundled OpenSSH can actually use a FIDO2 key. It lists the `sk-` key types (`ssh -Q key`, OpenSSH 10.3p1), but the provider library that talks to the token was not checked.
- 1Password session length, `/dev/tty` behavior without a controlling terminal.
- CaMeL, Willison, Crosby-Wallach, Schneier-Kelsey and Rekor beyond their snippets; the Beurer-Kellner pattern
  names; OWASP, in-toto and SLSA.
- The Comment and Control CVSS score and the CVE-2026 details; Codex, Gemini CLI, Cursor, OpenHands and Devin.
- Windows AppContainer and restricted tokens; whether Node exposes peer credentials on a Unix socket.
- The ledger-head-in-PR-body witness scheme (inferred).

## 11. Review findings for Plan 2a

Plan 2a, Task 17: two independent reviews of the built security foundation, read-only, on branch
`plan-2a-security` at `df96fd3`. One reviewer was Codex, the other Claude. Each finding has a label:
**CONFIRMED** means the reviewer reproduced it; **PLAUSIBLE** means it was found by reading the code and not
reproduced. The triage that decided what to fix and what to accept is ruling R35. Every fix was written test first; the tests are in
`tests/security-review.test.mjs` (and `tests/credential-cli.test.mjs` for the test-hygiene item).

| ID | Reviewer | Label | Severity | Finding | Outcome |
|---|---|---|---|---|---|
| C1 | Codex | CONFIRMED | Important | A NUL inside an ANSI-C `$'...'` word: bash cuts the quoted text at the NUL, but the lexer kept the rest, so `rw $'credential\0x' setup`, `gh pr $'create\0x' --fill` and `git $'push\0x' fork HEAD` were allowed | Fixed in `caad7d6`: both readings are checked (bash cuts the `$'...'` part; zsh and the kernel cut the whole word), and a raw NUL is read with and without it |
| C2 | Codex | CONFIRMED | Important | An empty or missing ledger ignored `--head`, so `ledger verify --head H` said "intact" after the whole ledger was removed | Fixed in `6a1b9b8`: an empty ledger fails any head but the genesis head; `ledger verify` exits 1 and says why |
| C3 | Codex | PLAUSIBLE | Important | A FIFO planted as a run's `state.json` could stall the hook (a blocking read), and a host that lets a command run after a hook timeout would then allow it | Fixed in `e795e00` (same fix as F4) |
| F1 | Claude | CONFIRMED | Important | node can shift riverwright's arguments: `node - credential setup < riverwright.mjs` and `node --import=./riverwright.mjs - credential setup` ran the credential command unseen | Fixed in `adc2f9c`: when node, bun or deno reads a riverwright file from stdin or preloads one (`--import`, `--require`, `-r`, `--loader`, `--experimental-loader`, `--preload`, `NODE_OPTIONS`), every word after the script operand is checked |
| F2 | Claude | CONFIRMED | Important | A link to the launcher was resolved only against the hook's working directory, not after `cd`, `pushd`, a subshell `cd`, `~` or a glob; the reviewer sealed an agent-chosen vault in a scratch home this way | Fixed in `799df69`: every directory the command may be in is tracked, `~` is the account home (password database) and `HOME`, and a glob path counts when its directory holds a launcher link |
| F3 | Claude | CONFIRMED (classifier), PLAUSIBLE (impact) | Minor | `NODE_OPTIONS`, `PATH`, `LD_PRELOAD` or a node `--require` in front of `riverwright submit` or `post` was allowed, so the passphrase could be typed into code the agent chose | Fixed in `61bad2b`: a new rule, `riverwright-publish-env`, denies these everywhere; the plain trusted publish stays allowed. Replaced by an allowlist in `86f0d03` (ruling R37, below) |
| F4 | Claude | CONFIRMED | Minor | A FIFO at a run's `state.json` hung the hook (measured: killed by an 8-second timeout) | Fixed in `e795e00`: `state.json` is read only as a bounded regular file, opened without blocking; anything else counts as an active run |
| F5 | Claude | PLAUSIBLE | Minor | The gate returns the action's `result` without cleaning it, so an action that echoes the token would pass it on | Accepted (R35): a Plan 2b contract. Spec §7.5 now says the result must not contain the token, and Plan 2b checks each action's result when it builds the actions |
| F6 | Claude | PLAUSIBLE | Minor | An appended, correctly chained `receipt-consumed` line marks a live receipt as used, which blocks the human's own push | Accepted (R35): a denial of service that fails closed; nothing is published. Plan 2b reports this case clearly |

**Test hygiene** (from the Claude reviewer's process note). `credential status` audits the account's home from
`os.userInfo()`, which `HOME` does not change, so tests that isolated `HOME` still read the real `~/.ssh` file
names and key headers. Fixed in `bf74527`: `status` and the hook take an in-process `userInfo` test seam, every
test passes a scratch home, and `os.userInfo` throws while the credential tests run, so a call that skips the
seam fails.

**Limits that remain** (stated in the `classify.mjs` header): a directory held in a variable (`cd "$D" && ./tool`,
`$D/tool`) or another user's home (`~user/tool`) is not resolved. `submit` and `post` do not yet refuse to run
when `NODE_OPTIONS` or a preload is present in their own process; the hook rule is the only check. None of these
fixes has run in CI on all three systems yet.

### Later automated findings that were fixed

An automated security check ran on the R35 fix commits. Two of its findings were fixed, test first:

- **The publish rule was a denylist** (four findings on `61bad2b`). Wrappers in front of `submit` (`strace`,
  `proxychains`, `script`, `expect`), a shell running the launcher as a script, other variables (`BASH_ENV`, `ENV`,
  proxy and TLS settings, `HOME`, `XDG_CONFIG_HOME`) and earlier commands that change the environment (`printf -v`,
  `read`, `source`, `eval`, `alias`, functions) were not on the list. Ruling R37 replaced the list with an allowlist in
  `86f0d03`: `riverwright submit` and `riverwright post` are allowed only when the whole command line is the
  installed launcher's own path, then the subcommand and plain arguments. Nothing may come in front of it (no
  assignment, wrapper, `node` or shell), and nothing else may be on the line. Every other command that could run them
  is denied everywhere. The runtime half (`submit` and `post` refusing to run when their own process has a preload or
  an unsafe `PATH`) belongs to Plan 2b, when those commands exist.
- **The scope check read a NUL one way only** (one finding on `caad7d6`). The classifier checks every NUL reading,
  but `touchesHome` in `scope.mjs` lexed the command the bash way only. So `git -C $RIVERWRIGHT_HOME$'\0'x push`,
  which zsh runs in the workspace, was out of scope. Fixed in `3a8f088`: both use one helper, `readingsOf`, and a
  command is in scope when any reading reaches the workspace.

### Known limits of the hook rule (not chased further, ruling R36)

The same check found eight more spellings of the credential-rule bypass: four on the F1 and F3 fix commits and four
on the F2 fix commit. These are further ways to run `riverwright credential` that the hook does not see. Each was
reported by the check and none was reproduced for this record. Ruling R36 records them here, one class each, as known
limits. It does not fix them. The suggested fixes
are the check's own, in brief, and none is built.

| Class | Example shape | Suggested fix (not built) |
|---|---|---|
| node option values | An unknown node option written without `=` is taken to have no value, so the script operand is guessed wrong: `node --opt VALUE - credential setup < riverwright.mjs` | Use node's own table of options that take a value, or treat an unknown option as maybe taking one and check both positions |
| stdin from a pipeline | The stdin check looks only at the command right before `node`, so a filter in between hides the producer: `cat riverwright.mjs \| tee /dev/null \| node - credential setup` | Follow the pipeline back through pass-through filters (`cat`, `tee`, `head` and the like), or deny `node -` fed by any pipe that names a riverwright file |
| `NODE_OPTIONS` set elsewhere | A preload set in an earlier command (`export NODE_OPTIONS=--import=./riverwright.mjs; node - credential`) or loaded from a file (`node --env-file=.env ...`) | Track `NODE_OPTIONS` set earlier in the line, and treat `--env-file` and `--env-file-if-exists` as a possible preload |
| `data:` and `file:` preloads | A preload given as a URL is not resolved to the launcher: `--import=file:///.../riverwright.mjs`, or a `data:` module that imports the CLI | Turn a `file:` URL into a path before resolving it; treat any `data:` specifier as maybe riverwright |
| `cd` to a pattern | A `cd` target with a glob or brace is not added to the working directories: `cd lin* && ./tool credential setup` | Expand the pattern against the file system when tracking `cd`, or fail closed when a `cd` target has one |
| `~+`, `~-` and `~user` | Only `~` and `~/` are expanded: `cd ~+/links && ./tool credential`, `~user/tool credential` | Read `~+` as the current directories, `~-` as any directory already tracked and `~user` from the password database, or fail closed on any other `~` form |
| `CDPATH` in the command | Only the hook's own `CDPATH` is used, so one set in the command, or a relative entry, is missed: `CDPATH=/tmp/l; cd links && ./tool credential` | Track `CDPATH` set in the command, and resolve relative entries against each working directory |
| A wrapper that changes directory | `env -C DIR` and `sudo -D DIR` change directory before running a relative launcher path: `env -C /tmp/links ./tool credential setup` | Add the wrapper's directory to the working directories before resolving the program word |

**Why these are not chased.** They are the class Task 11 spent five rounds on, and the Task 17 reviews showed the
deeper point. An agent running as the same user can drive a pseudo-terminal (`script`), so it can run
`credential setup --replace` with a passphrase it chose (F2 showed this). It can also skip the command and write a
vault file itself. Either way it can then sign its own receipts. A hook that reads one command line cannot close
that. [ADR-0010](../adr/0010-sealed-credential-released-by-human-unlock.md) already says the outcome is
tamper-evident, not tamper-proof. The cost if this is wrong: an injected agent could still seal its own vault through
an unlisted spelling, and then detection depends on the human noticing.

**Proposed structural mitigation (PROPOSED, awaiting the owner's decision, not built).** Record the vault's
public-key fingerprint in the ledger when the credential is set up. Then `ledger verify`, `doctor` and the gate
warn loudly when the vault's key no longer matches, so a replaced vault leaves evidence the human sees before the
next unlock. This targets the result (a different vault) instead of the many spellings that could produce it. It is
not decided, and nothing in Plan 2a builds it.
