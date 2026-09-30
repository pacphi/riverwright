import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { UpfError } from '../errors.mjs';
import { makeBinding, recordApproval, normalizeBranch } from '../approvals.mjs';
import { loadState, saveState } from '../state.mjs';
import { appendEvent } from '../ledger.mjs';
import { openTerminal, confirmTyped } from '../tty.mjs';
import { nowIso } from '../clock.mjs';
import { assertHost } from '../hosts.mjs';

// The submit gate publishes, so it is confirmed in the terminal by default. The host's own permission
// prompt (host-ask) remains the default for checkpoint-1 and the post gates.
export const APPROVAL_MODE_DEFAULTS = Object.freeze({ 'submit-gate': 'tty' });

export async function run(args, io) {
  const [gate, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: { run: { type: 'string' }, sha: { type: 'string' }, 'content-file': { type: 'string' }, mode: { type: 'string' }, host: { type: 'string' }, branch: { type: 'string' } },
  });
  const dir = values.run ?? io.env.RIVERWRIGHT_RUN_DIR;
  if (!dir) throw new UpfError('NO_RUN', 'pass --run <run directory> or set RIVERWRIGHT_RUN_DIR');
  const host = assertHost(values.host ?? null);
  if (gate === 'submit-gate' && values.branch === undefined) throw new UpfError('NEEDS_BRANCH', 'the submit gate approves a commit on one branch: pass --branch upf/<number>-<slug>');
  if (gate !== 'submit-gate' && values.branch !== undefined) throw new UpfError('USAGE', '--branch applies only to the submit gate');
  const branch = values.branch === undefined ? undefined : normalizeBranch(values.branch);
  const mode = values.mode ?? io.env.RIVERWRIGHT_APPROVAL_MODE ?? APPROVAL_MODE_DEFAULTS[gate] ?? 'host-ask';
  if (gate === 'submit-gate' && mode === 'host-ask' && io.env.RIVERWRIGHT_ALLOW_HOST_ASK_SUBMIT !== '1') {
    throw new UpfError('TTY_REQUIRED', 'the submit gate is approved in a terminal: run "riverwright approve submit-gate ... --mode tty" yourself (host-ask for this gate needs RIVERWRIGHT_ALLOW_HOST_ASK_SUBMIT=1)');
  }
  const now = nowIso(io.env);
  const content = values['content-file'] !== undefined ? fs.readFileSync(values['content-file'], 'utf8') : undefined;
  const binding = makeBinding({ sha: values.sha, content });
  const state = loadState(dir);
  if (mode === 'tty') {
    const terminal = io.openTerminal ? io.openTerminal() : openTerminal({ platform: io.platform });
    const expected = binding.kind === 'sha' ? binding.value.slice(0, 7) : 'yes';
    const what = binding.kind === 'sha' ? `commit ${binding.value}${branch ? ` on ${branch}` : ''}` : `content ${binding.value}`;
    const how = binding.kind === 'sha' ? 'the first 7 characters of the commit' : 'yes';
    const ok = await confirmTyped({ terminal, question: `Approve ${gate} for ${state.runId} (${what})?\nType ${how} to approve: `, expected });
    if (!ok) {
      io.stderr.write('Not approved. Nothing was recorded.\n');
      return 1;
    }
  }
  saveState(dir, recordApproval(state, { gate, sha: values.sha, content, mode, host, now, branch }));
  appendEvent(dir, { type: 'approval', at: now, gate, binding, mode, host, ...(branch ? { branch } : {}) });
  io.stdout.write(`Approved ${gate} for ${state.runId}: ${binding.kind} ${binding.value}\n`);
  return 0;
}
