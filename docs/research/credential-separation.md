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
