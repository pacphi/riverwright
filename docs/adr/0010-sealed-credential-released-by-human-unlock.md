---
id: ADR-0010
title: The publishing credential is sealed and released only by a human unlock inside submit and post
status: Accepted
date: 2026-09-29
authors:
  - pacphi
tags: [security, credentials, approvals, ledger, prompt-injection]
---

## Context

ADR-0004 named a residual risk: the approval record is a file the agent can write, and the user's GitHub
credentials are reachable by the agent, which runs as the same operating-system user. Two independent
reviews called this the most important open gap.

The research record ([credential separation](../research/credential-separation.md)) found:

- The agent has all three legs of the lethal trifecta: untrusted upstream text, the user's credentials and
  an outward channel. Meta's Agents Rule of Two says that needs a reliable human check.
- Detectors are not reliable: adaptive attacks broke 12 published defenses, most above 90%.
- Users approve 93% of permission prompts, so frequent prompts do not protect anyone.
- A fine-grained GitHub token is limited to one owner's resources and probably cannot open a pull request on
  an upstream repository the user does not own (untested). The credential that opens the pull request is
  coarse, so the gate on that credential matters more than its scope.
- On one operating-system user, a file, an environment variable, a keychain item, Windows DPAPI and libsecret
  are all readable by the agent. A hash chain in a writable file can be rewritten or truncated without
  detection unless its head is held somewhere the agent cannot write.
- Hardware-backed keys (FIDO2, Secure Enclave, Windows Hello) do resist a same-user agent, but need hardware
  or a compiled helper, which ADR-0003 rules out as a default.

## Decision

We will make the human step and the credential release the same act.

1. **Sealed credential.** `riverwright credential setup` reads the GitHub token and a passphrase from the
   terminal, generates an Ed25519 signing key, and stores both encrypted in one vault file. The key comes
   from the passphrase with Argon2id (scrypt with an explicit memory limit where `crypto.argon2` is missing),
   at or above the OWASP minimum, and the cipher is AES-256-GCM. The token is never in an environment
   variable, a git config, an argument list or a plain file.
2. **Unlock inside the action.** `riverwright submit` and `riverwright post` compute the exact payload
   themselves from the live repository (a full commit SHA, or the SHA-256 of the normalized text), print it
   with a plain summary, then read the passphrase from the terminal. They fail closed when there is no
   terminal. The passphrase both releases the credential and signs a receipt.
   If the action fails for a transient reason (network error, server 5xx, rate limit), the same process retries
   a bounded number of times within a short window, without asking again. Before each attempt it recomputes the
   payload and stops if it changed. The unlocked token stays in that process's memory only: nothing is cached
   across runs, so a run that exits or dies needs a new unlock.
3. **No separate approve step for public gates.** For `submit-gate`, `post-issue` and `post-comment` there is
   no `riverwright approve`; the unlock is the approval. `checkpoint-1`, which publishes nothing, stays a
   plain recorded approval. The host-ask exception for the submit gate is removed, because a host prompt
   cannot release the credential.
4. **Receipt in the ledger.** Each unlock appends a signed receipt: gate, run, binding, the ledger head and
   the next sequence number at signing time, a nonce and a time. Signing the head anchors the chain: a
   rewrite before that point breaks the signature, and each public action anchors it again.
5. **Ambient credentials are reported, not hidden.** `riverwright doctor` lists credential routes the agent
   could use without Riverwright: token variable names (never values), `gh` login state (exit status only),
   configured git credential helpers, loaded SSH keys, and private key files. It says plainly what each
   means. Riverwright cannot remove the user's own login.
6. **Optional hardware push key.** A FIDO2 `sk-` SSH key with user verification may be used for the push
   only. It is opt-in and needs no compiled helper, because it only spawns `ssh`. Pull requests and
   comments still use the sealed token.
7. **A separate operating-system user or a sandbox is documented, not built.** It is the only route to
   real tamper-proofing and it costs setup.

We rejected: a fork-only token as the mechanism (it cannot open the pull request); network egress limits as a
2a feature (six hosts, six different sandboxes, and GitHub itself is the exfiltration channel); a
session-long unlock (an agent could act inside the window); and keeping `approve` as a separate step (a
second prompt that adds friction and leaves a record the agent could forge).

## Consequences

**Positive:** forging consent no longer means writing a JSON file; it takes an active local attack. One
prompt per public action instead of two, which matches the approval-fatigue evidence. The ledger is anchored
without publishing internal hashes. The design needs only Node built-ins.

**Negative:** one passphrase per public action, and a new unlock after a run that exits. A forgotten
passphrase means running setup again. Plan 1's
`approve` command, its host-ask exception and their tests change.

