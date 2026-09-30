import { UpfError } from '../errors.mjs';
import { HOSTS } from '../hosts.mjs';

export function extractCommand(payload) {
  if (!payload || typeof payload !== 'object') return { command: null, cwd: null };
  const candidates = [payload.tool_input?.command, payload.command, payload.tool_input?.cmd, payload.args?.command, payload.input?.command];
  let command = candidates.find((c) => typeof c === 'string' || Array.isArray(c)) ?? null;
  if (Array.isArray(command)) command = command.map(String).join(' ');
  let cwd = null;
  if (typeof payload.cwd === 'string') cwd = payload.cwd;
  else if (Array.isArray(payload.workspace_roots) && typeof payload.workspace_roots[0] === 'string') cwd = payload.workspace_roots[0];
  return { command, cwd };
}

// Every host honours exit code 2 as "deny"; the JSON is belt and braces in each host's own dialect.
export function renderDeny(host, reason) {
  if (!HOSTS.includes(host)) throw new UpfError('UNKNOWN_HOST', `unknown host "${host}"`);
  let body;
  if (host === 'claude-code' || host === 'codex' || host === 'grok-build') {
    body = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  } else if (host === 'gemini-cli') {
    body = { decision: 'deny', reason };
  } else if (host === 'cursor') {
    body = { permission: 'deny', user_message: reason, agent_message: reason };
  } else {
    body = { decision: 'block', reason };
  }
  return { stdout: `${JSON.stringify(body)}\n`, exitCode: 2 };
}

export function renderAllow(host) {
  if (!HOSTS.includes(host)) throw new UpfError('UNKNOWN_HOST', `unknown host "${host}"`);
  return { stdout: '', exitCode: 0 };
}
