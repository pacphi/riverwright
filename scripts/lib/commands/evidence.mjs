import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { RiverwrightError } from '../errors.mjs';
import { riverwrightHome } from '../paths.mjs';
import { writeFileAtomic } from '../fsx.mjs';
import { buildEvidence, collectRunStates } from '../evidence.mjs';
import { nowIso } from '../clock.mjs';

export async function run(args, io) {
  const [sub, ...rest] = args;
  if (sub !== 'export') throw new RiverwrightError('USAGE', 'usage: riverwright evidence export [--home DIR] [--hosts FILE] [--out FILE]');
  const { values } = parseArgs({ args: rest, options: { home: { type: 'string' }, hosts: { type: 'string' }, out: { type: 'string' } } });
  // A person runs evidence export, so RIVERWRIGHT_HOME is honored here. The pre-push guard and the host
  // hook never read it: they take --home (see workspaceHomeFromArg).
  const home = values.home ?? riverwrightHome(io.env);
  const hosts = values.hosts ? JSON.parse(fs.readFileSync(values.hosts, 'utf8')) : {};
  const { states, skipped } = collectRunStates(home);
  for (const s of skipped) io.stderr.write(`skipped ${s.path}: ${s.reason}\n`);
  const text = `${JSON.stringify(buildEvidence({ states, hosts, now: nowIso(io) }), null, 2)}\n`;
  if (values.out) writeFileAtomic(values.out, text);
  else io.stdout.write(text);
  return 0;
}
