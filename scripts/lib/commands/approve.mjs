import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { RiverwrightError } from '../errors.mjs';
import { makeBinding, recordApproval } from '../approvals.mjs';
import { loadState, saveState } from '../state.mjs';
import { appendEvent } from '../ledger.mjs';
import { openTerminal, confirmTyped } from '../tty.mjs';
import { printable } from '../printable.mjs';
import { nowIso } from '../clock.mjs';
import { assertHost } from '../hosts.mjs';
import { PUBLIC_GATES } from '../receipt.mjs';

// Only checkpoint-1, which publishes nothing, is approved here. The public gates are approved by the
// passphrase unlock inside `riverwright submit` and `riverwright post` (ADR-0010), so a record an agent
// can write is never what lets something out. The mode is a command-line flag, so it appears in the
// command the human sees in the host's permission prompt; no environment variable changes it.
const MODES = ['host-ask', 'tty'];

export async function run(args, io) {
  const [gate, ...rest] = args;
  if (PUBLIC_GATES.includes(gate)) {
    const via = gate === 'submit-gate' ? 'riverwright submit' : 'riverwright post';
    throw new RiverwrightError('USE_UNLOCK', `${gate} is approved by the passphrase unlock inside "${via}", not by "riverwright approve". Run "${via}" in a terminal.`);
  }
  if (gate !== 'checkpoint-1') throw new RiverwrightError('UNKNOWN_GATE', `unknown gate "${printable(gate)}": "riverwright approve" handles checkpoint-1 only`);
  const { values } = parseArgs({
    args: rest,
    options: { run: { type: 'string' }, sha: { type: 'string' }, 'content-file': { type: 'string' }, mode: { type: 'string' }, host: { type: 'string' } },
  });
  // The run is named on the command line, where the human sees it; no environment variable chooses it.
  const dir = values.run;
  if (!dir) throw new RiverwrightError('NO_RUN', 'pass --run <run directory>');
  const host = assertHost(values.host ?? null);
  const mode = values.mode ?? 'host-ask';
  // An unlock approval is written only by "riverwright submit" or "riverwright post" after the passphrase
  // opened the vault (ADR-0010); it never applies to checkpoint-1.
  if (!MODES.includes(mode)) throw new RiverwrightError('UNKNOWN_MODE', `unknown approval mode "${printable(mode)}" (use host-ask or tty; the unlock mode is recorded only by "riverwright submit" and "riverwright post" after your passphrase)`);
  const now = nowIso(io);
  const content = values['content-file'] !== undefined ? fs.readFileSync(values['content-file'], 'utf8') : undefined;
  const binding = makeBinding({ sha: values.sha, content });
  const state = loadState(dir);
  if (mode === 'tty') {
    const terminal = io.openTerminal ? io.openTerminal() : openTerminal({ platform: io.platform });
    const expected = binding.kind === 'sha' ? binding.value.slice(0, 7) : 'yes';
    const what = binding.kind === 'sha' ? `commit ${binding.value}` : `content ${binding.value}`;
    const how = binding.kind === 'sha' ? 'the first 7 characters of the commit' : 'yes';
    const ok = await confirmTyped({ terminal, question: `Approve ${gate} for ${printable(state.runId)} (${printable(what)})?\nType ${how} to approve: `, expected });
    if (!ok) {
      io.stderr.write('Not approved. Nothing was recorded.\n');
      return 1;
    }
  }
  saveState(dir, recordApproval(state, { gate, sha: values.sha, content, mode, host, now }));
  appendEvent(dir, { type: 'approval', at: now, actor: { type: 'human' }, gate, binding, mode, host });
  io.stdout.write(`Approved ${gate} for ${printable(state.runId)}: ${printable(binding.kind)} ${printable(binding.value)}\n`);
  return 0;
}
