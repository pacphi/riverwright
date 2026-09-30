import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFile } from './exec.mjs';

export const LOCKFILES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock',
  'gradle.lockfile', 'packages.lock.json', 'mix.lock', 'pubspec.lock',
];

const PROBES = {
  git: [['git', ['--version']]],
  gh: [['gh', ['--version']]],
  docker: [['docker', ['--version']]],
  python: [['python3', ['--version']], ['python', ['--version']]],
  rustc: [['rustc', ['--version']]],
  cargo: [['cargo', ['--version']]],
  go: [['go', ['version']]],
  java: [['java', ['-version']]],
  ruby: [['ruby', ['--version']]],
};

const RUNTIMES_FOR = {
  'Cargo.lock': ['rustc', 'cargo'],
  'go.sum': ['go'],
  'poetry.lock': ['python'],
  'uv.lock': ['python'],
  'Pipfile.lock': ['python'],
  'Gemfile.lock': ['ruby'],
  'gradle.lockfile': ['java'],
};

async function probe(name, runner) {
  for (const [file, args] of PROBES[name]) {
    const r = await runner(file, args, { timeoutMs: 5000 });
    if (r.code === 0) {
      const line = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (line) return line;
    }
  }
  return null;
}

export async function collectFingerprint({ repo, now, runner = runFile }) {
  const lockfiles = LOCKFILES
    .filter((f) => fs.existsSync(path.join(repo, f)))
    .sort()
    .map((f) => ({ path: f, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, f))).digest('hex') }));
  const wanted = new Set(['git', 'gh', 'docker']);
  for (const l of lockfiles) for (const r of RUNTIMES_FOR[l.path] ?? []) wanted.add(r);
  const tools = {};
  for (const name of [...wanted].sort()) tools[name] = await probe(name, runner);
  return {
    schema: 'upf-fingerprint/1',
    collectedAt: now,
    os: { platform: process.platform, type: os.type(), release: os.release(), arch: os.arch() },
    node: process.versions.node,
    tools,
    lockfiles,
  };
}
