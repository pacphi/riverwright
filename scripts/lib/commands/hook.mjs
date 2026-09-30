import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RiverwrightError } from '../errors.mjs';
import { HOSTS } from '../hosts.mjs';
import { readAll } from '../io.mjs';
import { workspaceHomeFromArg, isInside, realish, runDirForPath } from '../paths.mjs';
import { appendEvent } from '../ledger.mjs';
import { hasActiveRun } from '../state.mjs';
import { classifyCommand, hasUnresolved } from '../hooks/classify.mjs';
import { touchesHome } from '../hooks/scope.mjs';
import { extractCommand, renderDeny, renderAllow } from '../hooks/dialects.mjs';
import { nowIso } from '../clock.mjs';

// The installed launcher's own files: only these may run "riverwright submit" / "riverwright post" unblocked.
export const TRUSTED_LAUNCHER = ['../../../bin/riverwright', '../../../bin/riverwright.cmd', '../../riverwright.mjs']
  .map((rel) => realish(fileURLToPath(new URL(rel, import.meta.url))));

function emit(io, rendered) {
  if (rendered.stdout) io.stdout.write(rendered.stdout);
  return rendered.exitCode;
}

export async function run([host, ...rest], io) {
  if (!HOSTS.includes(host)) throw new RiverwrightError('UNKNOWN_HOST', `unknown host "${host}"`);
  // The workspace comes from the generated hook command's --home, never from the environment.
  const { values } = parseArgs({ args: rest, options: { home: { type: 'string' } } });
  const home = workspaceHomeFromArg(values.home);
  const raw = await readAll(io.stdin);
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  const { command, cwd } = extractCommand(payload);
  const where = path.resolve(io.cwd, cwd ?? '.');
  const readable = typeof command === 'string' && command.trim() !== '';
  const inScope = isInside(where, home) || (readable && touchesHome(command, { home, cwd: where, env: io.env, platform: io.platform }));

  let reason = null;
  if (!readable) {
    if (inScope || hasActiveRun(home)) {
      reason = 'Riverwright could not read this command, so it is blocked while a Riverwright run is active or inside its workspace.';
    }
  } else {
    const verdict = classifyCommand(command, { trustedLauncher: TRUSTED_LAUNCHER, platform: io.platform });
    if (verdict.outward && inScope) {
      reason = `Blocked by Riverwright (${verdict.rule}): ${verdict.detail}. Public actions go through "riverwright submit" or "riverwright post" after your approval.`;
    } else if (verdict.outward && hasUnresolved(command) && hasActiveRun(home)) {
      reason = `Blocked by Riverwright (unresolvable-with-active-run): ${verdict.detail}, and the command depends on a variable or substitution that could point into the workspace while a run is active. Write the path out in full.`;
    }
  }
  if (!reason) return emit(io, renderAllow(host));

  const dir = runDirForPath(home, where);
  if (dir) {
    try {
      appendEvent(dir, { type: 'guard', at: nowIso(io), decision: 'deny', reason, host, command: String(command ?? '') });
    } catch {
      // Recording is best effort; the denial itself must not depend on it.
    }
  }
  return emit(io, renderDeny(host, reason));
}
