import { UpfError } from '../errors.mjs';
import { HOSTS } from '../hosts.mjs';
import { readAll } from '../io.mjs';
import { upfHome, isInside, realish, runDirForPath } from '../paths.mjs';
import { appendEvent } from '../ledger.mjs';
import { classifyCommand } from '../hooks/classify.mjs';
import { extractCommand, renderDeny, renderAllow } from '../hooks/dialects.mjs';

function mentionsHome(command, home, platform) {
  const fold = (s) => {
    const t = String(s).replace(/\\/g, '/');
    return platform === 'win32' || platform === 'darwin' ? t.toLowerCase() : t;
  };
  const text = fold(command);
  return [home, realish(home)].some((h) => text.includes(fold(h)));
}

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
  const where = cwd ?? io.cwd;
  const inScope = isInside(where, home) || (typeof command === 'string' && mentionsHome(command, home, io.platform));
  if (!inScope) return emit(io, renderAllow(host));

  let reason = null;
  if (typeof command !== 'string' || command.trim() === '') {
    reason = 'upstream-pr-filer could not read this command, so it is blocked inside the upstream-pr-filer workspace.';
  } else {
    const verdict = classifyCommand(command);
    if (verdict.outward) {
      reason = `Blocked by upstream-pr-filer (${verdict.rule}): ${verdict.detail}. Public actions go through "upf submit" or "upf post" after your approval.`;
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
