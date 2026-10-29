// Task 17 (independent security review of Plan 2a): one regression test group per finding. Each test reproduces
// the finding exactly as the review described it. The record of findings and outcomes is in
// docs/research/credential-separation.md ("Review findings for Plan 2a").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { classifyCommand } from '../scripts/lib/hooks/classify.mjs';
import { lex, readingsOf } from '../scripts/lib/hooks/shell.mjs';
import { touchesHome } from '../scripts/lib/hooks/scope.mjs';
import { GENESIS, eventsFile, verifyChain } from '../scripts/lib/events.mjs';
import { appendEvent } from '../scripts/lib/ledger.mjs';
import { createState, hasActiveRun, saveState, stateFile } from '../scripts/lib/state.mjs';
import { RIVERWRIGHT, ROOT, callMain, tmpDir } from './helpers.mjs';

const posixOnly = { skip: process.platform === 'win32' };

const hermeticDir = tmpDir('rw-t17-');
const HERMETIC_ENV = { HOME: hermeticDir, GIT_CONFIG_NOSYSTEM: '1' };
const classify = (c, o = {}) => classifyCommand(c, { cwd: hermeticDir, env: HERMETIC_ENV, ...o });
const hookPayload = (command, cwd) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

// Runs the real hook entry (a child process) for one command; the workspace is a scratch folder.
function realHook(command, { home = tmpDir('riverwright-home-'), cwd = hermeticDir, env = HERMETIC_ENV } = {}) {
  const r = spawnSync(process.execPath, [RIVERWRIGHT, 'hook', 'claude-code', '--home', home], {
    input: hookPayload(command, cwd), env: { PATH: process.env.PATH, ...env }, cwd: hermeticDir, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(r.error?.code, undefined, `${JSON.stringify(command)}: the hook did not return`);
  return r;
}

// C1 (Codex): bash cuts an ANSI-C $'...' segment at a NUL, and execve cuts every argument at its first NUL (zsh keeps
// the NUL in the word, so the program sees only the text before it). The classifier must read the words the program
// receives, under both readings.
test('C1: the lexer cuts an ANSI-C segment at a decoded NUL, as bash does', () => {
  for (const [src, want] of [
    ["$'ab\\0cd'ef", 'abef'], ["$'ab\\x00cd'", 'ab'], ["$'q\\c@r's", 'qs'], ["$'a\\u0000b'", 'a'], ["$'a\\000b'", 'a'], ["$'a\\U00000000b'", 'a'],
  ]) {
    assert.equal(lex(src).commands[0].words[0].value, want, src);
  }
  // The other reading (zsh, or any program receiving the word through execve): the whole word ends at the NUL.
  assert.equal(lex("$'ab\\0cd'ef", { nul: 'word' }).commands[0].words[0].value, 'ab');
});

const C1_CREDENTIAL = [
  "rw $'credential\\0ignored' setup --replace",
  "rw $'credential\\0x' setup",
  "rw $'credential\\x00x' setup",
  "rw $'credential\\c@x' setup",
  "rw $'credential\\u0000x' setup",
  "$'rw\\0x' credential setup",
  "rw $'credential\\0'x setup",
];
const C1_OUTWARD = [
  ["gh pr $'create\\0ignored' --fill", 'gh-pr-create'],
  ["gh pr $'create\\0x' --fill", 'gh-pr-create'],
  ["gh pr $'create\\0'x --fill", 'gh-pr-create'],
  ["gh pr $'cre\\0x'ate --fill", 'gh-pr-create'],
  ["git $'push\\0ignored' --no-verify fork HEAD", 'git-push'],
  ["git $'push\\0x' fork HEAD", 'git-push'],
  ["git $'push\\x00x' fork HEAD", 'git-push'],
];

test('C1: a NUL escape cannot hide credential, gh pr create or git push from their rules', () => {
  for (const c of C1_CREDENTIAL) assert.equal(classify(c).rule, 'riverwright-credential', c);
  for (const [c, rule] of C1_OUTWARD) assert.equal(classify(c).rule, rule, c);
  // A raw NUL in the command text is read with and without it.
  assert.equal(classify('rw cre\0dential setup').rule, 'riverwright-credential');
  assert.equal(classify('gh pr create\0x --fill').rule, 'gh-pr-create');
  // Controls: a NUL elsewhere changes nothing.
  assert.equal(classify("rw $'version\\0x'").outward, false);
  assert.equal(classify("echo $'a\\0b'").outward, false);
});

test('C1: the real hook denies the NUL spellings (exit 2)', () => {
  const home = tmpDir('riverwright-home-');
  const worktree = path.join(home, 'o', 'r', 'worktrees', 'issue-1');
  fs.mkdirSync(worktree, { recursive: true });
  for (const c of ["rw $'credential\\0x' setup", "rw $'credential\\0ignored' setup --replace"]) {
    const r = realHook(c, { home });
    assert.equal(r.status, 2, c);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /riverwright-credential/, c);
  }
  // The publication rules hold inside the workspace.
  for (const c of ["gh pr $'create\\0x' --fill", "git $'push\\0x' fork HEAD"]) {
    const r = realHook(c, { home, cwd: worktree });
    assert.equal(r.status, 2, c);
  }
});

// C2 (Codex): an empty or missing ledger ignored a supplied head anchor, so emptying events.ndjson hid the whole
// consent history from `ledger verify --head H`.
const SAVED_HEAD = `sha256:${'a'.repeat(64)}`;
const noAccount = { testing: { userInfo: () => ({ homedir: tmpDir('rw-account-') }) } };

test('C2: verifyChain fails an empty or missing ledger when a non-genesis head is anchored', () => {
  const missing = tmpDir('rw-ledger-');
  const empty = tmpDir('rw-ledger-');
  fs.writeFileSync(eventsFile(empty), '');
  for (const dir of [missing, empty]) {
    const r = verifyChain(dir, { expectHead: SAVED_HEAD });
    assert.equal(r.ok, false, dir);
    assert.match(r.problems[0].reason, /empty.*anchored head|anchored head.*empty/i);
    // The genesis head is what an empty ledger really has.
    assert.equal(verifyChain(dir, { expectHead: GENESIS }).ok, true);
    assert.equal(verifyChain(dir).ok, true);
  }
});

test('C2: ledger verify --head on an emptied or missing ledger exits 1 and says why', async () => {
  const kept = tmpDir('rw-ledger-');
  for (const type of ['run-created', 'note']) appendEvent(kept, { type, at: 't' });
  const head = verifyChain(kept).head;
  fs.writeFileSync(eventsFile(kept), '');
  const gone = tmpDir('rw-ledger-');
  for (const dir of [kept, gone]) {
    const r = await callMain(['ledger', 'verify', '--run', dir, '--head', dir === kept ? head : SAVED_HEAD], noAccount);
    assert.equal(r.code, 1, dir);
    assert.match(r.stderr, /Ledger check failed.*empty.*anchored head/);
    assert.doesNotMatch(r.stdout, /Ledger intact/);
  }
  const genesis = await callMain(['ledger', 'verify', '--run', gone, '--head', GENESIS], noAccount);
  assert.equal(genesis.code, 0);
});

// C3 (Codex) / F4 (Claude): active-run detection read state.json with an unbounded, blocking readFileSync, so a FIFO
// planted there hung the hook (and a host that allows a command after a hook timeout would let it run).
const runHome = () => {
  const home = tmpDir('riverwright-home-');
  const run = path.join(home, 'o', 'r', 'runs', 'issue-9');
  fs.mkdirSync(run, { recursive: true });
  fs.mkdirSync(path.join(home, 'o', 'r', 'worktrees'), { recursive: true });
  return { home, run };
};
const stoppedState = () => ({ ...createState({ runId: 'o/r#9', kind: 'fixture', now: 't' }), status: 'stopped' });

// Runs a state.mjs call in a child process, so a read that blocks fails the test instead of hanging the suite.
function inChild(code) {
  const url = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'state.mjs')).href;
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import * as m from ${JSON.stringify(url)};\n${code}`], { encoding: 'utf8', timeout: 5000 });
}

test('C3/F4: a directory, oversized or unreadable state.json counts as an active run', () => {
  const dir = runHome();
  fs.mkdirSync(stateFile(dir.run));
  assert.equal(hasActiveRun(dir.home), true, 'directory');
  const big = runHome();
  fs.writeFileSync(stateFile(big.run), JSON.stringify({ ...stoppedState(), pad: 'x'.repeat(2 * 1024 * 1024) }));
  assert.equal(hasActiveRun(big.home), true, 'oversized');
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const locked = runHome();
    saveState(locked.run, stoppedState());
    fs.chmodSync(stateFile(locked.run), 0o000);
    assert.equal(hasActiveRun(locked.home), true, 'unreadable');
    fs.chmodSync(stateFile(locked.run), 0o600);
  }
  const stopped = runHome();
  saveState(stopped.run, stoppedState());
  assert.equal(hasActiveRun(stopped.home), false, 'a stopped run is not active');
});

test('C3/F4: a FIFO at state.json counts as an active run and never blocks', posixOnly, () => {
  const { home, run } = runHome();
  assert.equal(spawnSync('mkfifo', [stateFile(run)]).status, 0);
  const active = inChild(`console.log(m.hasActiveRun(${JSON.stringify(home)}))`);
  assert.equal(active.error?.code, undefined, 'hasActiveRun blocked on the FIFO');
  assert.equal(active.stdout.trim(), 'true');
  const load = inChild(`try { m.loadState(${JSON.stringify(run)}); console.log('loaded'); } catch (e) { console.log(e.code); }`);
  assert.equal(load.error?.code, undefined, 'loadState blocked on the FIFO');
  assert.equal(load.stdout.trim(), 'BAD_STATE');
});

test('C3/F4: the real hook returns promptly with a FIFO at state.json, and denies (an active run)', posixOnly, () => {
  const { home, run } = runHome();
  assert.equal(spawnSync('mkfifo', [stateFile(run)]).status, 0);
  const outside = tmpDir('user-project-');
  const t0 = Date.now();
  const r = realHook('gh pr create -R "$UP" --fill', { home, cwd: outside });
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(r.status, 2);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /unresolvable-with-active-run/);
  // An unreadable payload reaches the same check.
  const u = spawnSync(process.execPath, [RIVERWRIGHT, 'hook', 'claude-code', '--home', home], { input: 'not json', env: { PATH: process.env.PATH, ...HERMETIC_ENV }, cwd: hermeticDir, encoding: 'utf8', timeout: 5000 });
  assert.equal(u.error?.code, undefined, 'the hook blocked on the FIFO');
  assert.equal(u.status, 2);
});

// F1 (Claude): node can shift riverwright's argv. A script read from stdin (node - ... < riverwright.mjs) and a
// launcher loaded by --import, --require, -r or --loader run riverwright with the words after the script operand as
// its arguments, so the subcommand slot is the first operand after "-", not the word after the riverwright word.
const SCRIPTS = path.join(ROOT, 'scripts');
const LAUNCHER_MJS = path.join(SCRIPTS, 'riverwright.mjs');
const F1_DENIED = [
  `cd ${SCRIPTS} && node - credential setup < riverwright.mjs`,
  `cd ${SCRIPTS} && node --input-type=module - credential setup < riverwright.mjs`,
  `cd ${SCRIPTS} && node --input-type module - credential setup < riverwright.mjs`,
  `cd ${SCRIPTS} && node --import=./riverwright.mjs - credential setup < /dev/null`,
  `cd ${SCRIPTS} && bun - credential setup < riverwright.mjs`,
  'node -r ./riverwright.mjs - credential setup',
  'node -r./riverwright.mjs - credential setup',
  'node --require ./riverwright.mjs - credential setup',
  'node --require=./riverwright.mjs - credential setup',
  'node --import ./riverwright.mjs - credential setup',
  'node --loader ./riverwright.mjs - credential setup',
  'node --experimental-loader=./riverwright.mjs - credential setup',
  `node --import=${LAUNCHER_MJS} app.mjs credential setup`,
  'node --import=./riverwright.mjs -e 1 x credential',
  'bun --preload ./riverwright.mjs - credential setup',
  'node /dev/stdin credential setup < riverwright.mjs',
  `node - credential setup < ${LAUNCHER_MJS}`,
  'node < riverwright.mjs - credential setup',
  'deno run - credential setup < riverwright.mjs',
  'cat riverwright.mjs | node - credential setup',
  'node - "$SUB" < riverwright.mjs',
  'NODE_OPTIONS=--import=./riverwright.mjs node - credential setup',
  'env NODE_OPTIONS="--require ./riverwright.mjs" node app.mjs credential',
];
const F1_ALLOWED = [
  'node - version < riverwright.mjs',
  `node --import=${LAUNCHER_MJS} - version < /dev/null`,
  'node - credential setup < other.mjs',
  'node --import ./setup.mjs app.mjs credential',
  'node --input-type=module - < build.mjs',
  'node --test tests/a.test.mjs',
];

test('F1: a riverwright script read from stdin or preloaded by node, bun or deno has its slot after the script operand', () => {
  for (const c of F1_DENIED) assert.equal(classify(c, { cwd: SCRIPTS }).rule, 'riverwright-credential', c);
  for (const c of F1_ALLOWED) assert.equal(classify(c, { cwd: SCRIPTS }).outward, false, c);
});

test('F1: a renamed launcher fed to node through a redirect or a preload is riverwright', posixOnly, () => {
  const dir = tmpDir('rw-links-');
  fs.symlinkSync(LAUNCHER_MJS, path.join(dir, 'tool.mjs'));
  fs.symlinkSync(LAUNCHER_MJS, path.join(dir, 'tool'));
  for (const c of ['node - credential setup < tool', 'node --import=./tool.mjs - credential setup', 'node - credential < ./tool']) {
    assert.equal(classify(c, { cwd: dir }).rule, 'riverwright-credential', c);
  }
});

test('F1: the real hook denies node reading riverwright from stdin or preloading it (exit 2)', () => {
  for (const c of ['node - credential setup < riverwright.mjs', 'node --import=./riverwright.mjs - credential setup < /dev/null']) {
    const r = realHook(c, { cwd: SCRIPTS });
    assert.equal(r.status, 2, c);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /riverwright-credential/, c);
  }
});

// F2 (Claude): a path-shaped program word was resolved against the payload cwd only, so a link to the launcher reached
// after cd, pushd or a subshell cd, through ~, or through a glob ran riverwright credential unseen.
function linkWorld() {
  const base = tmpDir('rw-f2-');
  const links = path.join(base, 'links');
  fs.mkdirSync(links);
  fs.symlinkSync(path.join(ROOT, 'bin', 'riverwright'), path.join(links, 'tool'));
  fs.writeFileSync(path.join(links, 'plain'), '');
  const account = tmpDir('rw-f2-account-');
  fs.symlinkSync(path.join(ROOT, 'bin', 'riverwright'), path.join(account, 'tool'));
  return { base, links, account };
}

test('F2: a launcher link is resolved after cd, pushd and a subshell cd, through ~, and behind a glob', posixOnly, () => {
  const { base, links, account } = linkWorld();
  const opts = { cwd: base, userInfo: () => ({ homedir: account }) };
  const denied = [
    `cd ${links} && ./tool credential setup`,
    'cd links && ./tool credential setup',
    'cd links; ./tool credential setup --replace',
    '(cd links && ./tool credential setup)',
    '( cd links && ./tool credential )',
    'pushd links && ./tool credential setup',
    'pushd links >/dev/null; ./tool credential setup',
    `cd ${base} && links/tool credential setup`,
    'cd links && sudo ./tool credential setup',
    'cd links && env ./tool credential setup',
    'cd links && exec ./tool credential setup',
    'cd links && timeout 9 ./tool credential setup',
    'cd links && sh ./tool credential setup',
    'cd links && printf x | script -q /dev/null ./tool credential setup --replace',
    "sh -c 'cd links && ./tool credential setup'",
    'cd links && cd .. && cd links && ./tool credential',
    '~/tool credential setup',
    '~/tool "$SUB"',
    'cd ~ && ./tool credential setup',
    'cd && ./tool credential setup',
    `${links}/too? credential setup`,
    `${links}/t* credential setup`,
    'links/[t]ool credential setup',
    'cd links && ./too? credential setup',
    `${links}/{tool,x} credential setup`,
    // A cd later in the command still counts for an earlier use in a loop.
    'for i in 1 2; do ./tool credential setup; cd links; done',
  ];
  for (const c of denied) assert.equal(classify(c, opts).rule, 'riverwright-credential', c);
  const allowed = [
    'cd links && ./tool version',
    'cd links && ls ./tool credential',
    'cd links && ./plain credential setup',
    `${links}/pla? credential`.replace(links, base),
    '~/tool version',
  ];
  for (const c of allowed) assert.equal(classify(c, opts).outward, false, c);
});

test('F2: ~ is the account home from the password database, and also HOME', posixOnly, () => {
  const { base, account } = linkWorld();
  const other = tmpDir('rw-f2-home-');
  // The account home (the seam) holds the link; HOME points elsewhere.
  assert.equal(classify('~/tool credential setup', { cwd: base, env: { ...HERMETIC_ENV, HOME: other }, userInfo: () => ({ homedir: account }) }).rule, 'riverwright-credential');
  // HOME holds the link; the account home does not.
  assert.equal(classify('~/tool credential setup', { cwd: base, env: { ...HERMETIC_ENV, HOME: account }, userInfo: () => ({ homedir: other }) }).rule, 'riverwright-credential');
  assert.equal(classify('~/tool credential setup', { cwd: base, env: { ...HERMETIC_ENV, HOME: other }, userInfo: () => ({ homedir: other }) }).outward, false);
});

test('F2: the real hook denies a launcher link reached after cd (exit 2)', posixOnly, () => {
  const { base } = linkWorld();
  for (const c of ['cd links && ./tool credential setup', '(cd links && ./tool credential setup)', 'pushd links && ./tool credential setup', 'cd links && printf x | script -q /dev/null ./tool credential setup --replace']) {
    const r = realHook(c, { cwd: base });
    assert.equal(r.status, 2, c);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /riverwright-credential/, c);
  }
});

// F3 (Claude): an environment or runtime-flag prefix on riverwright submit or post lost the publish exemption but was
// not denied, so the human could type the passphrase into a process whose code the agent chose.
const L = path.join(ROOT, 'bin', 'riverwright');
const LS = path.join(ROOT, 'scripts', 'riverwright.mjs');
const TRUSTED = { trustedLauncher: [L, path.join(ROOT, 'bin', 'riverwright.cmd'), LS] };
const F3_DENIED = [
  `NODE_OPTIONS=--require=/tmp/evil.cjs ${L} submit`,
  `env NODE_OPTIONS=--require=/tmp/evil.cjs ${L} submit`,
  `env -i NODE_OPTIONS=x ${L} post`,
  `PATH=/tmp/evil:/usr/bin ${L} submit`,
  `NODE_PATH=/tmp/m ${L} submit`,
  `NODE_EXTRA_CA_CERTS=/tmp/ca.pem ${L} post`,
  `LD_PRELOAD=/tmp/x.so ${L} submit`,
  `LD_LIBRARY_PATH=/tmp/l ${L} submit`,
  `DYLD_INSERT_LIBRARIES=/tmp/x.dylib ${L} submit`,
  `DYLD_LIBRARY_PATH=/tmp/l ${L} post`,
  `sudo env PATH=/tmp/e ${L} submit`,
  'NODE_OPTIONS=--require=/tmp/evil.cjs rw submit',
  'PATH=/tmp/evil:/usr/bin riverwright post',
  `node --require /tmp/evil.cjs ${LS} submit`,
  `node -r /tmp/evil.cjs ${LS} submit`,
  `node --import=/tmp/evil.mjs ${LS} post`,
  `node --loader /tmp/l.mjs ${LS} submit`,
  `node --experimental-loader=/tmp/l.mjs ${LS} submit`,
  `node --inspect ${LS} submit`,
  `node --inspect-brk=0 ${LS} submit`,
  `export NODE_OPTIONS=--require=/tmp/e.cjs; ${L} submit`,
  `PATH=/tmp/e:$PATH; ${L} submit`,
  `export PATH=/tmp/e; rw post`,
  `NODE_OPTIONS=x ${L} su[b]mit`,
  // R37: a later command is something else on the line.
  `${L} submit; export PATH=/tmp/x`,
];
const F3_ALLOWED = [
  `PATH=/tmp/x ${L} ledger verify --run /r`,
  `NODE_OPTIONS=--max-old-space-size=4096 npm test`,
  `node --inspect app.mjs`,
];

test('F3: environment and runtime-flag prefixes in front of riverwright submit or post are denied everywhere', () => {
  for (const c of F3_DENIED) assert.equal(classify(c, TRUSTED).rule, 'riverwright-publish-env', c);
  for (const c of F3_ALLOWED) assert.equal(classify(c, TRUSTED).outward, false, c);
  // The plain trusted publish stays allowed.
  for (const c of [`${L} submit`, `${L} post`]) assert.equal(classify(c, TRUSTED).riverwrightPublish, true, c);
  // It outranks an ordinary outward verdict earlier in the command, so it holds outside the workspace too.
  assert.equal(classify(`git push; NODE_OPTIONS=x ${L} submit`, TRUSTED).rule, 'riverwright-publish-env');
});

test('F3: the real hook denies a prefixed submit outside the workspace (exit 2) and allows the plain one', () => {
  const outside = tmpDir('user-project-');
  for (const c of [`NODE_OPTIONS=--require=/tmp/evil.cjs ${L} submit`, `node --require /tmp/evil.cjs ${LS} submit`, `PATH=/tmp/evil:/usr/bin ${L} post`]) {
    const r = realHook(c, { cwd: outside });
    assert.equal(r.status, 2, c);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /riverwright-publish-env/, c);
  }
  assert.equal(realHook(`${L} submit`, { cwd: outside }).status, 0);
});

// R37 (F3 redo): the publish-environment check was a denylist (some variable names, node options and setters), so
// further spellings got through: a wrapper (strace, proxychains, script, expect), a shell running the launcher as a
// script, other variables (BASH_ENV, ENV, proxy and TLS settings, HOME, XDG_CONFIG_HOME), and earlier commands that
// change the environment (printf -v, source, alias). It is now an allowlist: submit and post are allowed only as the
// whole command line, with the trusted launcher as the program and nothing in front of it or around it.
const R37_DENIED = [
  `strace ${L} submit`, `strace -f -o /tmp/t ${L} submit`, `ltrace ${L} post`,
  `proxychains ${L} submit`, `proxychains4 -q ${L} post`, `torsocks ${L} submit`, `unbuffer ${L} submit`,
  `script -q /dev/null ${L} submit`, `script -qc "${L} submit" /dev/null`, `expect -c "spawn ${L} submit; interact"`,
  `sudo ${L} submit`, `env ${L} submit`, `nice ${L} submit`, `nohup ${L} submit`, `timeout 60 ${L} submit`,
  `time ${L} submit`, `command ${L} submit`, `exec ${L} submit`, `mywrapper ${L} submit`,
  `bash ${L} submit`, `sh ${L} post`, `zsh -x ${L} submit`, `node ${LS} submit`, `node --no-warnings ${LS} post`,
  `${process.execPath} ${LS} submit`,
  `BASH_ENV=/tmp/e.sh ${L} submit`, `ENV=/tmp/e.sh ${L} submit`, `HTTPS_PROXY=http://127.0.0.1:8080 ${L} submit`,
  `https_proxy=http://127.0.0.1:8080 ${L} post`, `NODE_TLS_REJECT_UNAUTHORIZED=0 ${L} submit`, `SSL_CERT_FILE=/tmp/ca.pem ${L} submit`,
  `HOME=/tmp/h ${L} submit`, `XDG_CONFIG_HOME=/tmp/x ${L} post`, `FOO=1 ${L} submit`,
  'export NODE_OPTIONS=x; rw submit', `export NODE_OPTIONS=x; ${L} submit`, `printf -v PATH /tmp/e; ${L} submit`,
  `read PATH < /tmp/p; ${L} submit`, `source /tmp/x; ${L} submit`, `. /tmp/x; ${L} post`, `eval x; ${L} submit`,
  `alias rw=/tmp/evil; rw submit`, `f() { :; }; ${L} submit`,
  `${L} submit; echo done`, `echo hi && ${L} submit`, `false || ${L} post`, `${L} submit | tee /tmp/log`,
  `${L} submit &`, `(${L} submit)`, `{ ${L} submit; }`, `${L} submit > /tmp/out`, `${L} submit < /tmp/in`,
  `x="${L} submit"; $x`, `rw submit`, `riverwright post`, `$RW submit`, `find . -exec ${L} post o/r#1 \\;`,
];
const R37_ALLOWED_PUBLISH = [`${L} submit`, `${L} post`, `"${L}" submit o/r#1`, `${L} post o/r#1 comment`];

