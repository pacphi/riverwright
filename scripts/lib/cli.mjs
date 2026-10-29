import { RiverwrightError } from './errors.mjs';
import { version } from './version.mjs';
import { printable, printableLines } from './printable.mjs';

export const HOOK_LIKE = new Set(['hook', 'guard']);

const COMMANDS = {
  version: () => import('./commands/version.mjs'),
  sanitize: () => import('./commands/sanitize.mjs'),
  state: () => import('./commands/state.mjs'),
  approve: () => import('./commands/approve.mjs'),
  credential: () => import('./commands/credential.mjs'),
  guard: () => import('./commands/guard.mjs'),
  hook: () => import('./commands/hook.mjs'),
  setup: () => import('./commands/setup.mjs'),
  fingerprint: () => import('./commands/fingerprint.mjs'),
  evidence: () => import('./commands/evidence.mjs'),
  ledger: () => import('./commands/ledger.mjs'),
};

export function usage() {
  return [
    `riverwright ${version()}: reproduce, fix and propose upstream bug fixes, with your approval at every public step.`,
    '',
    'Usage: riverwright <command> [options]',
    '',
    'Commands:',
    ...Object.keys(COMMANDS).sort().map((name) => `  ${name}`),
    '',
  ].join('\n');
}

export async function main(argv, io) {
  const [first, ...rest] = argv;
  const name = first === '--version' || first === '-v' ? 'version' : first;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    io.stdout.write(usage());
    return 0;
  }
  const load = COMMANDS[name];
  if (!load) {
    io.stderr.write(`riverwright: unknown command "${printable(name)}". Run "riverwright help" to see the commands.\n`);
    return 2;
  }
  try {
    const mod = await load();
    return await mod.run(rest, io);
  } catch (err) {
    const message = err instanceof RiverwrightError ? err.message : `unexpected error: ${err?.stack ?? err}`;
    // One line per source line; every continuation line is indented, so text embedded in a message (file
    // content, a JSON parse snippet) cannot pose as a separate Riverwright line.
    const [head, ...more] = String(message).split('\n').map((l) => printableLines(l));
    io.stderr.write(`riverwright ${name}: ${head}\n${more.map((l) => `    | ${l}\n`).join('')}`);
    return HOOK_LIKE.has(name) ? 2 : 1;
  }
}
