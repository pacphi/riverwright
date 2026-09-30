import path from 'node:path';
import { UpfError } from '../errors.mjs';
import { readAll } from '../io.mjs';
import { runFile } from '../exec.mjs';
import { upfHome, isInside, realish, runDirForPath } from '../paths.mjs';
import { loadState } from '../state.mjs';
import { approvedSha, approvedBranch } from '../approvals.mjs';
import { appendEvent } from '../ledger.mjs';
import { parsePrePushLines, decidePrePush } from '../guard.mjs';
import { nowIso } from '../clock.mjs';

// Test seam only. UPF_RUN_DIR and `git config upf.run` are inputs the agent controls, so outside the
// test suite the run is located from the repository being pushed.
async function testRunDir(io) {
  if (io.env.UPF_RUN_DIR) return io.env.UPF_RUN_DIR;
  const r = await runFile('git', ['config', '--get', 'upf.run'], { cwd: io.cwd });
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

export async function run(args, io) {
  const [sub, remoteName, remoteUrl] = args;
  if (sub !== 'pre-push') throw new UpfError('USAGE', 'usage: upf guard pre-push <remote-name> <remote-url>');
  const updates = parsePrePushLines(await readAll(io.stdin));
  const home = upfHome(io.env);
  let located = null;
  if (io.env.UPF_TEST === '1') {
    const dir = await testRunDir(io);
    if (dir) located = { dir, runId: null };
  }
  located ??= await runFromRepository(io, home);
  if (!located) {
    io.stderr.write('upstream-pr-filer: this clone is managed by upstream-pr-filer but its run record is missing, so the push is blocked.\n');
    return 1;
  }
  const { dir } = located;
  const state = loadState(dir);
  const destination = remoteUrl ?? remoteName;
  const at = nowIso(io.env);
  if (located.runId && state.runId !== located.runId) {
    const reason = `The run record at ${dir} belongs to ${state.runId}, not ${located.runId}.`;
    appendEvent(dir, { type: 'guard', at, decision: 'deny', reason, remoteUrl: destination });
    io.stderr.write(`upstream-pr-filer blocked this push: ${reason}\n`);
    return 1;
  }
  const decision = decidePrePush({ remoteUrl: destination, updates, forkUrl: state.fork?.url ?? null, approvedSha: approvedSha(state, 'submit-gate'), approvedBranch: approvedBranch(state, 'submit-gate') });
  appendEvent(dir, { type: 'guard', at, decision: decision.allow ? 'allow' : 'deny', reason: decision.reason, remoteUrl: destination });
  if (!decision.allow) {
    io.stderr.write(`upstream-pr-filer blocked this push: ${decision.reason}\n`);
    return 1;
  }
  return 0;
}