test('R37: riverwright submit and post are allowed only as the whole, plain command line', () => {
  for (const c of R37_DENIED) assert.equal(classify(c, TRUSTED).rule, 'riverwright-publish-env', c);
  for (const c of R37_ALLOWED_PUBLISH) assert.deepEqual(classify(c, TRUSTED), { outward: false, riverwrightPublish: true }, c);
  // Other riverwright commands and ordinary work keep their verdicts.
  for (const c of [`strace ${L} ledger verify --run /r`, `HOME=/tmp/h ${L} status`, 'curl -X POST https://example.com', 'echo rw submit', 'git commit -m "rw submit"']) {
    assert.notEqual(classify(c, TRUSTED).rule, 'riverwright-publish-env', c);
  }
});

test('R37: the real hook denies a wrapped, prefixed or chained submit outside the workspace (exit 2)', () => {
  const outside = tmpDir('user-project-');
  for (const c of [`strace ${L} submit`, `bash ${L} submit`, `HTTPS_PROXY=http://127.0.0.1:8080 ${L} post`, `source /tmp/x; ${L} submit`]) {
    const r = realHook(c, { cwd: outside });
    assert.equal(r.status, 2, c);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /riverwright-publish-env/, c);
  }
});

// R38 (Codex re-review, Important 1): the allowlist missed the F1 shapes. node, bun or deno reading riverwright from
// stdin, or preloading it, run it with the words after the script operand as its arguments, so "submit" or "post"
// there reached the publish entry point. The publish rule now finds that slot the way the credential rule does.
const R38_STDIN_DENIED = [
  'node - submit < riverwright.mjs',
  'node - post < riverwright.mjs',
  `node - submit < ${LS}`,
  'cat riverwright.mjs | node - post',
  'node /dev/stdin submit < riverwright.mjs',
  'node --import=./riverwright.mjs - submit < /dev/null',
  'node --require ./riverwright.mjs - post',
  'node -r./riverwright.mjs - submit',
  `node --import=${LS} app.mjs submit`,
  'NODE_OPTIONS=--import=./riverwright.mjs node - submit',
  'NODE_OPTIONS=--import=./riverwright.mjs node - post < /dev/null',
  'node --require ./attacker.cjs - submit < riverwright.mjs',
  'bun - submit < riverwright.mjs',
  'bun --preload ./riverwright.mjs - post',
  'deno run - post < riverwright.mjs',
  'node - su[b]mit < riverwright.mjs',
];

