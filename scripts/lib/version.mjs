import { readFileSync } from 'node:fs';

let cached;
export function version() {
  cached ??= JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  return cached;
}
