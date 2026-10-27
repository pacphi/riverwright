import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RiverwrightError } from './errors.mjs';

// The directory that holds scripts/: the repository in a checkout, the plugin/ folder in an install.
const OWN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// A checkout has package.json. The generated plugin/ folder never carries it (ADR-0011), so there the version
// comes from .claude-plugin/plugin.json, which tools/generate-adapters.mjs writes from package.json.
export function readVersion(root) {
  for (const rel of ['package.json', path.join('.claude-plugin', 'plugin.json')]) {
    const file = path.join(root, rel);
    if (!existsSync(file)) continue;
    const v = JSON.parse(readFileSync(file, 'utf8')).version;
    if (typeof v === 'string' && v) return v;
  }
  throw new RiverwrightError('NO_VERSION', `no version in ${path.join(root, 'package.json')} or ${path.join(root, '.claude-plugin', 'plugin.json')}`);
}

let cached;
export function version() {
  cached ??= readVersion(OWN_ROOT);
  return cached;
}
