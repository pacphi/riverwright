import { parseArgs } from 'node:util';
import { readAll } from '../io.mjs';
import { sanitize, quoteAsData } from '../sanitize.mjs';

export async function run(args, io) {
  const { values } = parseArgs({
    args,
    options: {
      quote: { type: 'boolean', default: false },
      source: { type: 'string', default: 'stdin' },
      url: { type: 'string' },
      'fetched-at': { type: 'string' },
    },
  });
  const text = await readAll(io.stdin);
  if (values.quote) {
    io.stdout.write(quoteAsData(text, { source: values.source, url: values.url, fetchedAt: values['fetched-at'] ?? new Date().toISOString() }));
  } else {
    io.stdout.write(`${JSON.stringify(sanitize(text), null, 2)}\n`);
  }
  return 0;
}
