import { Readable, PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../scripts/lib/cli.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UPF = path.join(ROOT, 'scripts', 'riverwright.mjs');

export function fakeTerminal(answer) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.end(`${answer}\n`);
  const written = [];
  output.on('data', (d) => written.push(String(d)));
  return { input, output, written, close() {} };
}

export async function callMain(args, { stdin = '', env = {}, cwd = process.cwd(), terminal } = {}) {
  let stdout = '';
  let stderr = '';
  const io = {
    stdin: Readable.from([stdin]),
    stdout: { write: (s) => { stdout += s; return true; } },
    stderr: { write: (s) => { stderr += s; return true; } },
    env: { ...env },
    cwd,
    platform: process.platform,
    // `terminal` may be one fake terminal or a factory returning a fresh one per prompt.
    openTerminal: typeof terminal === 'function' ? terminal : terminal ? () => terminal : undefined,
  };
  const code = await main(args, io);
  return { code, stdout, stderr };
}

export function runUpf(args, { stdin = '', env = {}, cwd } = {}) {
  const r = spawnSync(process.execPath, [UPF, ...args], {
    input: stdin, env: { ...process.env, ...env }, cwd, encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function tmpDir(prefix = 'upf-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
