import { UpfError } from './errors.mjs';
import { version } from './version.mjs';

export const HOOK_LIKE = new Set(['hook', 'guard']);

const COMMANDS = {
  version: () => import('./commands/version.mjs'),
  sanitize: () => import('./commands/sanitize.mjs'),
  state: () => import('./commands/state.mjs'),
  approve: () => import('./commands/approve.mjs'),
  guard: () => import('./commands/guard.mjs'),
  hook: () => import('./commands/hook.mjs'),
};

export function usage() {
  return [
    `upf ${version()}: reproduce, fix and propose upstream bug fixes, with your approval at every public step.`,
    '',
    'Usage: upf <command> [options]',
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
    io.stderr.write(`upf: unknown command "${name}". Run "upf help" to see the commands.\n`);
    return 2;
  }
  try {
    const mod = await load();
    return await mod.run(rest, io);
  } catch (err) {
    const message = err instanceof UpfError ? err.message : `unexpected error: ${err?.stack ?? err}`;
    io.stderr.write(`upf ${name}: ${message}\n`);
    return HOOK_LIKE.has(name) ? 2 : 1;
  }
}
