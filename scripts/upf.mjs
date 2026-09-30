#!/usr/bin/env node
// upstream-pr-filer command line. Node built-ins only (spec §3.2).
const HOOK_LIKE = new Set(['hook', 'guard']);
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  process.stderr.write(`upstream-pr-filer needs Node.js 24 or newer (found ${process.versions.node}): https://nodejs.org\n`);
  process.exit(HOOK_LIKE.has(process.argv[2]) ? 2 : 1);
}
const { main } = await import('./lib/cli.mjs');
process.exitCode = await main(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
  platform: process.platform,
});
