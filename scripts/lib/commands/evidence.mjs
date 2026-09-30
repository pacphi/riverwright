import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { UpfError } from '../errors.mjs';
import { upfHome } from '../paths.mjs';
import { writeFileAtomic } from '../fsx.mjs';
import { buildEvidence, collectRunStates } from '../evidence.mjs';
import { nowIso } from '../clock.mjs';

export async function run(args, io) {
  const [sub, ...rest] = args;
  if (sub !== 'export') throw new UpfError('USAGE', 'usage: riverwright evidence export [--home DIR] [--hosts FILE] [--out FILE]');
  const { values } = parseArgs({ args: rest, options: { home: { type: 'string' }, hosts: { type: 'string' }, out: { type: 'string' } } });
  const home = values.home ?? upfHome(io.env);
  const hosts = values.hosts ? JSON.parse(fs.readFileSync(values.hosts, 'utf8')) : {};
  const { states, skipped } = collectRunStates(home);
  for (const s of skipped) io.stderr.write(`skipped ${s.path}: ${s.reason}\n`);
  const text = `${JSON.stringify(buildEvidence({ states, hosts, now: nowIso(io.env) }), null, 2)}\n`;
  if (values.out) writeFileAtomic(values.out, text);
  else io.stdout.write(text);
  return 0;
}
