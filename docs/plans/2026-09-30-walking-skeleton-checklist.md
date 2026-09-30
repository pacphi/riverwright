# Walking skeleton: the checks to run before building Plan 2

**Purpose.** Plans 2a to 2d rest on assumptions about GitHub, real terminals and the Claude Code plugin loader that
have only been read in documentation or exercised with fakes. This checklist tests each of those assumptions for
real, cheaply, before about fifty tasks are built on them. It uses only repositories and accounts you own, builds
nothing in this repository, and produces a results table that feeds the plans.

**Who does what.** You run every step in your own terminal. Nothing here needs the agent to see a token, and none
of these steps should be run by an agent. The checks that need a GitHub token are in checks 3 to 6.

**Rules.**

- Use a throwaway sandbox. Never point a check at a real upstream repository.
- Never paste a token into a chat, a file, a shell history line or a command argument. Type it with `read -rs`
  (below), use it in that one terminal tab, then `unset` it and close the tab.
- Delete the sandbox repositories and revoke the token at the end (cleanup, last section).
- Write each result in the table at the end. A failed check is a useful result, not a mistake.

## Already observed today, before you start

These were run on the build machine on 2026-09-30 and need no action from you.

| # | Observation | Evidence | Consequence |
|---|---|---|---|
| F1 | `gh` refuses to run with no login: with an empty config directory and no token variables it prints "please run gh auth login" and exits. The GitHub REST API itself allows anonymous reads: a plain Node `fetch` of a public pull request list returned status 200 with a limit of 60 requests an hour. | `gh` 2.101.0; Node 26.4.0 | The earlier assumption that agents can read public issues through `gh` while logged out is wrong. Reads need a login or a token, or need to go through a Riverwright command that uses Node's `https`. **A decision is needed** (see "What these results decide"). |
| F2 | `claude plugin marketplace add` and `claude plugin install` both take `--scope user\|project\|local`, and `claude plugin marketplace remove` and `claude plugin uninstall` exist. No environment variable to relocate Claude Code's configuration appears in `claude --help`. | `claude` 2.1.285 | Check 8 uses `--scope local` in a throwaway project, but the plugin registry under `~/.claude/plugins/` still gains entries, so the cleanup commands matter. |
| F3 | `/dev/tty` cannot be opened from a process with no terminal (`ENXIO`). | Node 26.4.0 | Confirms the fail-closed behavior Plan 2a relies on when there is no terminal. |

## Check 1: hidden typing on each operating system

**Decides:** whether Plan 2a's passphrase prompt (Task 4) can hide typing with Node's built-ins on macOS, Linux and
Windows. **Needs:** a real terminal on each system. **No GitHub, no token.**

Save this as `hidden-typing-check.mjs`:

```js
import fs from 'node:fs';
import tty from 'node:tty';

const win = process.platform === 'win32';
const inFd = fs.openSync(win ? 'CONIN$' : '/dev/tty', 'r');
const outFd = fs.openSync(win ? 'CONOUT$' : '/dev/tty', 'w');
fs.writeSync(outFd, `isatty(in)=${tty.isatty(inFd)} isatty(out)=${tty.isatty(outFd)}\n`);
const input = new tty.ReadStream(inFd);
fs.writeSync(outFd, 'Type a few characters, then press Enter (nothing should appear): ');
input.setRawMode(true);
let n = 0;
input.on('data', (chunk) => {
  for (const ch of String(chunk)) {
    if (ch === '\r' || ch === '\n' || ch === '\u0003') {
      input.setRawMode(false);
      input.pause();
      fs.writeSync(outFd, `\nread ${n} characters; raw mode restored\n`);
      process.exit(ch === '\u0003' ? 1 : 0);
    }
    n += 1;
  }
});
```

Run it in a normal terminal on each system: `node hidden-typing-check.mjs`.

**Expected:** both `isatty` values are `true`; the characters you type do not appear; Enter prints the count. Run it
a second time and press Ctrl-C instead: it exits with status 1, and what you type afterwards in the shell is visible
again (raw mode was restored). **Windows:** run it in Windows Terminal with PowerShell, and again in `cmd.exe`.

**Record:** for each system and shell: pass, or what went wrong (for example `isatty` false, an error on `CONIN$`,
or typed characters echoed). If Windows fails, the wizard needs another route there; say so in the table.

## Check 2: the GitHub sandbox

**Decides:** nothing by itself. It sets up checks 3 to 7. **Needs:** your GitHub account `pacphi`.

1. Create a free GitHub organization for throwaways, for example `pacphi-sandbox`. (A fork cannot live in the same
   account as its source, and a fork-scoped token cannot write to a repository you neither own nor belong to, so
   the "upstream" must belong to a different owner than the fork.)