test('R38: node, bun or deno running riverwright from stdin or a preload with submit or post is denied everywhere', () => {
  const opts = { ...TRUSTED, cwd: SCRIPTS };
  for (const c of R38_STDIN_DENIED) assert.equal(classify(c, opts).rule, 'riverwright-publish-env', c);
  for (const c of ['node - version < riverwright.mjs', 'node - submit < other.mjs', 'node --import ./setup.mjs app.mjs submit', 'node build.mjs submit']) {
    assert.equal(classify(c, opts).outward, false, c);
  }
  // The plain trusted launcher, as the hook passes it, stays allowed.
  for (const c of [`${L} submit`, `${L} post o/r#1`]) assert.deepEqual(classify(c, opts), { outward: false, riverwrightPublish: true }, c);
});

test('R38: the real hook denies submit or post read from stdin or preloaded (exit 2) and allows the plain launcher', async () => {
  const home = tmpDir('riverwright-home-');
  const run = (command) => callMain(['hook', 'claude-code', '--home', home], {
    stdin: hookPayload(command, SCRIPTS), env: { HOME: hermeticDir, USERPROFILE: hermeticDir }, cwd: SCRIPTS, testing: { userInfo: () => ({ homedir: hermeticDir }) },
  });
  for (const c of ['node - submit < riverwright.mjs', 'node --import=./riverwright.mjs - post < /dev/null', 'cat riverwright.mjs | node - post']) {
    const r = await run(c);
    assert.equal(r.code, 2, c);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /riverwright-publish-env/, c);
  }
  assert.equal((await run(`${L} submit`)).code, 0);
});

