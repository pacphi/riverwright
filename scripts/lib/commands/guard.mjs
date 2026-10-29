import path from 'node:path';
import { parseArgs } from 'node:util';
import { printable } from '../printable.mjs';
import { RiverwrightError } from '../errors.mjs';
import { readAll } from '../io.mjs';
import { runFile } from '../exec.mjs';
import { workspaceHomeFromArg, isInside, realish, runDirForPath } from '../paths.mjs';
import { loadState } from '../state.mjs';
import { appendEvent, ledgerDirFor } from '../ledger.mjs';
import { readEvents } from '../events.mjs';
import { readVault } from '../vault.mjs';
import { findValidReceipt } from '../receipt.mjs';
import { parsePrePushLines, decidePrePush } from '../guard.mjs';
import { nowIso } from '../clock.mjs';

// In-process test seam only: io.testing is supplied by the test helper and never by scripts/riverwright.mjs,
// so no environment variable, git config or flag can reach it. In production the run is always located
// from the repository being pushed.
async function testRunDir(io) {
  if (io.testing.runDir) return io.testing.runDir;
  const r = await runFile('git', ['config', '--get', 'riverwright.run'], { cwd: io.cwd });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

// <home>/<owner>/<repo>/worktrees/issue-<n> (the top of the worktree being pushed) owns
// <home>/<owner>/<repo>/runs/issue-<n>, whose runId must be <owner>/<repo>#<n>.
async function runFromRepository(io, home) {
  const r = await runFile('git', ['rev-parse', '--show-toplevel'], { cwd: io.cwd });
  const top = r.code === 0 ? r.stdout.trim() : '';
  if (!top || !isInside(top, home)) return null;
  const parts = path.relative(realish(home), realish(top)).split(path.sep);
  const m = /^issue-([1-9]\d*)$/.exec(parts[3] ?? '');
  if (parts.length !== 4 || parts[2] !== 'worktrees' || !m) return null;
  const dir = runDirForPath(home, top);
  return dir ? { dir, runId: `${parts[0]}/${parts[1]}#${m[1]}` } : null;
}

const GATE = 'submit-gate';
const NOTHING_UNLOCKED = 'Nothing has been unlocked';
const isObject = (e) => e !== null && typeof e === 'object' && !Array.isArray(e);

// Consent for a push is a signed, unused, current submit-gate receipt for this run in the ledger (ADR-0010,
// spec §7.1), verified against the vault's public key. state.json is not consulted: an agent can write it.
// The gate writes the receipt before it runs `git push` and records the outcome only afterwards (ruling R12),
// so during the gate's own push the receipt is unused; once an outcome or a claim is recorded it is used.
//
// The binding looked up is the commit being pushed, never one read from the ledger, so only a receipt the
// human signed for that exact commit can authorize it. When there is none, the newest submit-gate receipt for
// this run is checked for its own commit, so the refusal can name the commit that was unlocked; decidePrePush
// refuses every update whose SHA differs from it, so that receipt can let through only a push that updates
// nothing (git runs the hook with no lines when everything is up to date).
// Returns { receipt } or { receipt: null, why }. Every failure, including an unreadable vault or ledger, denies.
function unlockedReceipt({ home, dir, run, updates, nowMs }) {
  try {
    const ledgerDir = ledgerDirFor(dir);
    const { publicKey } = readVault(home);
    const look = (value) => findValidReceipt({ ledgerDir, publicKey, gate: GATE, run, nowMs, binding: { kind: 'sha', value } });
    const pushed = typeof updates[0]?.localSha === 'string' ? updates[0].localSha.toLowerCase() : null;
    let why = null;
    if (pushed) {
      const exact = look(pushed);
      if (exact.ok) return { receipt: exact.receipt };
      why = exact.reason;
    }
    const newest = readEvents(ledgerDir)
      .filter((e) => isObject(e) && e.event === 'approved' && e.data?.receipt?.gate === GATE && e.data.receipt.run === run)
      .at(-1)?.data.receipt.binding;
    if (newest?.kind === 'sha' && typeof newest.value === 'string' && newest.value !== pushed) {
      const other = look(newest.value);
      if (other.ok) return { receipt: other.receipt };
      why = other.reason;
    }
    return { receipt: null, why: why ?? 'no receipt for this gate and run: unlock through "riverwright submit"' };
  } catch (e) {
    return { receipt: null, why: e instanceof RiverwrightError ? e.message : 'the receipt could not be checked' };
  }
}

const USAGE = 'usage: riverwright guard pre-push [--home <workspace>] -- <remote-name> <remote-url>';

export async function run(args, io) {
  const [sub, ...rest] = args;
  if (sub !== 'pre-push') throw new RiverwrightError('USAGE', USAGE);
  // The generated hook passes --home and then "--", so git's remote name and URL are never read as options.
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { home: { type: 'string' } } });
  const [remoteName, remoteUrl] = positionals;
  const home = workspaceHomeFromArg(values.home);
  const updates = parsePrePushLines(await readAll(io.stdin));
  let located = null;
  if (io.testing?.allowRunDirOverride) {
    const dir = await testRunDir(io);
    if (dir) located = { dir, runId: null };
  }
  located ??= await runFromRepository(io, home);
  if (!located) {
    io.stderr.write('Riverwright: this clone is managed by Riverwright but its run record is missing, so the push is blocked.\n');
    return 1;
  }
  const { dir } = located;
  const state = loadState(dir);
  const destination = remoteUrl ?? remoteName;
  const at = nowIso(io);
  if (located.runId && state.runId !== located.runId) {
    const reason = `The run record at ${dir} belongs to ${state.runId}, not ${located.runId}.`;
    appendEvent(dir, { type: 'guard', at, decision: 'deny', reason, remoteUrl: destination });
    io.stderr.write(`Riverwright blocked this push: ${printable(reason)}\n`);
    return 1;
  }
  // The run is the one the repository path names; only the in-process test seam leaves it to state.json.
  const { receipt, why } = unlockedReceipt({ home, dir, run: located.runId ?? state.runId, updates, nowMs: Date.parse(at) });
  const decision = decidePrePush({
    remoteUrl: destination, updates, forkUrl: state.fork?.url ?? null,
    approvedSha: receipt ? receipt.binding.value : null,
    approvedBranch: receipt ? receipt.branch : null,
  });
  // The receipt's reason explains only the "nothing unlocked" refusal, not a wrong destination or a missing fork.
  if (!decision.allow && !receipt && why && decision.reason.startsWith(NOTHING_UNLOCKED)) decision.reason = `${decision.reason} (${why})`;
  appendEvent(dir, { type: 'guard', at, decision: decision.allow ? 'allow' : 'deny', reason: decision.reason, remoteUrl: destination });
  if (!decision.allow) {
    io.stderr.write(`Riverwright blocked this push: ${printable(decision.reason)}\n`);
    return 1;
  }
  return 0;
}