2. In that organization create a **public** repository `rw-skel-upstream` with a `main` branch containing a README
   and a workflow `.github/workflows/ci.yml` that runs `echo ok` on `push` and `pull_request`. It is public because
   the point is to open a pull request from a fork; it holds nothing but throwaway text, and you delete it at the end.
3. Fork it into `pacphi` (the fork is `pacphi/rw-skel-upstream`). Clone your fork:

```bash
git clone https://github.com/pacphi/rw-skel-upstream.git rw-skel && cd rw-skel
git remote add upstream https://github.com/pacphi-sandbox/rw-skel-upstream.git
git switch -c rw-skel-1
```

Finally, create a **fine-grained personal access token** for `pacphi` whose **repository access is only
   `pacphi/rw-skel-upstream`**, with **Contents: read and write** and **Pull requests: read and write**, expiring in
   seven days. Keep it in your password manager. You will type it only in the terminal tabs below.

**Record:** what GitHub let you select for repository access and permissions (a screenshot helps).

## Check 3: can a fork-scoped token open a pull request on an upstream you do not own?

**Decides:** whether Plan 2b's `submit` can use a fork-scoped token for the pull request, or needs a broader
credential (ADR-0010 says this is the open question). **Needs:** check 2, the token.

In a **dedicated terminal tab**, inside `rw-skel`:

```bash
read -rs GH_TOKEN && export GH_TOKEN && echo
git commit --allow-empty -m "skeleton check 1"
git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' push origin rw-skel-1
gh pr create --repo pacphi-sandbox/rw-skel-upstream --head pacphi:rw-skel-1 --base main --draft --title "skeleton check" --body "throwaway"
```

The `push` line is also check 4. The `credential.helper` pair first empties git's helper list, then supplies the token
from this shell's environment, so the token never appears in a command's arguments.

**Expected, one of two outcomes:**

- **It works:** a draft pull request URL is printed. A fork-scoped token is enough, which simplifies `submit`.
- **It fails:** `gh` prints an error such as "Resource not accessible by personal access token" (HTTP 403 or 404).
  Copy the exact message. Then the pull-request credential must be broader (a classic token with `public_repo`, or
  another route), and ADR-0010's guidance for the wizard changes.

**Record:** the outcome and the exact error text.

## Check 4: pushing with the token only in one child's environment

**Decides:** whether the "token only in that git child's environment" design in Plan 2b (Task 6) works with a
fine-grained token over HTTPS. **Needs:** check 3's terminal tab.

The `push` line in check 3 is the test. **Expected:** the push succeeds with no password prompt and no credential
dialog. Then confirm nothing was stored: `git config --show-origin --get-all credential.helper` should show only the
empty entry you passed (nothing persisted), and `ps` output during the push should not contain the token.

**Record:** pass or fail, and whether any prompt or stored credential appeared.

## Check 5: draft to ready, and reading the pull request

**Decides:** the token scope needed for "mark ready" (Plan 2b, Task 9) and for reading state afterwards. **Needs:**
check 3's pull request number (call it `N`).

```bash
gh pr ready N --repo pacphi-sandbox/rw-skel-upstream
gh pr view N --repo pacphi-sandbox/rw-skel-upstream --json state,isDraft
```

**Expected:** ready succeeds and `isDraft` becomes `false`. If it fails, record the error; it means marking ready
needs a scope the fork-scoped token does not have.

Then, in a **different** tab with no token set, test an anonymous read the way Plan 2b's client would make it:

```bash
node -e "fetch('https://api.github.com/repos/pacphi-sandbox/rw-skel-upstream/pulls/N',{headers:{'user-agent':'skeleton','accept':'application/vnd.github+json'}}).then(async r=>{const j=await r.json();console.log(r.status,j.state,j.draft)})"
```

**Expected:** status 200 with the pull request state, since the upstream is public.

**Record:** the outcome of each command.

## Check 6: does CI run on the fork?

**Decides:** whether Plan 2b's "actions not enabled" note and "ready after fork CI" behave as designed. **Needs:**
check 2 (the workflow exists in the upstream before the fork was made).

After the push in check 3, open `https://github.com/pacphi/rw-skel-upstream/actions` in your browser.

**Expected on a new fork:** a banner saying workflows are not being run on the forked repository until you enable
them. Enable them, push another empty commit, and confirm a run starts.

**Record:** whether the banner appeared, whether enabling needed the web UI, and whether `gh api
repos/pacphi/rw-skel-upstream/actions/runs --jq '.workflow_runs[0].status'` (with the token) shows a run afterwards.

## Check 7: a leased push, and what the pre-push hook sees

**Decides:** ADR-0012 and Plan 2a Task 14. The guard assumes git hands a `pre-push` hook the remote tip on standard
input and that `--force-with-lease=<ref>:<sha>` behaves as documented. **Needs:** check 3's terminal tab.

