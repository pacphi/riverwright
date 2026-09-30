import { version } from '../version.mjs';

export async function run(_args, io) {
  io.stdout.write(`${version()}\n`);
  return 0;
}
