import path from 'node:path';
import { parseArgs } from 'node:util';
import { RiverwrightError } from '../errors.mjs';
import { readAll } from '../io.mjs';
import { runFile } from '../exec.mjs';
import { workspaceHomeFromArg, isInside, realish, runDirForPath } from '../paths.mjs';
import { loadState } from '../state.mjs';
import { approvedSha, approvedBranch } from '../approvals.mjs';
import { appendEvent } from '../ledger.mjs';
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
    io.stderr.write(`Riverwright blocked this push: ${reason}\n`);
    return 1;
  }
  const decision = decidePrePush({ remoteUrl: destination, updates, forkUrl: state.fork?.url ?? null, approvedSha: approvedSha(state, 'submit-gate'), approvedBranch: approvedBranch(state, 'submit-gate') });
  appendEvent(dir, { type: 'guard', at, decision: decision.allow ? 'allow' : 'deny', reason: decision.reason, remoteUrl: destination });
  if (!decision.allow) {
    io.stderr.write(`Riverwright blocked this push: ${decision.reason}\n`);
    return 1;
  }
  return 0;
}