Install a hook that only records what it is given:

```bash
printf '#!/bin/sh\ncat > /tmp/rw-skel-prepush.log\nexit 0\n' > .git/hooks/pre-push && chmod +x .git/hooks/pre-push
```

Then, with the same inline `credential.helper` arguments as check 3 (call the whole prefix `GITPUSH` below):

```bash
A=$(git rev-parse HEAD)
git commit --amend --allow-empty -m "skeleton check 1 (amended)"
B=$(git rev-parse HEAD)
GITPUSH push origin rw-skel-1                                                    # 1. expected: rejected, not a fast-forward
GITPUSH push --force-with-lease=refs/heads/rw-skel-1:$A origin rw-skel-1        # 2. expected: succeeds
cat /tmp/rw-skel-prepush.log
```

Then amend once more and try a **wrong** lease:

```bash
git commit --amend --allow-empty -m "skeleton check 1 (amended twice)"
GITPUSH push --force-with-lease=refs/heads/rw-skel-1:$A origin rw-skel-1        # 3. expected: rejected as stale
```

**Expected:** push 1 is rejected; push 2 succeeds; the log from push 2 holds one line of four fields,
`refs/heads/rw-skel-1 <B> refs/heads/rw-skel-1 <A>`, so the fourth field is the remote tip you leased; push 3 is
rejected ("stale info" or similar) because the remote tip is now `B`, not `A`.

**Record:** each outcome, and paste the hook log line. If the fourth field is not the remote tip during a leased
push, the guard's check in Plan 2a Task 14 must change.

## Check 8: a real plugin install from a `plugin/` folder

**Decides:** ADR-0011's assumptions: that installing from `source: "./plugin"` copies only that folder, that
`${CLAUDE_PLUGIN_ROOT}` is set for hooks and for the Bash tool, that the plugin's `bin/` is on the Bash tool's PATH,
and what a real hook payload looks like. **Needs:** Claude Code 2.1.285 or newer. **Touches:** `~/.claude/plugins/`
(registry and cache). This is the only check that does; the cleanup commands undo it.

Build a throwaway marketplace (anywhere outside this repository, for example `~/rw-skel-market`):

```bash
mkdir -p ~/rw-skel-market/.claude-plugin ~/rw-skel-market/plugin/.claude-plugin ~/rw-skel-market/plugin/bin ~/rw-skel-market/plugin/hooks ~/rw-skel-market/plugin/skills/skel
cd ~/rw-skel-market
cat > .claude-plugin/marketplace.json <<'EOF'
{
  "name": "rw-skel",
  "owner": { "name": "pacphi" },
  "description": "Throwaway walking-skeleton marketplace",
  "plugins": [ { "name": "skel", "source": "./plugin", "description": "Throwaway skeleton plugin" } ]
}
EOF
cat > plugin/.claude-plugin/plugin.json <<'EOF'
{ "name": "skel", "version": "0.0.1", "description": "Throwaway skeleton plugin" }
EOF
printf '#!/bin/sh\necho "skel says hello; root=$CLAUDE_PLUGIN_ROOT"\n' > plugin/bin/skel-hello && chmod +x plugin/bin/skel-hello
printf '#!/bin/sh\n{ cat; printf "\\nROOT=%%s\\n---\\n" "$CLAUDE_PLUGIN_ROOT"; } >> /tmp/rw-skel-hook.log\nexit 0\n' > plugin/bin/log-hook && chmod +x plugin/bin/log-hook
cat > plugin/hooks/hooks.json <<'EOF'
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/bin/sh \"${CLAUDE_PLUGIN_ROOT}/bin/log-hook\"" } ] } ] } }
EOF
printf -- '---\nname: skel\ndescription: Says hello from the skeleton plugin\n---\nRun the skel-hello command and report its output.\n' > plugin/skills/skel/SKILL.md
echo "contributor-only file" > CONTRIBUTING-should-not-ship.md
```

Validate both ways (read-only):

```bash
claude plugin validate --strict .
claude plugin validate --strict ./plugin
```

Install into a throwaway **project** scope, from a scratch project directory:

```bash
mkdir -p ~/rw-skel-project && cd ~/rw-skel-project && git init -q
claude plugin marketplace add ~/rw-skel-market --scope local
claude plugin install skel@rw-skel --scope local
```

Start `claude` in `~/rw-skel-project` and ask: "Run the `skel-hello` command with the Bash tool and show me its
output, then run `echo hi`." Then check:

```bash
cat /tmp/rw-skel-hook.log
find ~/.claude/plugins/cache/rw-skel -maxdepth 4 | head -30
```

**Expected:**

- Both validations pass.
- The cache holds `plugin/`'s contents (the `bin/`, `hooks/`, `skills/` and `.claude-plugin/` folders) and **not**
  `CONTRIBUTING-should-not-ship.md` or the repository root.