// Parity (automated finding on the C1 fix): classify.mjs reads a NUL-bearing command several ways, but the scope check
// (scope.mjs touchesHome) lexed it once (bash's reading), so the two could disagree about where the command reaches.
// Both now take their readings from one helper, and a command is in scope when any reading reaches the workspace.
test('parity: one readingsOf helper gives the NUL and Windows readings', () => {
  assert.deepEqual(readingsOf('git push', 'linux'), [['git push', {}]]);
  assert.deepEqual(readingsOf("rw $'a\\0b'", 'linux'), [["rw $'a\\0b'", {}], ["rw $'a\\0b'", { nul: 'word' }]]);
  assert.deepEqual(readingsOf('a\0b', 'linux'), [['a\0b', {}], ['a\0b', { nul: 'word' }], ['ab', {}]]);
  assert.deepEqual(readingsOf('a\\b', 'win32'), [['a\\b', {}], ['a/b', {}]]);
});

test('parity: the scope check counts a command that reaches the workspace under any NUL reading', () => {
  const home = tmpDir('rw-scope-home-');
  const cwd = tmpDir('rw-scope-cwd-');
  // bash: $'\0' is cut to nothing, so the word is "$RIVERWRIGHT_HOMEx" (another variable). zsh and execve: the word ends
  // at the NUL, so it is "$RIVERWRIGHT_HOME", the workspace.
  const cmd = "git -C $RIVERWRIGHT_HOME$'\\0'x push origin HEAD";
  assert.equal(lex(cmd).commands[0].words[2].value, '$RIVERWRIGHT_HOMEx');
  assert.equal(lex(cmd, { nul: 'word' }).commands[0].words[2].value, '$RIVERWRIGHT_HOME');
  assert.equal(touchesHome(cmd, { home, cwd, env: { HOME: cwd } }), true);
  assert.equal(touchesHome('git -C $RIVERWRIGHT_HOMEx push origin HEAD', { home, cwd, env: { HOME: cwd } }), false);
});

test('parity: the real hook denies a push that reaches the workspace only under the zsh NUL reading', async () => {
  const home = tmpDir('rw-scope-home-');
  const outside = tmpDir('user-project-');
  const command = "git -C $RIVERWRIGHT_HOME$'\\0'x push origin HEAD";
  const r = await callMain(['hook', 'claude-code', '--home', home], {
    stdin: hookPayload(command, outside), env: { HOME: outside, USERPROFILE: outside }, cwd: outside, testing: { userInfo: () => ({ homedir: outside }) },
  });
  assert.equal(r.code, 2, r.stdout);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /git-push/);
});

// Test hygiene (Task 17): the hook resolves "~" in the account home given by the in-process seam, not the real one.
test('test hygiene: the hook takes the account home for ~ from the userInfo seam', posixOnly, async () => {
  const { base, account } = linkWorld();
  const home = tmpDir('riverwright-home-');
  const r = await callMain(['hook', 'claude-code', '--home', home], { stdin: hookPayload('~/tool credential setup', base), env: { HOME: tmpDir('rw-other-') }, cwd: base, testing: { userInfo: () => ({ homedir: account }) } });
  assert.equal(r.code, 2);
});
