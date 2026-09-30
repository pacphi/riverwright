import { UpfError } from '../errors.mjs';
import { readAll } from '../io.mjs';
import { runFile } from '../exec.mjs';
import { loadState } from '../state.mjs';
import { approvedSha } from '../approvals.mjs';
import { appendEvent } from '../ledger.mjs';
import { parsePrePushLines, decidePrePush } from '../guard.mjs';

async function runDirFromGit(cwd) {
  const r = await runFile('git', ['config', '--get', 'upf.run'], { cwd });
  return r.code === 0 ? r.stdout.trim() || null : null;
}

export async function run(args, io) {
  const [sub, remoteName, remoteUrl] = args;
  if (sub !== 'pre-push') throw new UpfError('USAGE', 'usage: upf guard pre-push <remote-name> <remote-url>');
  const updates = parsePrePushLines(await readAll(io.stdin));
  const dir = io.env.UPF_RUN_DIR || (await runDirFromGit(io.cwd));
  if (!dir) {
    io.stderr.write('upstream-pr-filer: this clone is managed by upstream-pr-filer but its run record is missing, so the push is blocked.\n');
    return 1;
  }
  const state = loadState(dir);
  const destination = remoteUrl ?? remoteName;
  const decision = decidePrePush({ remoteUrl: destination, updates, forkUrl: state.fork?.url ?? null, approvedSha: approvedSha(state, 'submit-gate') });
  appendEvent(dir, { type: 'guard', at: io.env.UPF_NOW ?? new Date().toISOString(), decision: decision.allow ? 'allow' : 'deny', reason: decision.reason, remoteUrl: destination });
  if (!decision.allow) {
    io.stderr.write(`upstream-pr-filer blocked this push: ${decision.reason}\n`);
    return 1;
  }
  return 0;
}
