import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { printable } from '../printable.mjs';
import { RiverwrightError } from '../errors.mjs';
import { readAll } from '../io.mjs';
import { runFile } from '../exec.mjs';
import { workspaceHomeFromArg, isInside, realish, runDirForPath } from '../paths.mjs';
import { loadState } from '../state.mjs';
import { appendEvent, ledgerDirFor } from '../ledger.mjs';
import { readVault } from '../vault.mjs';
import { findNewestValidReceipt, newestReceiptEvent } from '../receipt.mjs';
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

// Whether each update fast-forwards the remote tip git reported, asked of git itself (ADR-0012). The clone is
// agent-writable, so the question is asked with everything in it that can rewrite history turned off: replace refs
// (--no-replace-objects), grafts (GIT_GRAFT_FILE pointing at a file that does not exist) and the commit-graph
// file (core.commitGraph=false). Ancestry then comes only from the commit objects, which are named by their own
// hash. Only exit 0 is a fast-forward: a tip whose objects are missing, a shallow history, a timeout or any other
// git failure counts as "not a fast-forward". A new branch (remote tip all zeros) is not asked about. The SHAs were
// checked as full hex by parsePrePushLines, so neither can be read as an option.
async function withFastForward(updates, cwd) {
  const noGrafts = path.join(os.tmpdir(), `riverwright-no-grafts-${crypto.randomUUID()}`);
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: noGrafts };
  return Promise.all(updates.map(async (u) => {
    if (/^0+$/.test(u.remoteSha) || /^0+$/.test(u.localSha)) return u;
    const r = await runFile('git', ['--no-replace-objects', '-c', 'core.commitGraph=false', 'merge-base', '--is-ancestor', u.remoteSha, u.localSha], { cwd, env });
    return { ...u, fastForward: r.code === 0 };
  }));
}

// Consent for a push is the NEWEST submit-gate receipt for this run in the ledger, if it is signed, anchored,
// unused and current, verified against the vault's public key (ADR-0010, spec §7.1; ruling R17). state.json is
// not consulted: an agent can write it. A newer unlock supersedes every older receipt, so an older receipt no
// longer authorizes its commit or branch, and a used or expired newest receipt is not replaced by an older one.
// The gate writes the receipt before it runs `git push` and records the outcome only afterwards (ruling R12),
// so during the gate's own push the receipt is unused; once an outcome or a claim is recorded it is used.
//
// The receipt only says which commit and branch are unlocked; decidePrePush refuses every update that differs
// from them, using the SHAs git sends on stdin. A receipt can therefore let through only the approved commit on
// the approved branch, or a push that updates nothing (git runs the hook with no lines when everything is up
// to date).
// The newest event is only located here (by ledger position); findValidReceipt then verifies that event alone, by
// seq, so a forged newest event is refused and never falls back or resolves to an older receipt.
// Returns { receipt } or { receipt: null, why }. Every failure, including an unreadable vault or ledger, denies.
function unlockedReceipt({ home, dir, run, nowMs }) {
  try {
    const ledgerDir = ledgerDirFor(dir);
    const { publicKey } = readVault(home);
    const newest = newestReceiptEvent(ledgerDir, GATE, run);
    if (!newest) return { receipt: null, why: 'no receipt for this gate and run: unlock through "riverwright submit"' };
    if (newest.data.receipt.binding?.kind !== 'sha' || typeof newest.data.receipt.binding.value !== 'string') return { receipt: null, why: 'the newest receipt is not bound to a commit' };
    const found = findNewestValidReceipt({ ledgerDir, publicKey, gate: GATE, run, nowMs, binding: newest.data.receipt.binding });
    return found.ok ? { receipt: found.receipt } : { receipt: null, why: found.reason };
  } catch (e) {
    return { receipt: null, why: e instanceof RiverwrightError ? e.message : 'the receipt could not be checked' };
  }
}

// The guard's own ledger record. If it cannot be written the push is still refused, with one clean line.
function record(dir, event) {
  try {
    appendEvent(dir, event);
    return null;
  } catch (e) {
    return e instanceof RiverwrightError ? e.message : 'the guard could not write its record to the ledger';
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
  let updates;
  try {
    updates = parsePrePushLines(await readAll(io.stdin));
  } catch (e) {
    if (!(e instanceof RiverwrightError)) throw e;
    io.stderr.write(`Riverwright blocked this push: ${printable(e.message)}\n`);
    return 1;
  }
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
  updates = await withFastForward(updates, io.cwd);
  const { dir } = located;
  const state = loadState(dir);
  const destination = remoteUrl ?? remoteName;
  const at = nowIso(io);
  if (located.runId && state.runId !== located.runId) {
    const reason = `The run record at ${dir} belongs to ${state.runId}, not ${located.runId}.`;
    const failed = record(dir, { type: 'guard', at, decision: 'deny', reason, remoteUrl: destination });
    io.stderr.write(`Riverwright blocked this push: ${printable(failed ? `${reason} (${failed})` : reason)}\n`);
    return 1;
  }
  // The run is the one the repository path names; only the in-process test seam leaves it to state.json.
  const run = located.runId ?? state.runId;
  const { receipt, why } = unlockedReceipt({ home, dir, run, nowMs: Date.parse(at) });
  const decision = decidePrePush({
    remoteUrl: destination, updates, forkUrl: state.fork?.url ?? null,
    approvedSha: receipt ? receipt.binding.value : null,
    approvedFork: receipt ? receipt.fork : null,
    approvedBranch: receipt ? receipt.branch : null,
    approvedLease: receipt ? receipt.lease : null,
    upstream: run,
  });
  // The receipt's reason explains only the "nothing unlocked" refusal, not a wrong destination or a missing fork.
  if (!decision.allow && decision.code === 'NOTHING_UNLOCKED' && why) decision.reason = `${decision.reason} (${why})`;
  const failed = record(dir, { type: 'guard', at, decision: decision.allow ? 'allow' : 'deny', reason: decision.reason, remoteUrl: destination });
  if (failed) {
    io.stderr.write(`Riverwright blocked this push: ${printable(`the guard could not write its record, so the push is refused (${failed})`)}\n`);
    return 1;
  }
  if (!decision.allow) {
    io.stderr.write(`Riverwright blocked this push: ${printable(decision.reason)}\n`);
    return 1;
  }
  return 0;
}