**Neutral:** the pre-push guard stays as defense in depth. It can check for a signed, unconsumed receipt for
the exact SHA, but the key that verifies it sits in a file the agent can replace, so the guard stops
accidents and injection, not a deliberate forger.

**Residual risk, stated plainly:** an agent that can read the terminal or the unlock process's memory, or
that uses an ambient `gh` login, can still publish. The default outcome is tamper-evident and
injection-resistant, not tamper-proof. Passing the token to one child process through its environment leaves
a short window a same-user process could observe.

## Verification

Tests must show, first failing: a forged approval file does not release the credential; a payload changed
after display is rejected; no terminal means no action; a wrong passphrase releases nothing; the ledger head
in a receipt detects a rewritten or truncated history; `doctor` never prints a credential value. A fresh
review by a second model family follows the build, with reviewers read-only.

## Related

- [Research record](../research/credential-separation.md)
- [Core spec](../specs/core-single-issue-pipeline.md), sections 6, 7.1 and 7.5
- [Thread record spec](../specs/thread-record-and-audit.md), sections 9 and 13
- [ADR-0004](0004-three-locks-primary-lock-in-git.md), [ADR-0005](0005-approvals-bound-to-exact-content.md)
  (this decision refines ADR-0005: bindings and terminal confirmation stand; the separate approve step for
  public gates does not), [ADR-0003](0003-dependency-free-node-runtime.md)

## Implementation status

Updated 2026-10-29. Built by [Plan 2a](../plans/2026-09-30-plan-2a-security-foundation.md) on the branch
`plan-2a-security`, reviewed task by task, not yet merged into `develop`, not yet run in CI on all three systems, and
not yet through the owner's manual checks (Task 16). The independent security review (Task 17: two reviews and a
Codex re-review) is done; its outcomes are in
[research §11](../research/credential-separation.md#11-review-findings-for-plan-2a).

- **Built:** the vault and `riverwright credential setup|status|remove` (item 1); the public gate
  `runPublicAction` with the summary, the passphrase unlock, the recompute before the action and before every retry,
  and the bounded retry (item 2); `approve` narrowed to `checkpoint-1` and the submit proof read from a receipt, not
  `state.json` (item 3); signed receipts in the ledger and `ledger verify` (item 4); the ambient-credential audit,
  shown by `credential status` (item 5); the hardware push key's record and its ssh command (item 6); the pre-push
  guard trusting the newest verified receipt; the guard installed into a clone; and the hook rule that denies an
  agent's `riverwright credential`.
- **Not built:** the `submit` and `post` commands that call the gate, and `doctor`, which will show the audit
  (Plan 2b); the push that uses the hardware key (Plan 2b); the touch and PIN behavior, and the real-terminal echo
  check on Windows (Task 16).
- **Built differently from the text above, and why.** Item 4 lists gate, run, binding, ledger head, `seq`, nonce
  and time; the built receipt also signs the branch, the fork (`host/owner/repo`, so a forged fork URL in
  `state.json` cannot redirect the push) and the lease of [ADR-0012](0012-leased-force-push-for-resubmits.md), eleven
  fields in a fixed order. A receipt without the fork and lease fields fails closed. Item 5 names `doctor`; until
  `doctor` exists the report is `credential status`. Item 6 says the key "only spawns ssh"; the built command also
  isolates ssh from the user's and the system's SSH configuration (`-F /dev/null` and options that turn off other
  identities, the agent, certificates, PKCS#11 and proxy commands), so the owner's SSH host aliases and `ProxyJump`
  do not apply to that push. The owner chose to keep this on 2026-10-29. The terminal prompt also refuses a terminal that
  cannot hide typing.
- **Residual risks found while building**, in addition to those stated above: removing the tail of the ledger
  revives a used receipt until it expires (10 minutes), because nothing the agent cannot write remembers the newer
  head; and because the receipt is written before the action and recorded as used only afterwards (so the guard
  sees it unused during the gate's own push), a crash during the action leaves it usable for up to 10 minutes,
  bound to the exact commit, branch and fork. `ledger verify` and the submit proof read the vault from the account's
  own workspace, never from `RIVERWRIGHT_HOME`, so with a vault sealed under a custom `RIVERWRIGHT_HOME` they fail
  closed. The owner decided on 2026-10-29 that the vault always lives in the account home; credential setup, status and remove follow the same rule, so there is no split. Details: [core spec §7.5](../specs/core-single-issue-pipeline.md).
- **Decision of record.** The 11-field receipt and the crash window above change what item 2 and item 4 say. They
  are written up in [ADR-0014](0014-receipt-fields-and-crash-window.md), which the owner accepted on 2026-10-29
  (option A: the crash window is kept and recorded as an exception to item 2).
