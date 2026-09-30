import { RiverwrightError } from './errors.mjs';

// Host ids are part of the story contract (docs/story/paddling-upstream.html data-host values).
export const HOSTS = ['claude-code', 'codex', 'gemini-cli', 'cursor', 'grok-build', 'hermes-agent'];

// A host recorded in state, the ledger or evidence is one of HOSTS, or null when unknown.
export function assertHost(host) {
  if (host === null || host === undefined) return null;
  if (!HOSTS.includes(host)) throw new RiverwrightError('UNKNOWN_HOST', `unknown host "${host}" (use one of: ${HOSTS.join(', ')})`);
  return host;
}
