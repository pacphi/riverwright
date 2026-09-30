import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpfError } from '../errors.mjs';
import { HOSTS } from '../hosts.mjs';
import { readAll } from '../io.mjs';
import { upfHome, isInside, realish, runDirForPath } from '../paths.mjs';
import { appendEvent } from '../ledger.mjs';
import { hasActiveRun } from '../state.mjs';
import { classifyCommand, hasUnresolved } from '../hooks/classify.mjs';
import { touchesHome } from '../hooks/scope.mjs';
import { extractCommand, renderDeny, renderAllow } from '../hooks/dialects.mjs';

// The installed launcher's own files: only these may run "upf submit" / "upf post" unblocked.
export const TRUSTED_LAUNCHER = ['../../../bin/upf', '../../../bin/upf.cmd', '../../upf.mjs']
  .map((rel) => realish(fileURLToPath(new URL(rel, import.meta.url))));

function emit(io, rendered) {
  if (rendered.stdout) io.stdout.write(rendered.stdout);
  return rendered.exitCode;
}

export async function run([host], io) {
  if (!HOSTS.includes(host)) throw new UpfError('UNKNOWN_HOST', `unknown host "${host}"`);
  const raw = await readAll(io.stdin);
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = null;
  }
  const { command, cwd } = extractCommand(payload);
  const home = upfHome(io.env);
  const where = path.resolve(io.cwd, cwd ?? '.');
  const readable = typeof command === 'string' && command.trim() !== '';
  const inScope = isInside(where, home) || (readable && touchesHome(command, { home, cwd: where, env: io.env, platform: io.platform }));

  let reason = null;
  if (!readable) {
    if (inScope || hasActiveRun(home)) {
      reason = 'upstream-pr-filer could not read this command, so it is blocked while an upstream-pr-filer run is active or inside its workspace.';
    }
  } else {
    const verdict = classifyCommand(command, { trustedLauncher: TRUSTED_LAUNCHER });
    if (verdict.outward && inScope) {
      reason = `Blocked by upstream-pr-filer (${verdict.rule}): ${verdict.detail}. Public actions go through "upf submit" or "upf post" after your approval.`;
    } else if (verdict.outward && hasUnresolved(command) && hasActiveRun(home)) {
      reason = `Blocked by upstream-pr-filer (unresolvable-with-active-run): ${verdict.detail}, and the command depends on a variable or substitution that could point into the workspace while a run is active. Write the path out in full.`;
    }
  }
  if (!reason) return emit(io, renderAllow(host));

  const dir = runDirForPath(home, where);
  if (dir) {
    try {
      appendEvent(dir, { type: 'guard', at: io.env.UPF_NOW ?? new Date().toISOString(), decision: 'deny', reason, host, command: String(command ?? '') });
    } catch {
      // Recording is best effort; the denial itself must not depend on it.
    }
  }
  return emit(io, renderDeny(host, reason));
}