- The hook log has one JSON payload per Bash call. Note the exact field names (`tool_input.command`, `cwd`,
  `hook_event_name`, ...) and that `ROOT=` names the versioned cache folder.
- `skel-hello` runs as a bare command in the Bash tool (so `bin/` is on PATH) and prints the root.

**Record:** each expectation: met, or what differed, plus the pasted payload of one Bash call. If `bin/` is not on
PATH or `CLAUDE_PLUGIN_ROOT` is empty in the Bash tool, Plan 2c's skills must call the launcher by another route.

## Check 9 (optional): argon2 on Node 24

**Decides:** whether `defaultKdf()` uses Argon2id or the scrypt fallback on the oldest supported Node. **Needs:**
Node 24 (for example through `fnm`, `nvm` or Docker; CI will also show this later).

```bash
node -p "typeof require('crypto').argon2Sync"
```

**Expected:** `function`. If it prints `undefined`, the scrypt fallback (N=2^17 with an explicit `maxmem`) is the
path on Node 24, and Plan 2a's fallback test should also execute it at full strength, not only by value.

## Check 10 (optional): a hardware key

Only if you have a FIDO2 security key. `ssh-keygen -t ed25519-sk -O verify-required -f /tmp/rw-sk-test`, then note
whether the key type works with Apple's bundled OpenSSH (`ssh -Q key | grep sk-` already lists the types here;
whether it can talk to a token is the question) and whether a touch is required for `ssh-keygen -Y sign -f
/tmp/rw-sk-test -n riverwright /dev/null`. Nothing is pushed.

## Cleanup

1. In the token's terminal tab: `unset GH_TOKEN`, then close the tab. Revoke the token in GitHub settings.
2. Delete `pacphi/rw-skel-upstream` (the fork), and the organization's `rw-skel-upstream`, or the whole
   `pacphi-sandbox` organization.
3. `claude plugin uninstall skel@rw-skel --scope local` and `claude plugin marketplace remove rw-skel`, then delete
   `~/rw-skel-market`, `~/rw-skel-project`, `/tmp/rw-skel-hook.log` and `/tmp/rw-skel-prepush.log`.
4. Delete `hidden-typing-check.mjs` and the local `rw-skel` clone.

## Results

Fill this in as you go. Paste exact error text where asked.

| Check | Result (pass, fail, partial) | Exact outcome or error | Date and system |
|---|---|---|---|
| 1 macOS | | | |
| 1 Linux | | | |
| 1 Windows (PowerShell, cmd) | | | |
| 3 fork-scoped token opens a PR on the upstream | | | |
| 4 push with the token in one child's environment | | | |
| 5 ready, view, anonymous read | | | |
| 6 fork CI banner and enabling | | | |
| 7 leased push and the hook's fourth field | | | |
| 8 plugin install: cache contents, `bin/` on PATH, `CLAUDE_PLUGIN_ROOT`, hook payload | | | |
| 9 argon2 on Node 24 (optional) | | | |
| 10 hardware key (optional) | | | |

## What these results decide

| Result | What changes |
|---|---|
| **F1** (`gh` will not run logged out; anonymous API reads work) | Decide how agents read GitHub. Options: require a `gh` login (an ambient credential), give `gh` a separate read-only token, or add a `riverwright` read command built on Node's `https` (anonymous, 60 requests an hour, and an optional read-only token) and keep `gh` only for humans. This reopens the `gh` choice you made in the earlier question 4. |
| Check 3 fails | The pull-request credential cannot be fork-scoped. Plan 2b's token guidance and ADR-0010's wizard text change, and the "fork-scoped token" mitigation is dropped. |
| Check 4 shows a prompt or a stored credential | Plan 2b Task 6's push mechanism changes. |
| Check 5 ready fails | Plan 2b Task 9 needs a broader scope or a different route for "mark ready". |
| Check 6 needs the web UI | The "actions not enabled" note becomes a hand-off step, not something `submit` can fix. |
| Check 7's fourth field differs | Plan 2a Task 14's guard check changes before it is built. |
| Check 8 differs on cache contents, `bin/` on PATH, `CLAUDE_PLUGIN_ROOT` or the payload | ADR-0011 and Plan 2c change, and Plan 1's assumed hook payload for Claude Code is replaced by the captured one. |
| Check 1 fails on Windows | Plan 2a Task 4's Windows route and the wizard need another approach there. |
| Check 9 prints `undefined` | Plan 2a's KDF fallback test runs at full strength. |

When the table is filled in, append the results to `docs/research/credential-separation.md` and
`docs/research/plugin-layout.md` under "Results of the walking skeleton", and change the matching lines in their
"Not verified" sections.
