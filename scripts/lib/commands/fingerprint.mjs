import { parseArgs } from 'node:util';
import { collectFingerprint } from '../fingerprint.mjs';
import { writeFileAtomic } from '../fsx.mjs';
import { nowIso } from '../clock.mjs';

export async function run(args, io) {
  const { values } = parseArgs({ args, options: { repo: { type: 'string' }, out: { type: 'string' } } });
  const fp = await collectFingerprint({ repo: values.repo ?? io.cwd, now: nowIso(io) });
  const text = `${JSON.stringify(fp, null, 2)}\n`;
  if (values.out) writeFileAtomic(values.out, text);
  else io.stdout.write(text);
  return 0;
}
