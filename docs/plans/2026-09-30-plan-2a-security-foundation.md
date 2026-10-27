# Riverwright Plan 2a: the security foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a public action impossible unless a human does something the agent cannot: a hash-chained ledger, a sealed credential vault, signed receipts issued by a passphrase unlock that is the approval itself, a pre-push guard that trusts only those receipts, the guard installed into a clone, an audit of the credential routes Riverwright cannot close, and an optional hardware push key.

**Architecture:** New small modules under `scripts/lib/` (`events`, `vault`, `receipt`, `gate`, `ambient`, `clone-guard`, `pushkey`) take their inputs as arguments so tests never depend on the machine. `ledger.mjs` keeps Plan 1's call shape and delegates to the new chained writer, so existing callers and tests keep working. The pre-push guard stops reading `state.json` for consent and reads a verified receipt from the ledger instead. `riverwright approve` narrows to the one gate that publishes nothing; the three public gates are approved by the unlock inside `submit` and `post`, whose commands arrive in Plan 2b.

**Tech Stack:** Node.js 24+ built-ins only (`node:crypto` argon2, scrypt, AES-256-GCM and Ed25519; `node:fs`; `node:tty`; `node:child_process`; `node:test`); git; the existing GitHub Actions matrix on ubuntu-latest, macos-latest and windows-latest.

**Spec:** [`docs/specs/core-single-issue-pipeline.md`](../specs/core-single-issue-pipeline.md) (§6, §7.1, §7.2, §7.5), [`docs/specs/thread-record-and-audit.md`](../specs/thread-record-and-audit.md) (§9, §13), [ADR-0010](../adr/0010-sealed-credential-released-by-human-unlock.md), and the evidence in [`docs/research/credential-separation.md`](../research/credential-separation.md).

**How this plan was checked:** every code block below was written and run in a scratch copy of the repository, one task at a time, before it was put here: 564 tests, 557 passing and 7 Windows-only skips, 0 failing, on macOS with Node 26.4.0. The expected failures in each "watch it fail" step are the ones observed. What could not be run there is listed under "Unverified" at the end.

## Global Constraints

- Node.js 24 or newer. **No npm dependencies.** Only Node built-ins. There is never an `npm install` step for users.
- `git` and `gh` run through `execFile` with argument arrays, never a shell string.
- `node:path` everywhere; existing line endings are preserved on every write; writes are atomic (temp file + rename) and keep the file mode.
- The pre-push guard and the host hook take the workspace home from `--home` or the account record, never from `RIVERWRIGHT_HOME` or `HOME`. Commands a person runs (`credential`, `ledger verify`) honor `RIVERWRIGHT_HOME`.
- The passphrase and the token are read only from the terminal: never from an argument, the environment or standard input. They are never printed, never written to the ledger, and never left in an error message.
- Key derivation: Argon2id at 46 MiB (47104 KiB) or more with t=1, p=1, or scrypt N=2^17, r=8, p=1 with an explicit `maxmem`. Cipher AES-256-GCM. Signatures Ed25519. The vault passphrase must be at least 12 characters.
- Retry limits are constants in code: 3 attempts within 120 seconds, backoff 2 s then 5 s. A receipt is valid for 10 minutes and may be dated at most 60 seconds ahead.
- Test seams live in `io.testing`, supplied only by the in-process test helper. `scripts/riverwright.mjs` never sets it, and no environment variable reaches a seam.
- Text from upstream is data. Nothing in this plan executes, obeys or posts it.
- The agent never adds `Signed-off-by`, and nothing here adds `Co-Authored-By`. No task in this plan pushes, opens a pull request, comments or forks.
- Tests run with `node --test` and must pass on ubuntu-latest, macos-latest and windows-latest. Tests that need POSIX file modes or `/bin/sh` are marked `skip: process.platform === 'win32'`.
- Documents live in the layout of `AGENTS.md`. Never create `docs/superpowers/`. `pnpm lint:md` must pass.
- Commit steps run only when the owner has asked for commits in the session. Ask before any push.

## Review Focus

Inputs the specs imply that are easy to miss. Each has a test in the task named.

1. **A forged approval never lets a push through.** An approval written into `state.json`, an `approved` event signed by another key, a receipt for another run, another SHA or another branch, an expired or already used receipt, and a ledger rewritten before the receipt, and a push that replaces the remote tip without a receipt lease equal to that tip, must all be refused by the guard — Tasks 3, 8 and 14.
2. **A failed unlock releases nothing and leaves no receipt.** A wrong passphrase three times, Ctrl-C at the prompt, a missing vault, a missing terminal and a terminal that cannot hide typing must each stop before any credential or receipt exists — Tasks 4, 6 and 7.
3. **The payload cannot change between what was shown and what is published.** A SHA that changes between the summary and the unlock, or while a retry waits, must stop the action — Task 7.
4. **A rewritten or truncated ledger is caught only against something the agent cannot write.** The chain alone accepts a shorter valid chain and an edited last line; the signed receipt and an anchored head or seq are what expose them — Tasks 1, 3 and 10.
5. **No secret leaks.** The token and the passphrase must not appear in any output, ledger line, vault text, ambient finding or thrown error — Tasks 2, 5, 6 and 7.

## File Structure

New files are marked `+`, changed files `~`.

```text
scripts/lib/
  events.mjs             +  riverwright-event/1 ledger: appendChained, readEvents, verifyChain
  ledger.mjs             ~  Plan 1's appendEvent/readLedger, delegating to events.mjs; ledgerDirFor
  vault.mjs              +  sealed credential vault: sealVault, openVault, readVault, writeVault, fingerprint
  receipt.mjs            +  signed receipts (with an optional lease): buildReceipt, signReceipt, appendReceipt, findValidReceipt, markConsumed
  tty.mjs                ~  openTerminal gets raw-mode input; readSecret added
  ambient.mjs            +  auditAmbient: credential routes Riverwright cannot close
  gate.mjs               +  runPublicAction: show, unlock, sign, act, bounded retry, consume
  approvals.mjs          ~  'unlock' mode; recordApproval accepts an already-checked binding
  guard.mjs              ~  clearer messages after the change to receipts
  clone-guard.mjs        +  installGuard, checkGuard (Lock 1 into a clone)
  pushkey.mjs            +  optional FIDO2 hardware push key
  exec.mjs               ~  launcherHookCommand requires home
  cli.mjs                ~  registers ledger and credential
  commands/
    ledger.mjs           +  ledger verify
    credential.mjs       +  credential setup | status | remove | push-key
    guard.mjs            ~  consent comes from a verified receipt, not state.json
    approve.mjs          ~  checkpoint-1 only
  hooks/classify.mjs     ~  deny an agent running "riverwright credential"
tests/
  events.test.mjs  ledger-cli.test.mjs  vault.test.mjs  receipt.test.mjs  receipt-helpers.mjs
  tty-secret.test.mjs  ambient.test.mjs  credential-cli.test.mjs  gate.test.mjs  guard-receipt.test.mjs
  hook-credential.test.mjs  clone-guard.test.mjs  pushkey.test.mjs  guard-lease.test.mjs     (all new)
  helpers.mjs guard.test.mjs seams.test.mjs workspace-home.test.mjs state-cli.test.mjs exec.test.mjs  (changed)
```

The ledger moves from one file per run (`runs/issue-<n>/ledger.jsonl`) to one chain per repository (`<owner>/<repo>/ledger/events.ndjson`), as thread-record spec §3 says. A run directory outside that layout keeps its own `events.ndjson`, which is what the existing tests use.

---

### Task 1: The hash-chained ledger and `riverwright ledger verify`

Spec: thread-record §9 (event shape) and §13 (Plan 2's first task). This task changes the writer under Plan 1's callers without changing their call shape.

**Files:**

- Create: `scripts/lib/events.mjs`, `scripts/lib/commands/ledger.mjs`
- Modify: `scripts/lib/ledger.mjs` (rewritten), `scripts/lib/cli.mjs` (register `ledger`)
- Test: `tests/events.test.mjs`, `tests/ledger-cli.test.mjs`

**Interfaces:**

- Consumes: `RiverwrightError`, `readTextIfExists` (`fsx.mjs`), `version()`.
- Produces (`events.mjs`):
  - `EVENT_SCHEMA = 'riverwright-event/1'`, `GENESIS = 'sha256:' + 64 zeros`, `ACTOR_TYPES = ['human','agent','watcher','import']`.
  - `eventsFile(dir): string`; `lineHash(line): 'sha256:<hex>'`.
  - `appendChained(dir, build): { seq, prev, line, hash, record }` where `build({ prev, seq })` returns `{ event, at, actor?, data?, evidence?, run?, thread?, recordedAt? }` and runs under the ledger lock.
  - `readEvents(dir): object[]`; `verifyChain(dir, { expectHead?, expectSeq? }): { ok, count, seq, head, problems: [{ line, reason }] }`.
- Produces (`ledger.mjs`): `EVENT_TYPES`, `ledgerDirFor(runDir)`, `ledgerFile(runDir)`, `appendEvent(runDir, { type, at, actor?, run?, thread?, evidence?, ...data })`, `readLedger(runDir)` (the flat `{ type, at, ...data }` view Plan 1's tests read).
- Produces (command): `riverwright ledger verify --run DIR [--head sha256:HEX] [--seq N]`; exit 0 intact, 1 broken.

- [ ] **Step 1: Write the failing tests**

`tests/events.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EVENT_SCHEMA, GENESIS, appendChained, eventsFile, lineHash, readEvents, verifyChain } from '../scripts/lib/events.mjs';
import { tmpDir } from './helpers.mjs';

const add = (dir, event = 'note', data = {}) => appendChained(dir, () => ({ event, at: '2026-10-02T14:03:11Z', actor: { type: 'human' }, data }));

test('events carry the riverwright-event/1 shape with seq, actor and prev', () => {
  const dir = tmpDir();
  const first = add(dir, 'opened', { n: 1 });
  const second = add(dir, 'note', { n: 2 });
  const [a, b] = readEvents(dir);
  assert.equal(a.schema, EVENT_SCHEMA);
  assert.deepEqual([a.seq, b.seq], [1, 2]);
  assert.equal(a.prev, GENESIS);
  assert.equal(b.prev, first.hash);
  assert.equal(second.prev, first.hash);
  assert.equal(a.actor.type, 'human');
  assert.match(a.actor.riverwright, /^\d+\.\d+\.\d+/);
  assert.deepEqual(a.data, { n: 1 });
  assert.deepEqual(a.evidence, []);
  assert.equal(a.recordedAt, a.at);
});

test('the builder sees the previous hash and the next seq under the lock', () => {
  const dir = tmpDir();
  add(dir);
  let seen;
  appendChained(dir, ({ prev, seq }) => {
    seen = { prev, seq };
    return { event: 'approved', at: 't', actor: { type: 'human' }, data: {} };
  });
  const lines = fs.readFileSync(eventsFile(dir), 'utf8').trim().split('\n');
  assert.equal(seen.seq, 2);
  assert.equal(seen.prev, lineHash(lines[0]));
});

test('an unknown actor type, a missing event or a missing time is refused and writes nothing', () => {
  const dir = tmpDir();
  assert.throws(() => appendChained(dir, () => ({ event: 'note', at: 't', actor: { type: 'robot' } })), /actor type/);
  assert.throws(() => appendChained(dir, () => ({ at: 't', actor: { type: 'human' } })), /event name/);
  assert.throws(() => appendChained(dir, () => ({ event: 'note', actor: { type: 'human' } })), /"at"/);
  assert.equal(fs.existsSync(eventsFile(dir)), false);
  assert.equal(fs.existsSync(path.join(dir, 'events.lock')), false);
});

test('verifyChain accepts an intact chain and reports its head', () => {
  const dir = tmpDir();
  add(dir); add(dir); const last = add(dir);
  const v = verifyChain(dir);
  assert.deepEqual([v.ok, v.count, v.seq, v.head], [true, 3, 3, last.hash]);
  assert.deepEqual(verifyChain(tmpDir()), { ok: true, count: 0, seq: 0, head: GENESIS, problems: [] });
});

const lines = (dir) => fs.readFileSync(eventsFile(dir), 'utf8').trim().split('\n');
const write = (dir, ls) => fs.writeFileSync(eventsFile(dir), `${ls.join('\n')}\n`);

test('editing, removing or reordering an earlier event breaks the chain at the next line', () => {
  const build = () => { const d = tmpDir(); add(d, 'a', { v: 1 }); add(d, 'b', { v: 2 }); add(d, 'c', { v: 3 }); add(d, 'd', { v: 4 }); return d; };
  let d = build();
  let ls = lines(d);
  ls[1] = ls[1].replace('"v":2', '"v":9');
  write(d, ls);
  let v = verifyChain(d);
  assert.equal(v.ok, false);
  assert.equal(v.problems[0].line, 3);
  d = build(); ls = lines(d); ls.splice(1, 1); write(d, ls);
  v = verifyChain(d);
  assert.equal(v.ok, false);
  assert.equal(v.problems[0].line, 2);
  d = build(); ls = lines(d); [ls[1], ls[2]] = [ls[2], ls[1]]; write(d, ls);
  assert.equal(verifyChain(d).ok, false);
});

test('a truncated tail or a rewritten last line is caught only against an anchored head or seq', () => {
  const d = tmpDir();
  add(d); add(d); const third = add(d);
  const ls = lines(d);
  write(d, ls.slice(0, 2));
  assert.equal(verifyChain(d).ok, true, 'a shorter chain is still self-consistent');
  const cut = verifyChain(d, { expectSeq: 3 });
  assert.equal(cut.ok, false);
  assert.match(cut.problems.at(-1).reason, /truncated/);
  write(d, [...ls.slice(0, 2), ls[2].replace('"data":{}', '"data":{"x":1}')]);
  assert.equal(verifyChain(d).ok, true, 'the last line has no successor to expose an edit');
  const edited = verifyChain(d, { expectHead: third.hash });
  assert.equal(edited.ok, false);
  assert.match(edited.problems.at(-1).reason, /anchored head/);
});

test('a write that was cut short refuses further appends and is reported', () => {
  const d = tmpDir();
  add(d);
  fs.appendFileSync(eventsFile(d), '{"schema":"riverwright-event/1","seq":2');
  assert.throws(() => add(d), /newline|corrupt/);
  const v = verifyChain(d);
  assert.equal(v.ok, false);
  assert.match(v.problems.map((p) => p.reason).join(' '), /newline|valid JSON/);
});

test('a stale lock file left by a crashed writer is cleared', () => {
  const d = tmpDir();
  fs.mkdirSync(d, { recursive: true });
  const lock = path.join(d, 'events.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  add(d);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(readEvents(d).length, 1);
});

test('two writers that race are serialized: seq stays contiguous and the chain verifies', async () => {
  const d = tmpDir();
  const { spawn } = await import('node:child_process');
  const script = `import { appendChained } from ${JSON.stringify(new URL('../scripts/lib/events.mjs', import.meta.url).href)};
for (let i = 0; i < 25; i++) appendChained(${JSON.stringify(d)}, () => ({ event: 'note', at: 't', actor: { type: 'agent' }, data: { i } }));`;
  const run = () => new Promise((resolve) => { const c = spawn(process.execPath, ['--input-type=module', '-e', script]); c.on('exit', resolve); });
  const codes = await Promise.all([run(), run(), run()]);
  assert.deepEqual(codes, [0, 0, 0]);
  const v = verifyChain(d);
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.equal(v.count, 75);
});
```

`tests/ledger-cli.test.mjs` (Task 10 adds three receipt tests to this file):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, ledgerDirFor, ledgerFile, readLedger } from '../scripts/lib/ledger.mjs';
import { readEvents, verifyChain } from '../scripts/lib/events.mjs';
import { callMain, tmpDir } from './helpers.mjs';

test('a run directory under runs/ shares the repository ledger; any other directory keeps its own', () => {
  const home = tmpDir();
  const run = path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509');
  assert.equal(ledgerDirFor(run), path.join(home, 'ruvnet', 'ruflo', 'ledger'));
  const other = tmpDir();
  assert.equal(ledgerDirFor(other), other);
  assert.equal(ledgerFile(run), path.join(home, 'ruvnet', 'ruflo', 'ledger', 'events.ndjson'));
});

test('appendEvent writes riverwright-event/1 lines and readLedger returns the flat view', () => {
  const dir = tmpDir();
  appendEvent(dir, { type: 'approval', at: '2026-10-02T14:03:11Z', actor: { type: 'human' }, gate: 'checkpoint-1', mode: 'tty' });
  const [e] = readEvents(dir);
  assert.equal(e.event, 'approval');
  assert.equal(e.actor.type, 'human');
  assert.deepEqual(e.data, { gate: 'checkpoint-1', mode: 'tty' });
  assert.deepEqual(readLedger(dir), [{ type: 'approval', at: '2026-10-02T14:03:11Z', gate: 'checkpoint-1', mode: 'tty' }]);
});

test('two runs of one repository share a single chain', () => {
  const home = tmpDir();
  appendEvent(path.join(home, 'o', 'r', 'runs', 'issue-1'), { type: 'note', at: 't' });
  appendEvent(path.join(home, 'o', 'r', 'runs', 'issue-2'), { type: 'note', at: 't' });
  assert.deepEqual(readEvents(path.join(home, 'o', 'r', 'ledger')).map((e) => e.seq), [1, 2]);
});

test('riverwright ledger verify passes an intact ledger and names the first break', async () => {
  const dir = tmpDir();
  for (const type of ['run-created', 'station-begin', 'note']) appendEvent(dir, { type, at: 't' });
  const ok = await callMain(['ledger', 'verify', '--run', dir]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /3 events/);
  const ls = fs.readFileSync(ledgerFile(dir), 'utf8').trim().split('\n');
  ls[0] = ls[0].replace('"event":"run-created"', '"event":"note"');
  fs.writeFileSync(ledgerFile(dir), `${ls.join('\n')}\n`);
  const bad = await callMain(['ledger', 'verify', '--run', dir]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /line 2/);
});

test('ledger verify accepts an anchored head and seq, and fails when they no longer match', async () => {
  const dir = tmpDir();
  appendEvent(dir, { type: 'note', at: 't' });
  appendEvent(dir, { type: 'note', at: 't' });
  const { head } = verifyChain(ledgerDirFor(dir));
  assert.equal((await callMain(['ledger', 'verify', '--run', dir, '--head', head, '--seq', '2'])).code, 0);
  const cut = await callMain(['ledger', 'verify', '--run', dir, '--seq', '3']);
  assert.equal(cut.code, 1);
  assert.match(cut.stderr, /truncated/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/events.test.mjs tests/ledger-cli.test.mjs`

Expected: both files FAIL to load with `ERR_MODULE_NOT_FOUND` for `scripts/lib/events.mjs`. The other 452 tests still pass.

- [ ] **Step 3: Write the implementation**

`scripts/lib/events.mjs`:

```js
// The hash-chained event ledger, riverwright-event/1 (thread-record spec §9).
// One JSON object per line. `prev` is the SHA-256 of the previous line's exact text, so editing, removing
// or reordering an earlier line breaks the chain. A chain in a file the agent can write can still be
// rewritten or truncated: an anchored head (a signed receipt, or the registry's ledgerHead) is what
// exposes that, and verifyChain takes it as an argument.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';
import { readTextIfExists } from './fsx.mjs';
import { version } from './version.mjs';

export const EVENT_SCHEMA = 'riverwright-event/1';
export const GENESIS = `sha256:${'0'.repeat(64)}`;
export const ACTOR_TYPES = ['human', 'agent', 'watcher', 'import'];
export const eventsFile = (dir) => path.join(dir, 'events.ndjson');

export const lineHash = (line) => `sha256:${crypto.createHash('sha256').update(line, 'utf8').digest('hex')}`;

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10_000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A lock file created with O_EXCL serializes writers. A lock older than LOCK_STALE_MS belongs to a writer
// that died and is removed. Two waiters removing the same stale lock at once could both proceed; the chain
// then shows a repeated seq, which verifyChain reports, so the failure is visible rather than silent.
function acquire(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'events.lock');
  const giveUp = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      return () => fs.rmSync(lock, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
    } catch { /* another writer released it first */ }
    if (Date.now() > giveUp) throw new RiverwrightError('LEDGER_BUSY', `another Riverwright process is writing ${eventsFile(dir)}; try again`);
    sleep(15);
  }
}

function tail(dir) {
  const text = readTextIfExists(eventsFile(dir));
  if (text === null || text === '') return { prev: GENESIS, seq: 0 };
  if (!text.endsWith('\n')) throw new RiverwrightError('LEDGER_CORRUPT', `${eventsFile(dir)} does not end with a newline (a write was cut short); run "riverwright ledger verify"`);
  const last = text.slice(0, -1).split('\n').at(-1);
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch {
    throw new RiverwrightError('LEDGER_CORRUPT', `the last line of ${eventsFile(dir)} is not valid JSON; run "riverwright ledger verify"`);
  }
  return { prev: lineHash(last), seq: parsed.seq };
}

// `build({ prev, seq })` runs under the lock and returns { event, at, actor, data?, evidence?, run?, thread?,
// recordedAt? }, so a signed receipt can name the exact head and seq its own event will take.
export function appendChained(dir, build) {
  const release = acquire(dir);
  try {
    const { prev, seq: last } = tail(dir);
    const seq = last + 1;
    const f = build({ prev, seq });
    if (typeof f?.event !== 'string' || !f.event) throw new RiverwrightError('BAD_EVENT', 'a ledger event needs an event name');
    if (typeof f.at !== 'string' || !f.at) throw new RiverwrightError('BAD_EVENT', 'a ledger event needs "at"');
    const actor = { type: 'agent', ...(f.actor ?? {}) };
    if (!ACTOR_TYPES.includes(actor.type)) throw new RiverwrightError('BAD_EVENT', `unknown actor type "${actor.type}" (use ${ACTOR_TYPES.join(', ')})`);
    const record = {
      schema: EVENT_SCHEMA,
      seq,
      at: f.at,
      recordedAt: f.recordedAt ?? f.at,
      thread: f.thread ?? null,
      run: f.run ?? null,
      event: f.event,
      actor: { ...actor, riverwright: version() },
      data: f.data ?? {},
      evidence: f.evidence ?? [],
      prev,
    };
    const line = JSON.stringify(record);
    fs.appendFileSync(eventsFile(dir), `${line}\n`, 'utf8');
    return { seq, prev, line, hash: lineHash(line), record };
  } finally {
    release();
  }
}

export function readEvents(dir) {
  const text = readTextIfExists(eventsFile(dir));
  if (text === null) return [];
  const events = [];
  text.split('\n').forEach((line, i) => {
    if (line === '') return;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new RiverwrightError('LEDGER_CORRUPT', `ledger line ${i + 1} is not valid JSON`);
    }
  });
  return events;
}

// { ok, count, seq, head, problems: [{ line, reason }] }. expectHead and expectSeq come from somewhere the
// agent cannot write (a signed receipt, the registry); without them a truncated tail or an edited last
// line looks like a valid, shorter chain.
export function verifyChain(dir, { expectHead = null, expectSeq = null } = {}) {
  const text = readTextIfExists(eventsFile(dir));
  const problems = [];
  if (text === null || text === '') {
    if (expectSeq) problems.push({ line: 0, reason: `the ledger is empty but seq ${expectSeq} was anchored (truncated)` });
    return { ok: problems.length === 0, count: 0, seq: 0, head: GENESIS, problems };
  }
  const ls = text.split('\n');
  if (ls.at(-1) === '') ls.pop();
  else problems.push({ line: ls.length, reason: 'the last line does not end with a newline (a write was cut short)' });
  let prev = GENESIS;
  let seq = 0;
  ls.forEach((line, i) => {
    const n = i + 1;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      problems.push({ line: n, reason: 'not valid JSON' });
      prev = lineHash(line);
      return;
    }
    if (e.schema !== EVENT_SCHEMA) problems.push({ line: n, reason: `schema is not ${EVENT_SCHEMA}` });
    if (e.seq !== n) problems.push({ line: n, reason: `seq is ${e.seq}, expected ${n}` });
    if (e.prev !== prev) problems.push({ line: n, reason: `prev does not match the hash of line ${n - 1} (an earlier line was edited, removed or reordered)` });
    seq = typeof e.seq === 'number' ? e.seq : seq;
    prev = lineHash(line);
  });
  if (expectSeq && seq < expectSeq) problems.push({ line: ls.length, reason: `the ledger ends at seq ${seq} but seq ${expectSeq} was anchored (truncated)` });
  if (expectHead && prev !== expectHead) problems.push({ line: ls.length, reason: 'the head differs from the anchored head (the last line was changed, or the history was rewritten)' });
  return { ok: problems.length === 0, count: ls.length, seq, head: prev, problems };
}
```

`scripts/lib/ledger.mjs` (replace the whole file):

```js
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';
import { appendChained, eventsFile, readEvents } from './events.mjs';

// Plan 1's event names stay valid. `approved` is written by an unlock and carries a signed receipt;
// `receipt-consumed` records that a receipt's nonce was used; `unlock-refused` records a failed unlock.
export const EVENT_TYPES = [
  'run-created', 'station-begin', 'station-complete', 'approval', 'stop', 'reopen', 'guard', 'note',
  'approved', 'receipt-consumed', 'unlock-refused',
];

// The ledger is per repository (thread-record spec §3): <home>/<owner>/<repo>/ledger. A run directory
// <home>/<owner>/<repo>/runs/issue-<n> maps to it. Any other directory (a test, a scratch run) holds its
// own ledger.
export function ledgerDirFor(runDir) {
  const parent = path.dirname(runDir);
  return path.basename(parent) === 'runs' ? path.join(path.dirname(parent), 'ledger') : runDir;
}

export const ledgerFile = (runDir) => eventsFile(ledgerDirFor(runDir));

// Plan 1's call shape: { type, at, actor?, run?, thread?, evidence?, ...rest }. `rest` becomes `data`.
export function appendEvent(runDir, event) {
  if (!EVENT_TYPES.includes(event?.type)) throw new RiverwrightError('BAD_EVENT', `unknown ledger event "${event?.type}"`);
  if (!event.at) throw new RiverwrightError('BAD_EVENT', 'a ledger event needs "at"');
  const { type, at, actor, run, thread, evidence, ...data } = event;
  return appendChained(ledgerDirFor(runDir), () => ({ event: type, at, actor, run, thread, evidence, data }));
}

// The flat view Plan 1's tests and callers read: { type, at, ...data }. readEvents gives the full records.
export function readLedger(runDir) {
  return readEvents(ledgerDirFor(runDir)).map((e) => ({ type: e.event, at: e.at, ...e.data }));
}
```

`scripts/lib/commands/ledger.mjs` (Task 10 extends it):

```js
import { parseArgs } from 'node:util';
import { RiverwrightError } from '../errors.mjs';
import { ledgerDirFor } from '../ledger.mjs';
import { verifyChain } from '../events.mjs';

const USAGE = 'usage: riverwright ledger verify --run <run directory> [--head sha256:<hex>] [--seq <n>]';

export async function run(args, io) {
  const [sub, ...rest] = args;
  if (sub !== 'verify') throw new RiverwrightError('USAGE', USAGE);
  const { values } = parseArgs({ args: rest, options: { run: { type: 'string' }, head: { type: 'string' }, seq: { type: 'string' } } });
  if (!values.run) throw new RiverwrightError('NO_RUN', 'pass --run <run directory>');
  if (values.head !== undefined && !/^sha256:[0-9a-f]{64}$/.test(values.head)) throw new RiverwrightError('USAGE', '--head must look like sha256:<64 hex digits>');
  if (values.seq !== undefined && !/^[1-9]\d*$/.test(values.seq)) throw new RiverwrightError('USAGE', '--seq must be a positive whole number');
  const result = verifyChain(ledgerDirFor(values.run), { expectHead: values.head ?? null, expectSeq: values.seq === undefined ? null : Number(values.seq) });
  if (!result.ok) {
    const [first] = result.problems;
    io.stderr.write(`Ledger check failed at line ${first.line}: ${first.reason}\n`);
    if (result.problems.length > 1) io.stderr.write(`(${result.problems.length - 1} more problem${result.problems.length === 2 ? '' : 's'} follow)\n`);
    return 1;
  }
  io.stdout.write(`Ledger intact: ${result.count} events, seq ${result.seq}, head ${result.head}\n`);
  return 0;
}
```

In `scripts/lib/cli.mjs`, add this line to `COMMANDS` after `evidence`:

```js
  ledger: () => import('./commands/ledger.mjs'),
```

- [ ] **Step 4: Run the new tests and see them pass**

Run: `node --test tests/events.test.mjs tests/ledger-cli.test.mjs`

Expected: PASS, 9 + 5 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS with nothing failing. Plan 1's tests that read the ledger (`clock`, `guard`, `hook`, `seams`, `state-cli`, `workspace-home`) still pass, because `readLedger` returns the flat view and a run directory outside `runs/` keeps its own chain.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/events.mjs scripts/lib/ledger.mjs scripts/lib/cli.mjs scripts/lib/commands/ledger.mjs tests/events.test.mjs tests/ledger-cli.test.mjs
git commit -m "feat(ledger): hash-chained riverwright-event/1 events and ledger verify"
```

### Task 2: The sealed credential vault

Spec §7.5 "Vault". One file holds the GitHub token and an Ed25519 signing key, encrypted under a key derived from the passphrase. The header (kdf, salt, public key) is authenticated, so it cannot be downgraded.

**Files:**

- Create: `scripts/lib/vault.mjs`
- Test: `tests/vault.test.mjs`

**Interfaces:**

- Consumes: `RiverwrightError`, `readTextIfExists`, `writeFileAtomic`.
- Produces:
  - `VAULT_SCHEMA = 'riverwright-vault/1'`, `MIN_PASSPHRASE = 12`, `vaultFile(home): <home>/vault/vault.json`.
  - `defaultKdf({ hasArgon2? }): { name: 'argon2id', memory, passes, parallelism } | { name: 'scrypt', N, r, p }`.
  - `deriveKey(passphrase, kdf, salt): Buffer(32)` (refuses out-of-range parameters).
  - `sealVault({ token, passphrase, kdf?, now? }): vault`; `openVault(vault, passphrase): { token, privateKey: KeyObject, publicKey: pem }` (throws `BAD_PASSPHRASE`).
  - `fingerprint(publicKeyPem): 'sha256:<hex>'`; `validateVault(v)`; `readVault(home)` (throws `NO_VAULT` with the setup hint); `writeVault(home, vault, { replace? })` (mode 0600 in a 0700 directory; refuses to replace silently).

- [ ] **Step 1: Write the failing test**

`tests/vault.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VAULT_SCHEMA, defaultKdf, fingerprint, openVault, readVault, sealVault, vaultFile, writeVault } from '../scripts/lib/vault.mjs';
import { tmpDir } from './helpers.mjs';

const TOKEN = 'ghp_exampleTokenValue0123456789abcdefghij';
const PASS = 'correct horse battery staple';
// Tests use small parameters so they run fast; the command line never passes a kdf, so real vaults use defaultKdf().
const FAST = { name: 'argon2id', memory: 8, passes: 1, parallelism: 1 };
const FAST_SCRYPT = { name: 'scrypt', N: 1024, r: 8, p: 1 };

test('a sealed vault opens with the passphrase and returns the token and a working signing key', () => {
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST });
  assert.equal(vault.schema, VAULT_SCHEMA);
  const opened = openVault(vault, PASS);
  assert.equal(opened.token, TOKEN);
  const sig = crypto.sign(null, Buffer.from('m'), opened.privateKey);
  assert.equal(crypto.verify(null, Buffer.from('m'), vault.publicKey, sig), true);
});

test('the scrypt fallback seals and opens the same way', () => {
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST_SCRYPT });
  assert.equal(vault.kdf.name, 'scrypt');
  assert.equal(openVault(vault, PASS).token, TOKEN);
});

test('the token never appears in the vault text, in clear or as base64', () => {
  const text = JSON.stringify(sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST }));
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes(Buffer.from(TOKEN).toString('base64')), false);
  assert.equal(text.includes('PRIVATE KEY'), false);
});

test('a wrong passphrase releases nothing and the error does not say why', () => {
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST });
  assert.throws(() => openVault(vault, 'not the passphrase'), (e) => e.code === 'BAD_PASSPHRASE' && !/token/i.test(e.message));
});

test('changing any header field breaks decryption, so the parameters cannot be downgraded', () => {
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST });
  const weaker = { ...vault, kdf: { ...vault.kdf, passes: 2 } };
  assert.throws(() => openVault(weaker, PASS), /BAD_PASSPHRASE|did not open/);
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => openVault({ ...vault, publicKey: other }, PASS), /did not open/);
});

test('a short passphrase and a token with spaces or control characters are refused', () => {
  assert.throws(() => sealVault({ token: TOKEN, passphrase: 'short', kdf: FAST }), /at least 12/);
  for (const bad of ['', 'has space', 'tab\there', 'line\nbreak', 'x'.repeat(5000), 'abc']) {
    assert.throws(() => sealVault({ token: bad, passphrase: PASS, kdf: FAST }), /token/i, JSON.stringify(bad.slice(0, 12)));
  }
});

test('the default parameters meet the OWASP minimum, with a scrypt fallback when argon2 is missing', () => {
  const a = defaultKdf({ hasArgon2: true });
  assert.equal(a.name, 'argon2id');
  assert.ok(a.memory >= 47104 && a.passes >= 1 && a.parallelism >= 1);
  const s = defaultKdf({ hasArgon2: false });
  assert.deepEqual([s.name, s.N >= 2 ** 17, s.r, s.p], ['scrypt', true, 8, 1]);
});

test('hostile parameters in a vault file are refused before any key is derived', () => {
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST });
  for (const kdf of [{ ...vault.kdf, memory: 2 ** 30 }, { ...vault.kdf, passes: 1000 }, { ...vault.kdf, name: 'md5' }]) {
    assert.throws(() => openVault({ ...vault, kdf }, PASS), /kdf|parameters/i);
  }
});

test('writeVault stores one file under the workspace home, readable only by the owner, and refuses to replace it silently', () => {
  const home = tmpDir();
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST });
  writeVault(home, vault);
  assert.equal(vaultFile(home), path.join(home, 'vault', 'vault.json'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(vaultFile(home)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(vaultFile(home))).mode & 0o777, 0o700);
  }
  assert.deepEqual(readVault(home), vault);
  assert.throws(() => writeVault(home, vault), /already exists/);
  writeVault(home, vault, { replace: true });
});

test('readVault reports a missing or malformed vault plainly', () => {
  const home = tmpDir();
  assert.throws(() => readVault(home), (e) => e.code === 'NO_VAULT' && /credential setup/.test(e.message));
  fs.mkdirSync(path.dirname(vaultFile(home)), { recursive: true });
  fs.writeFileSync(vaultFile(home), '{"schema":"other/1"}');
  assert.throws(() => readVault(home), /not a Riverwright vault/);
});

test('the fingerprint is a stable sha256 of the public key', () => {
  const vault = sealVault({ token: TOKEN, passphrase: PASS, kdf: FAST });
  assert.match(fingerprint(vault.publicKey), /^sha256:[0-9a-f]{64}$/);
  assert.equal(fingerprint(vault.publicKey), fingerprint(vault.publicKey));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/vault.test.mjs`

Expected: FAIL to load, `ERR_MODULE_NOT_FOUND` for `scripts/lib/vault.mjs`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/vault.mjs`:

```js
// The sealed credential vault (ADR-0010). One file holds the GitHub token and an Ed25519 signing key,
// encrypted under a key derived from the human's passphrase. The agent can read the file but cannot open it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';
import { readTextIfExists, writeFileAtomic } from './fsx.mjs';

export const VAULT_SCHEMA = 'riverwright-vault/1';
export const MIN_PASSPHRASE = 12;
export const vaultFile = (home) => path.join(home, 'vault', 'vault.json');

// OWASP Password Storage cheat sheet: Argon2id at 46 MiB or more with t=1, p=1; scrypt N=2^17, r=8, p=1.
// We use more than the floor because an unlock is rare and human-paced.
export function defaultKdf({ hasArgon2 = typeof crypto.argon2Sync === 'function' } = {}) {
  return hasArgon2
    ? { name: 'argon2id', memory: 65536, passes: 3, parallelism: 1 }
    : { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 };
}

const LIMITS = { argon2id: { memory: [8, 2 ** 19], passes: [1, 10], parallelism: [1, 4] }, scrypt: { N: [2 ** 10, 2 ** 20], r: [1, 16], p: [1, 4] } };

function checkKdf(kdf) {
  const limits = LIMITS[kdf?.name];
  if (!limits) throw new RiverwrightError('BAD_VAULT', `unsupported kdf "${kdf?.name}" in the vault`);
  for (const [key, [lo, hi]] of Object.entries(limits)) {
    if (!Number.isInteger(kdf[key]) || kdf[key] < lo || kdf[key] > hi) throw new RiverwrightError('BAD_VAULT', `kdf parameters out of range in the vault (${key})`);
  }
}

export function deriveKey(passphrase, kdf, salt) {
  checkKdf(kdf);
  const message = Buffer.from(String(passphrase).normalize('NFKC'), 'utf8');
  if (kdf.name === 'argon2id') {
    return crypto.argon2Sync('argon2id', { message, nonce: salt, parallelism: kdf.parallelism, tagLength: 32, memory: kdf.memory, passes: kdf.passes });
  }
  return crypto.scryptSync(message, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

// The header is authenticated: changing the kdf, the salt or the public key makes decryption fail.
const aadOf = (v) => Buffer.from(JSON.stringify({ schema: v.schema, kdf: v.kdf, publicKey: v.publicKey }), 'utf8');

export function fingerprint(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `sha256:${crypto.createHash('sha256').update(der).digest('hex')}`;
}

export function sealVault({ token, passphrase, kdf = defaultKdf(), now = null }) {
  if (typeof passphrase !== 'string' || [...passphrase.normalize('NFKC')].length < MIN_PASSPHRASE) {
    throw new RiverwrightError('WEAK_PASSPHRASE', `the passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  if (typeof token !== 'string' || !/^[!-~]{8,4096}$/.test(token)) {
    throw new RiverwrightError('BAD_TOKEN', 'the token must be 8 to 4096 printable characters with no spaces');
  }
  const salt = crypto.randomBytes(16);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const header = {
    schema: VAULT_SCHEMA,
    kdf: { ...kdf, salt: salt.toString('base64') },
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  };
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, header.kdf, salt), nonce);
  cipher.setAAD(aadOf(header));
  const plain = JSON.stringify({ token, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { ...header, cipher: 'aes-256-gcm', nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64'), createdAt: now };
}

export function openVault(vault, passphrase) {
  validateVault(vault);
  const salt = Buffer.from(vault.kdf.salt, 'base64');
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, vault.kdf, salt), Buffer.from(vault.nonce, 'base64'));
    decipher.setAAD(aadOf(vault));
    decipher.setAuthTag(Buffer.from(vault.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(vault.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    if (e instanceof RiverwrightError) throw e;
    throw new RiverwrightError('BAD_PASSPHRASE', 'the passphrase did not open the vault');
  }
  const { token, privateKey } = JSON.parse(plain);
  return { token, privateKey: crypto.createPrivateKey(privateKey), publicKey: vault.publicKey };
}

export function validateVault(v) {
  if (v?.schema !== VAULT_SCHEMA) throw new RiverwrightError('BAD_VAULT', 'this is not a Riverwright vault');
  for (const key of ['nonce', 'ciphertext', 'tag', 'publicKey']) {
    if (typeof v[key] !== 'string' || !v[key]) throw new RiverwrightError('BAD_VAULT', `the vault is missing "${key}"`);
  }
  if (v.cipher !== 'aes-256-gcm') throw new RiverwrightError('BAD_VAULT', 'unsupported cipher in the vault');
  if (typeof v.kdf?.salt !== 'string') throw new RiverwrightError('BAD_VAULT', 'the vault is missing its salt');
  checkKdf(v.kdf);
  return v;
}

export function readVault(home) {
  const text = readTextIfExists(vaultFile(home));
  if (text === null) throw new RiverwrightError('NO_VAULT', `no sealed credential yet: run "riverwright credential setup" in a terminal (looked in ${vaultFile(home)})`);
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    throw new RiverwrightError('BAD_VAULT', `${vaultFile(home)} is not valid JSON`);
  }
  return validateVault(v);
}

export function writeVault(home, vault, { replace = false } = {}) {
  validateVault(vault);
  const file = vaultFile(home);
  if (!replace && fs.existsSync(file)) throw new RiverwrightError('VAULT_EXISTS', `a sealed credential already exists at ${file}; pass --replace to overwrite it`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, `${JSON.stringify(vault, null, 2)}\n`, { mode: 0o600 });
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test tests/vault.test.mjs`

Expected: PASS, 11 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS. `tests/runtime-dependencies.test.mjs` confirms the new module imports only Node built-ins.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/vault.mjs tests/vault.test.mjs
git commit -m "feat(security): sealed credential vault with authenticated header"
```

### Task 3: Signed receipts

Spec §7.5 steps 4 and 6, and thread-record §13. A receipt commits to the ledger head and seq of its own event, so rewriting earlier history breaks it: the human's signature anchors the chain.

**Files:**

- Create: `scripts/lib/receipt.mjs`, `tests/receipt-helpers.mjs`
- Test: `tests/receipt.test.mjs`

**Interfaces:**

- Consumes: `normalizeBranch` (`approvals.mjs`), `appendChained` and `readEvents` (`events.mjs`).
- Produces (`receipt.mjs`):
  - `RECEIPT_SCHEMA = 'riverwright-receipt/1'`, `PUBLIC_GATES = ['submit-gate','post-issue','post-comment']`, `RECEIPT_TTL_MS = 600000`.
  - `buildReceipt({ gate, run, binding, branch?, ledgerHead, seq, at, nonce? }): receipt` (validates every field; only `submit-gate` names a branch).
  - `receiptBytes(receipt): Buffer` (a fixed-order JSON array, so no field can slide into its neighbour).
  - `signReceipt(receipt, privateKey): receipt & { signature }`; `verifyReceipt(receipt, publicKeyPem): boolean` (never throws).
  - `appendReceipt({ ledgerDir, privateKey, gate, run, binding, branch?, at, nonce? }): { seq, record }` writes the `approved` event under the ledger lock.
  - `markConsumed({ ledgerDir, nonce, outcome: 'succeeded'|'failed', at })`.
  - `findValidReceipt({ ledgerDir, publicKey, gate, run, nowMs, binding? }): { ok: true, receipt, seq } | { ok: false, reason }`.
  - `verifyReceipts({ ledgerDir, publicKey }): [{ line, reason }]`.
- Produces (`tests/receipt-helpers.mjs`): `TOKEN`, `PASSPHRASE`, `NOW`, `NOW_MS`, `FAST_KDF`, `makeTestVault(home)`, `issueReceipt({ runDir, keys, ... })`, `runDirIn(home)`; Task 8 adds `armRun`.

- [ ] **Step 1: Write the failing tests**

`tests/receipt-helpers.mjs`:

```js
import path from 'node:path';
import { openVault, sealVault, writeVault } from '../scripts/lib/vault.mjs';
import { appendReceipt } from '../scripts/lib/receipt.mjs';
import { ledgerDirFor } from '../scripts/lib/ledger.mjs';

export const TOKEN = 'ghp_exampleTokenValue0123456789abcdefghij';
export const PASSPHRASE = 'correct horse battery staple';
export const NOW = '2026-10-02T14:03:11.000Z';
export const NOW_MS = Date.parse(NOW);
export const FAST_KDF = { name: 'argon2id', memory: 8, passes: 1, parallelism: 1 };

// Writes a real vault (small KDF parameters, so tests are fast) under `home` and returns its keys.
export function makeTestVault(home, { token = TOKEN, passphrase = PASSPHRASE } = {}) {
  const vault = sealVault({ token, passphrase, kdf: FAST_KDF });
  writeVault(home, vault, { replace: true });
  const { privateKey, publicKey } = openVault(vault, passphrase);
  return { privateKey, publicKey, passphrase, token };
}

// Appends a signed `approved` event for a public gate, the way an unlock does, to the run's ledger.
export function issueReceipt({ runDir, keys, gate = 'submit-gate', run = 'ruvnet/ruflo#3509', sha = 'a'.repeat(40), content, branch = 'riverwright/3509-codex', at = NOW }) {
  const binding = content === undefined ? { kind: 'sha', value: sha } : { kind: 'content', value: content };
  return appendReceipt({ ledgerDir: ledgerDirFor(runDir), privateKey: keys.privateKey, gate, run, binding, branch: gate === 'submit-gate' ? branch : null, at });
}

export const runDirIn = (home, owner = 'ruvnet', repo = 'ruflo', n = 3509) => path.join(home, owner, repo, 'runs', `issue-${n}`);
```

`tests/receipt.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { RECEIPT_SCHEMA, RECEIPT_TTL_MS, buildReceipt, findValidReceipt, receiptBytes, signReceipt, verifyReceipt, verifyReceipts, markConsumed } from '../scripts/lib/receipt.mjs';
import { appendChained, eventsFile, readEvents } from '../scripts/lib/events.mjs';
import { NOW, NOW_MS, issueReceipt, makeTestVault, runDirIn } from './receipt-helpers.mjs';
import { ledgerDirFor } from '../scripts/lib/ledger.mjs';
import { tmpDir } from './helpers.mjs';

const RUN = 'ruvnet/ruflo#3509';
const A = 'a'.repeat(40);
const base = { gate: 'submit-gate', run: RUN, binding: { kind: 'sha', value: A }, branch: 'riverwright/3509-codex', ledgerHead: `sha256:${'1'.repeat(64)}`, seq: 4, at: NOW, nonce: 'n'.repeat(32) };
const keysOf = () => { const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519'); return { privateKey, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }; };

test('a signed receipt verifies, and changing any signed field breaks it', () => {
  const k = keysOf();
  const r = signReceipt(buildReceipt(base), k.privateKey);
  assert.equal(r.schema, RECEIPT_SCHEMA);
  assert.equal(verifyReceipt(r, k.publicKey), true);
  const edits = { gate: 'post-comment', run: 'ruvnet/ruflo#1', binding: { kind: 'sha', value: 'b'.repeat(40) }, branch: 'riverwright/1-x', ledgerHead: `sha256:${'2'.repeat(64)}`, seq: 5, at: '2026-10-02T14:03:12.000Z', nonce: 'm'.repeat(32) };
  for (const [key, value] of Object.entries(edits)) assert.equal(verifyReceipt({ ...r, [key]: value }, k.publicKey), false, key);
  assert.equal(verifyReceipt(r, keysOf().publicKey), false);
  assert.equal(verifyReceipt({ ...r, signature: 'not base64 !!' }, k.publicKey), false);
  assert.equal(verifyReceipt(null, k.publicKey), false);
});

test('the signed bytes are a fixed-order JSON array, so no field can slide into its neighbour', () => {
  const r = buildReceipt(base);
  const [tag, body] = receiptBytes(r).toString('utf8').split('\n');
  assert.equal(tag, RECEIPT_SCHEMA);
  assert.deepEqual(JSON.parse(body), [r.gate, r.run, r.binding.kind, r.binding.value, r.branch, r.ledgerHead, r.seq, r.at, r.nonce]);
  const tricky = buildReceipt({ ...base, run: 'a","b' });
  assert.equal(JSON.parse(receiptBytes(tricky).toString('utf8').split('\n')[1])[1], 'a","b');
});

test('only the three public gates get receipts, with a full SHA or a content hash', () => {
  assert.throws(() => buildReceipt({ ...base, gate: 'checkpoint-1' }), /public gate/);
  assert.throws(() => buildReceipt({ ...base, binding: { kind: 'sha', value: 'abc' } }), /binding/);
  assert.throws(() => buildReceipt({ ...base, binding: { kind: 'content', value: 'hello' } }), /binding/);
  assert.throws(() => buildReceipt({ ...base, gate: 'post-comment', branch: 'riverwright/1-x' }), /branch/);
  assert.throws(() => buildReceipt({ ...base, gate: 'submit-gate', branch: null }), /branch/);
  assert.doesNotThrow(() => buildReceipt({ ...base, gate: 'post-comment', branch: null, binding: { kind: 'content', value: `sha256:${'c'.repeat(64)}` } }));
});

function setup() {
  const home = tmpDir();
  const runDir = runDirIn(home);
  const keys = makeTestVault(home);
  return { home, runDir, keys, ledgerDir: ledgerDirFor(runDir) };
}
const find = (s, extra = {}) => findValidReceipt({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey, gate: 'submit-gate', run: RUN, nowMs: NOW_MS + 1000, ...extra });

test('a fresh, signed, unconsumed receipt for the gate and run is found, with its binding and branch', () => {
  const s = setup();
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  const found = find(s);
  assert.equal(found.ok, true, found.reason);
  assert.equal(found.receipt.binding.value, A);
  assert.equal(found.receipt.branch, 'riverwright/3509-codex');
});

test('the receipt commits to the ledger head and seq of its own event', () => {
  const s = setup();
  appendChained(s.ledgerDir, () => ({ event: 'note', at: NOW, actor: { type: 'agent' } }));
  const written = issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.equal(written.record.data.receipt.seq, 2);
  assert.equal(written.record.data.receipt.ledgerHead, written.record.prev);
});

test('nothing is found without a receipt, for another gate or run, or from another key', () => {
  const s = setup();
  assert.match(find(s).reason, /no receipt/);
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.match(find(s, { gate: 'post-comment' }).reason, /no receipt/);
  assert.match(find(s, { run: 'ruvnet/ruflo#1' }).reason, /no receipt/);
  assert.match(find(s, { publicKey: keysOf().publicKey }).reason, /signature/);
});

test('a consumed receipt cannot be used again', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  markConsumed({ ledgerDir: s.ledgerDir, nonce: w.record.data.receipt.nonce, outcome: 'succeeded', at: NOW });
  assert.match(find(s).reason, /already used/);
});

test('an old receipt, a receipt from the future, and an unreadable clock are all refused', () => {
  const s = setup();
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.match(find(s, { nowMs: NOW_MS + RECEIPT_TTL_MS + 1 }).reason, /expired/);
  assert.match(find(s, { nowMs: NOW_MS - 120_000 }).reason, /future/);
  assert.match(find(s, { nowMs: Number.NaN }).reason, /clock/);
  assert.equal(find(s, { nowMs: NOW_MS + RECEIPT_TTL_MS }).ok, true);
});

test('the requested binding must match the receipt when one is given', () => {
  const s = setup();
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  assert.equal(find(s, { binding: { kind: 'sha', value: A } }).ok, true);
  assert.match(find(s, { binding: { kind: 'sha', value: 'b'.repeat(40) } }).reason, /binding/);
});

test('rewriting the history before a receipt is detected, because the receipt signed the head it saw', () => {
  const s = setup();
  appendChained(s.ledgerDir, () => ({ event: 'note', at: NOW, actor: { type: 'agent' }, data: { n: 1 } }));
  issueReceipt({ runDir: s.runDir, keys: s.keys });
  const file = eventsFile(s.ledgerDir);
  const ls = fs.readFileSync(file, 'utf8').trim().split('\n');
  const first = JSON.parse(ls[0]);
  first.data = { n: 999 };
  ls[0] = JSON.stringify(first);
  const second = JSON.parse(ls[1]);
  second.prev = `sha256:${crypto.createHash('sha256').update(ls[0]).digest('hex')}`;
  ls[1] = JSON.stringify(second);
  fs.writeFileSync(file, `${ls.join('\n')}\n`);
  assert.match(find(s).reason, /ledger head/);
  assert.ok(verifyReceipts({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey }).length > 0);
});

test('an approved event with a forged receipt is rejected', () => {
  const s = setup();
  const attacker = keysOf();
  appendChained(s.ledgerDir, ({ prev, seq }) => ({ event: 'approved', at: NOW, actor: { type: 'human' }, data: { receipt: signReceipt(buildReceipt({ ...base, ledgerHead: prev, seq, nonce: 'f'.repeat(32) }), attacker.privateKey) } }));
  assert.match(find(s).reason, /signature/);
});

test('verifyReceipts reports a repeated nonce and a receipt that names the wrong seq', () => {
  const s = setup();
  const w = issueReceipt({ runDir: s.runDir, keys: s.keys });
  appendChained(s.ledgerDir, () => ({ event: 'approved', at: NOW, actor: { type: 'human' }, data: { receipt: w.record.data.receipt } }));
  const problems = verifyReceipts({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey });
  assert.match(problems.map((p) => p.reason).join(' | '), /nonce.*more than once/);
  assert.match(problems.map((p) => p.reason).join(' | '), /seq/);
  assert.equal(readEvents(s.ledgerDir).length, 2);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/receipt.test.mjs`

Expected: FAIL to load, `ERR_MODULE_NOT_FOUND` for `scripts/lib/receipt.mjs`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/receipt.mjs`:

```js
// Signed receipts for public actions (ADR-0010). An unlock signs one and appends it to the ledger as an
// `approved` event. The receipt commits to the ledger head and seq its own event takes, so rewriting any
// earlier history breaks it: the human's signature anchors the chain.
import crypto from 'node:crypto';
import { RiverwrightError } from './errors.mjs';
import { normalizeBranch } from './approvals.mjs';
import { appendChained, readEvents } from './events.mjs';

export const RECEIPT_SCHEMA = 'riverwright-receipt/1';
export const PUBLIC_GATES = ['submit-gate', 'post-issue', 'post-comment'];
export const RECEIPT_TTL_MS = 10 * 60 * 1000;
const FUTURE_SKEW_MS = 60_000;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTENT = /^sha256:[0-9a-f]{64}$/;
const HEAD = /^sha256:[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9]{16,64}$/;

const bad = (msg) => new RiverwrightError('BAD_RECEIPT', msg);

export function buildReceipt({ gate, run, binding, branch = null, ledgerHead, seq, at, nonce = crypto.randomBytes(16).toString('hex') }) {
  if (!PUBLIC_GATES.includes(gate)) throw bad(`"${gate}" is not a public gate (${PUBLIC_GATES.join(', ')})`);
  if (typeof run !== 'string' || !run) throw bad('a receipt names its run');
  const okBinding = (binding?.kind === 'sha' && SHA.test(binding.value)) || (binding?.kind === 'content' && CONTENT.test(binding.value));
  if (!okBinding) throw bad('binding must be a full commit SHA or a sha256: content hash');
  if (gate === 'submit-gate') branch = normalizeBranch(branch);
  else if (branch !== null) throw bad('only the submit gate names a branch');
  if (!HEAD.test(ledgerHead ?? '')) throw bad('ledgerHead must be sha256:<64 hex>');
  if (!Number.isInteger(seq) || seq < 1) throw bad('seq must be a positive integer');
  if (typeof at !== 'string' || !at) throw bad('a receipt needs "at"');
  if (!NONCE.test(nonce)) throw bad('nonce must be 16 to 64 letters or digits');
  return { schema: RECEIPT_SCHEMA, gate, run, binding: { kind: binding.kind, value: binding.value }, branch, ledgerHead, seq, at, nonce };
}

// A JSON array in fixed order, so no field can be moved into its neighbour without changing the bytes.
export function receiptBytes(r) {
  return Buffer.from(`${RECEIPT_SCHEMA}\n${JSON.stringify([r.gate, r.run, r.binding.kind, r.binding.value, r.branch, r.ledgerHead, r.seq, r.at, r.nonce])}`, 'utf8');
}

export function signReceipt(receipt, privateKey) {
  return { ...receipt, signature: crypto.sign(null, receiptBytes(receipt), privateKey).toString('base64') };
}

export function verifyReceipt(receipt, publicKey) {
  try {
    if (receipt?.schema !== RECEIPT_SCHEMA || typeof receipt.signature !== 'string') return false;
    const { signature, ...rest } = receipt;
    const rebuilt = buildReceipt(rest);
    return crypto.verify(null, receiptBytes(rebuilt), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

// Signs and appends in one step, under the ledger lock, so the receipt names the exact head and seq it gets.
export function appendReceipt({ ledgerDir, privateKey, gate, run, binding, branch = null, at, nonce }) {
  return appendChained(ledgerDir, ({ prev, seq }) => ({
    event: 'approved',
    at,
    run,
    actor: { type: 'human' },
    data: { receipt: signReceipt(buildReceipt({ gate, run, binding, branch, ledgerHead: prev, seq, at, nonce }), privateKey) },
  }));
}

export function markConsumed({ ledgerDir, nonce, outcome, at }) {
  if (!['succeeded', 'failed'].includes(outcome)) throw bad('outcome must be succeeded or failed');
  return appendChained(ledgerDir, () => ({ event: 'receipt-consumed', at, actor: { type: 'human' }, data: { nonce, outcome } }));
}

function checkOne(event, publicKey) {
  const r = event.data.receipt;
  if (!verifyReceipt(r, publicKey)) return 'the receipt signature does not verify against the vault key';
  if (r.seq !== event.seq) return `the receipt names seq ${r.seq} but sits at seq ${event.seq}`;
  if (r.ledgerHead !== event.prev) return 'the ledger head the receipt signed is not the head before it: history before this receipt was changed';
  return null;
}

// The newest receipt for this gate and run that is signed, in place, unused, current and (if asked) bound
// to the requested SHA or content. Returns { ok: true, receipt, seq } or { ok: false, reason }.
export function findValidReceipt({ ledgerDir, publicKey, gate, run, nowMs, binding = null }) {
  const events = readEvents(ledgerDir);
  const used = new Set(events.filter((e) => e.event === 'receipt-consumed').map((e) => e.data?.nonce));
  const candidates = events.filter((e) => e.event === 'approved' && e.data?.receipt?.gate === gate && e.data.receipt.run === run);
  if (!candidates.length) return { ok: false, reason: 'no receipt for this gate and run: unlock through "riverwright submit" or "riverwright post"' };
  let first = null;
  for (const e of [...candidates].reverse()) {
    const r = e.data.receipt;
    let reason = checkOne(e, publicKey);
    if (!reason && used.has(r.nonce)) reason = 'this receipt was already used';
    if (!reason) {
      const age = nowMs - Date.parse(r.at);
      if (Number.isNaN(age)) reason = 'the clock or the receipt time could not be read';
      else if (age < -FUTURE_SKEW_MS) reason = 'the receipt is dated in the future';
      else if (age > RECEIPT_TTL_MS) reason = 'the receipt expired';
    }
    if (!reason && binding && (binding.kind !== r.binding.kind || binding.value !== r.binding.value)) reason = 'the receipt binding does not match what is being published';
    if (!reason) return { ok: true, receipt: r, seq: e.seq };
    first ??= reason;
  }
  return { ok: false, reason: first };
}

// For `riverwright ledger verify`: every approved event's signature, position and nonce.
export function verifyReceipts({ ledgerDir, publicKey }) {
  const problems = [];
  const seen = new Map();
  for (const e of readEvents(ledgerDir)) {
    if (e.event !== 'approved' || !e.data?.receipt) continue;
    const reason = checkOne(e, publicKey);
    if (reason) problems.push({ line: e.seq, reason });
    const n = e.data.receipt.nonce;
    if (seen.has(n)) problems.push({ line: e.seq, reason: `nonce ${n} appears more than once (first at seq ${seen.get(n)})` });
    else seen.set(n, e.seq);
  }
  return problems;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test tests/receipt.test.mjs`

Expected: PASS, 12 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/receipt.mjs tests/receipt-helpers.mjs tests/receipt.test.mjs
git commit -m "feat(security): signed receipts anchored to the ledger head"
```

### Task 4: Reading a passphrase without echo

Spec §7.5 "Unlock", step 3. A terminal that cannot hide typing is refused, because falling back to an echoing prompt would put the passphrase on screen and in the scrollback.

**Files:**

- Modify: `scripts/lib/tty.mjs`, `tests/helpers.mjs`
- Test: `tests/tty-secret.test.mjs`

**Interfaces:**

- Consumes: `RiverwrightError`, `node:tty`.
- Produces:
  - `readSecret({ terminal, question }): Promise<string>`. The terminal must offer `input.setRawMode` (a real terminal) or declare `noEcho: true` (a test terminal). Rejects `NO_ECHO_CONTROL` otherwise, `ABORTED` on Ctrl-C, Ctrl-D or an early end of input. Leftover characters after a newline are kept in `terminal.pending` for the next read.
  - `openTerminal` returns a `tty.ReadStream` (which has `setRawMode`) when the descriptor is a terminal; otherwise its previous stream.
  - `fakeSecretTerminal(secrets: string[])` in `tests/helpers.mjs`.

- [ ] **Step 1: Write the failing test and the test helper**

`tests/tty-secret.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readSecret } from '../scripts/lib/tty.mjs';
import { fakeSecretTerminal } from './helpers.mjs';

test('readSecret returns what was typed, prints the prompt, and never echoes the secret', async () => {
  const t = fakeSecretTerminal(['hunter2 is not a passphrase']);
  const value = await readSecret({ terminal: t, question: 'Passphrase: ' });
  assert.equal(value, 'hunter2 is not a passphrase');
  const shown = t.written.join('');
  assert.match(shown, /Passphrase: /);
  assert.equal(shown.includes('hunter2'), false);
});

test('backspace edits, carriage return ends the line, and arrow-key escape sequences are ignored', async () => {
  const t = fakeSecretTerminal([]);
  t.input.end('abcx\u007f\u001b[Ad\u001b[B\u001b[1;5Cef\r');
  assert.equal(await readSecret({ terminal: t, question: '> ' }), 'abcdef');
});

test('Ctrl-C and an early end of input abort without returning anything', async () => {
  const t = fakeSecretTerminal([]);
  t.input.end('abc\u0003');
  await assert.rejects(readSecret({ terminal: t, question: '> ' }), (e) => e.code === 'ABORTED');
  const u = fakeSecretTerminal([]);
  u.input.end('partial');
  await assert.rejects(readSecret({ terminal: u, question: '> ' }), (e) => e.code === 'ABORTED');
});

test('two secrets can be read in turn from one terminal, even when they arrive in a single chunk', async () => {
  const t = fakeSecretTerminal(['first passphrase', 'second passphrase']);
  assert.equal(await readSecret({ terminal: t, question: 'a: ' }), 'first passphrase');
  assert.equal(await readSecret({ terminal: t, question: 'b: ' }), 'second passphrase');
  await assert.rejects(readSecret({ terminal: t, question: 'c: ' }), (e) => e.code === 'ABORTED');
});

test('a terminal that cannot hide what is typed is refused', async () => {
  const t = { input: new PassThrough(), output: new PassThrough() };
  t.input.end('secret\n');
  await assert.rejects(readSecret({ terminal: t, question: '> ' }), (e) => e.code === 'NO_ECHO_CONTROL' && /hide/.test(e.message));
});

test('a real terminal is put in raw mode for the read and restored afterwards', async () => {
  const input = new PassThrough();
  const modes = [];
  input.setRawMode = (on) => modes.push(on);
  const t = { input, output: new PassThrough() };
  const pending = readSecret({ terminal: t, question: '> ' });
  input.write('pass');
  input.write('word\r');
  assert.equal(await pending, 'password');
  assert.deepEqual(modes, [true, false]);
});

test('the passphrase is normalized by the caller, not here: multi-byte characters survive', async () => {
  const t = fakeSecretTerminal(['pässwörd ✓ 密码']);
  assert.equal(await readSecret({ terminal: t, question: '> ' }), 'pässwörd ✓ 密码');
});
```

Add this to `tests/helpers.mjs`, directly above `fakeTerminal`:

```js
// A terminal for readSecret: `noEcho` declares that nothing typed is echoed. Each entry of `secrets` is one
// typed line. Real terminals never carry this flag; they must offer raw mode (see readSecret).
export function fakeSecretTerminal(secrets) {
  const input = new PassThrough();
  const output = new PassThrough();
  if (secrets.length) input.end(secrets.map((s) => `${s}\n`).join(''));
  const written = [];
  output.on('data', (d) => written.push(String(d)));
  return { input, output, written, noEcho: true, close() {} };
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/tty-secret.test.mjs`

Expected: FAIL: `The requested module '../scripts/lib/tty.mjs' does not provide an export named 'readSecret'`.

- [ ] **Step 3: Write the implementation**

Apply this patch to `scripts/lib/tty.mjs`:

```diff
diff --git a/scripts/lib/tty.mjs b/scripts/lib/tty.mjs
--- a/scripts/lib/tty.mjs
+++ b/scripts/lib/tty.mjs
@@ -1,5 +1,6 @@
 import fs from 'node:fs';
 import readline from 'node:readline';
+import tty from 'node:tty';
 import { RiverwrightError } from './errors.mjs';
 
 export function openTerminal({ platform = process.platform, paths } = {}) {
@@ -13,7 +14,8 @@ export function openTerminal({ platform = process.platform, paths } = {}) {
     if (inFd !== undefined) fs.closeSync(inFd);
     throw new RiverwrightError('NO_TTY', 'Terminal approval needs a real terminal. Run this riverwright command yourself in a terminal window.');
   }
-  const input = fs.createReadStream('', { fd: inFd, autoClose: true });
+  // A real terminal gets a tty.ReadStream, which can switch to raw mode so a passphrase is not echoed.
+  const input = tty.isatty(inFd) ? new tty.ReadStream(inFd) : fs.createReadStream('', { fd: inFd, autoClose: true });
   const output = fs.createWriteStream('', { fd: outFd, autoClose: true });
   return { input, output, close() { input.destroy(); output.end(); } };
 }
@@ -31,3 +33,67 @@ export async function confirmTyped({ terminal, question, expected }) {
     terminal.close?.();
   }
 }
+
+// Reads one secret line without echo. The terminal must be able to hide typing: a real terminal offers raw
+// mode (input.setRawMode), a test terminal declares noEcho. Anything else is refused, because falling back
+// to an echoing prompt would put the passphrase on screen and in the scrollback.
+// Leftover characters after a newline stay in terminal.pending for the next read.
+export function readSecret({ terminal, question }) {
+  const { input, output } = terminal;
+  const raw = typeof input.setRawMode === 'function';
+  if (!raw && terminal.noEcho !== true) {
+    return Promise.reject(new RiverwrightError('NO_ECHO_CONTROL', 'This terminal cannot hide what you type, so Riverwright will not ask for a passphrase in it. Run the command in a normal terminal window.'));
+  }
+  return new Promise((resolve, reject) => {
+    let value = '';
+    let esc = 0;
+    terminal.pending ??= '';
+    if (!terminal.watchingEnd) {
+      terminal.watchingEnd = true;
+      input.once('end', () => { terminal.ended = true; });
+    }
+    const finish = (fn, arg) => {
+      input.off('data', onData);
+      input.off('end', onEnd);
+      if (raw) input.setRawMode(false);
+      input.pause?.();
+      output.write('\n');
+      fn(arg);
+    };
+    const consume = (text) => {
+      const chars = [...text];
+      for (let i = 0; i < chars.length; i += 1) {
+        const ch = chars[i];
+        if (esc === 1) { esc = ch === '[' ? 2 : 0; continue; }
+        if (esc === 2) { if (/[@-~]/.test(ch)) esc = 0; continue; }
+        if (ch === '\u001b') { esc = 1; continue; }
+        if (ch === '\r' || ch === '\n') {
+          terminal.pending = chars.slice(i + 1).join('');
+          return { done: 'ok' };
+        }
+        if (ch === '\u0003' || ch === '\u0004') return { done: 'abort' };
+        if (ch === '\u007f' || ch === '\b') { value = [...value].slice(0, -1).join(''); continue; }
+        if (ch < ' ') continue;
+        value += ch;
+      }
+      return { done: null };
+    };
+    const handle = (text) => {
+      const r = consume(text);
+      if (r.done === 'ok') finish(resolve, value);
+      else if (r.done === 'abort') finish(reject, new RiverwrightError('ABORTED', 'cancelled: no passphrase was entered'));
+      return r.done !== null;
+    };
+    const onData = (chunk) => { handle(String(chunk)); };
+    const onEnd = () => finish(reject, new RiverwrightError('ABORTED', 'the terminal closed before a passphrase was entered'));
+    output.write(question);
+    const carried = terminal.pending;
+    terminal.pending = '';
+    if (carried && handle(carried)) return;
+    if (terminal.ended) { finish(reject, new RiverwrightError('ABORTED', 'the terminal closed before a passphrase was entered')); return; }
+    if (raw) input.setRawMode(true);
+    input.on('data', onData);
+    input.on('end', onEnd);
+    input.resume?.();
+  });
+}
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test tests/tty-secret.test.mjs`

Expected: PASS, 7 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS. Real-terminal echo behavior cannot be tested here (Node has no pseudo-terminal in `node:test`); Task 16 has the manual check on each operating system.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/tty.mjs tests/helpers.mjs tests/tty-secret.test.mjs
git commit -m "feat(security): read a passphrase without echo, refusing terminals that cannot hide it"
```

### Task 5: The ambient-credential audit

Spec §7.5 "Ambient credentials". Riverwright cannot remove the user's own `gh` login, an SSH agent or a token variable, but it can say plainly that they exist. The audit reports names, counts and file names, and never a value; it never reads a credential file and never reads the output of `gh auth status`.

**Files:**

- Create: `scripts/lib/ambient.mjs`
- Test: `tests/ambient.test.mjs`

**Interfaces:**

- Consumes: `runFile` (`exec.mjs`).
- Produces: `auditAmbient({ env?, userHome?, run? }): Promise<Finding[]>` where `Finding = { id, what, why, fix }`. Ids: `env:<NAME>`, `gh-login`, `git-helper:<name|custom>`, `ssh-agent`, `ssh-key-file:<file>`, `gh-config`. `run` is injectable, so tests never touch the machine.

- [ ] **Step 1: Write the failing test**

`tests/ambient.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { auditAmbient } from '../scripts/lib/ambient.mjs';
import { tmpDir } from './helpers.mjs';

const SECRET = 'ghp_thisValueMustNeverBePrinted0123456789';
// A fake runner: it answers by program and arguments and records nothing else.
const runner = (answers) => async (file, args) => {
  const key = `${file} ${args.join(' ')}`;
  for (const [needle, result] of Object.entries(answers)) if (key.startsWith(needle)) return { code: 0, stdout: '', stderr: '', error: null, ...result };
  return { code: null, stdout: '', stderr: '', error: 'not-found' };
};
const audit = (over = {}) => auditAmbient({ env: {}, userHome: tmpDir(), run: runner({}), ...over });
const ids = (f) => f.map((x) => x.id).sort();

test('a clean machine has no findings', async () => {
  assert.deepEqual(await audit(), []);
});

test('token variables are reported by name only, never by value, and empty ones are ignored', async () => {
  const findings = await audit({ env: { GH_TOKEN: SECRET, GITHUB_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: 'x', PATH: '/bin' } });
  assert.deepEqual(ids(findings), ['env:GH_TOKEN', 'env:GITHUB_ENTERPRISE_TOKEN']);
  assert.equal(JSON.stringify(findings).includes(SECRET), false);
});

test('a logged-in gh is reported from its exit status alone; its output is never read', async () => {
  const findings = await audit({ run: runner({ 'gh auth status': { code: 0, stdout: `Logged in, token: ${SECRET}`, stderr: SECRET } }) });
  assert.deepEqual(ids(findings), ['gh-login']);
  assert.equal(JSON.stringify(findings).includes(SECRET), false);
  assert.deepEqual(await audit({ run: runner({ 'gh auth status': { code: 1 } }) }), []);
});

test('git credential helpers are reported by their name, without arguments', async () => {
  const findings = await audit({ run: runner({ 'git config --global --get-all credential.helper': { stdout: `osxkeychain\nstore --file=/home/me/.tokens-${SECRET}\n!f() { echo ${SECRET}; }; f\n` } }) });
  assert.deepEqual(ids(findings), ['git-helper:custom', 'git-helper:osxkeychain', 'git-helper:store']);
  assert.equal(JSON.stringify(findings).includes(SECRET), false);
  assert.equal(JSON.stringify(findings).includes('.tokens'), false);
});

test('loaded SSH keys are counted, and private key files are listed by file name only', async () => {
  const userHome = tmpDir();
  fs.mkdirSync(path.join(userHome, '.ssh'));
  for (const f of ['id_ed25519', 'id_ed25519.pub', 'known_hosts', 'config']) fs.writeFileSync(path.join(userHome, '.ssh', f), SECRET);
  const findings = await audit({ userHome, run: runner({ 'ssh-add -l': { stdout: `256 SHA256:${SECRET} me (ED25519)\n256 SHA256:abc other (ED25519)\n` } }) });
  assert.deepEqual(ids(findings), ['ssh-agent', 'ssh-key-file:id_ed25519']);
  assert.match(findings.find((f) => f.id === 'ssh-agent').what, /2 keys/);
  assert.equal(JSON.stringify(findings).includes(SECRET), false);
});

test('a gh config file is reported by presence, not read', async () => {
  const userHome = tmpDir();
  fs.mkdirSync(path.join(userHome, '.config', 'gh'), { recursive: true });
  fs.writeFileSync(path.join(userHome, '.config', 'gh', 'hosts.yml'), `oauth_token: ${SECRET}\n`);
  const findings = await audit({ userHome });
  assert.deepEqual(ids(findings), ['gh-config']);
  assert.equal(JSON.stringify(findings).includes(SECRET), false);
});

test('every finding explains what it means and what to do', async () => {
  const findings = await audit({ env: { GH_TOKEN: SECRET } });
  for (const f of findings) assert.ok(f.what && f.why && f.fix, f.id);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/ambient.test.mjs`

Expected: FAIL to load, `ERR_MODULE_NOT_FOUND` for `scripts/lib/ambient.mjs`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/ambient.mjs`:

```js
// Finds credential routes an agent in this account could use without Riverwright (ADR-0010). It reports
// names, counts and file names, never a value, and it never reads a credential file. Riverwright cannot
// remove the user's own login; it can tell them plainly that it exists.
import fs from 'node:fs';
import path from 'node:path';
import { runFile } from './exec.mjs';

const TOKEN_VARS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
const KNOWN_HELPERS = new Set(['osxkeychain', 'manager', 'manager-core', 'store', 'cache', 'libsecret', 'wincred', 'gh']);
const WHY = 'An agent running as this account can use it to publish without Riverwright.';

const finding = (id, what, fix) => ({ id, what, why: WHY, fix });

export async function auditAmbient({ env = process.env, userHome, run = runFile } = {}) {
  const out = [];
  for (const name of TOKEN_VARS) {
    if (typeof env[name] === 'string' && env[name] !== '') out.push(finding(`env:${name}`, `The environment variable ${name} is set.`, `Unset ${name} in the shell that starts your agent.`));
  }
  const gh = await run('gh', ['auth', 'status'], { timeoutMs: 10000 });
  if (gh.code === 0) out.push(finding('gh-login', 'The GitHub CLI (gh) is logged in.', 'Run "gh auth logout" on the machine that runs the agent, or use a separate account for it.'));
  const helpers = await run('git', ['config', '--global', '--get-all', 'credential.helper'], { timeoutMs: 10000 });
  if (helpers.code === 0) {
    const names = new Set();
    for (const line of helpers.stdout.split('\n')) {
      const first = line.trim().split(/\s+/)[0];
      if (!first) continue;
      names.add(KNOWN_HELPERS.has(first) ? first : 'custom');
    }
    for (const n of names) out.push(finding(`git-helper:${n}`, n === 'custom' ? 'A custom git credential helper is configured.' : `The git credential helper "${n}" is configured.`, 'Remove it from your global git config on the machine that runs the agent, or scope it to hosts other than github.com.'));
  }
  const agent = await run('ssh-add', ['-l'], { timeoutMs: 10000 });
  if (agent.code === 0) {
    const count = agent.stdout.split('\n').filter((l) => l.trim()).length;
    out.push(finding('ssh-agent', `An SSH agent holds ${count} key${count === 1 ? '' : 's'}.`, 'Run "ssh-add -D", or add keys with "ssh-add -c" so each use needs a confirmation.'));
  }
  if (userHome) {
    try {
      for (const f of fs.readdirSync(path.join(userHome, '.ssh')).sort()) {
        if (/^id_[A-Za-z0-9_]+$/.test(f)) out.push(finding(`ssh-key-file:${f}`, `The private key file ~/.ssh/${f} exists.`, 'Protect it with a passphrase, or keep it on a hardware key.'));
      }
    } catch { /* no ~/.ssh */ }
    if (fs.existsSync(path.join(userHome, '.config', 'gh', 'hosts.yml'))) {
      out.push(finding('gh-config', 'A GitHub CLI config file (~/.config/gh/hosts.yml) exists and may hold a token.', 'Run "gh auth logout", or store the login in the system keyring.'));
    }
  }
  return out;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test tests/ambient.test.mjs`

Expected: PASS, 7 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/ambient.mjs tests/ambient.test.mjs
git commit -m "feat(security): report credential routes an agent could use without Riverwright"
```

### Task 6: `riverwright credential setup | status | remove`

Spec §7.5 "Vault". The human runs this in a terminal. The token and passphrase are typed at a hidden prompt, never taken from an argument or the environment. `status` also prints the ambient audit from Task 5.

**Files:**

- Create: `scripts/lib/commands/credential.mjs`
- Modify: `scripts/lib/cli.mjs` (register `credential`)
- Test: `tests/credential-cli.test.mjs`

**Interfaces:**

- Consumes: `riverwrightHome`, `nowIso`, `openTerminal`, `readSecret`, `sealVault`, `defaultKdf`, `writeVault`, `readVault`, `vaultFile`, `fingerprint`, `auditAmbient`.
- Produces: `riverwright credential setup [--replace]`, `status`, `remove`. Exit 0 on success, 1 on any refusal. The only seam is `io.testing.kdf` (small KDF parameters for fast tests); the entry point never sets it.

- [ ] **Step 1: Write the failing test**

`tests/credential-cli.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { callMain, fakeSecretTerminal, tmpDir } from './helpers.mjs';
import { readVault, openVault, vaultFile, fingerprint } from '../scripts/lib/vault.mjs';
import { RiverwrightError } from '../scripts/lib/errors.mjs';
import { FAST_KDF, PASSPHRASE, TOKEN } from './receipt-helpers.mjs';

const cred = (home, args, opts = {}) => callMain(['credential', ...args], { env: { RIVERWRIGHT_HOME: home, PATH: '' }, testing: { now: '2026-10-02T14:03:11.000Z', kdf: FAST_KDF }, ...opts });
const noTerminal = () => { throw new RiverwrightError('NO_TTY', 'Terminal approval needs a real terminal.'); };

test('credential setup seals the token and prints only the public-key fingerprint', async () => {
  const home = tmpDir();
  const t = fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]);
  const r = await cred(home, ['setup'], { terminal: t });
  assert.equal(r.code, 0, r.stderr);
  const vault = readVault(home);
  assert.equal(openVault(vault, PASSPHRASE).token, TOKEN);
  assert.equal(vault.createdAt, '2026-10-02T14:03:11.000Z');
  assert.ok(r.stdout.includes(fingerprint(vault.publicKey)));
  for (const secret of [TOKEN, PASSPHRASE]) {
    assert.equal(r.stdout.includes(secret) || r.stderr.includes(secret) || t.written.join('').includes(secret), false);
  }
  assert.match(r.stdout, /never into a chat/i);
});

test('setup refuses mismatched or short passphrases and writes nothing', async () => {
  const home = tmpDir();
  const mismatch = await cred(home, ['setup'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, `${PASSPHRASE}x`]) });
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.stderr, /did not match/);
  const short = await cred(home, ['setup'], { terminal: fakeSecretTerminal([TOKEN, 'short', 'short']) });
  assert.equal(short.code, 1);
  assert.match(short.stderr, /at least 12/);
  assert.equal(fs.existsSync(vaultFile(home)), false);
});

test('setup needs a real terminal and takes no secret from arguments or the environment', async () => {
  const home = tmpDir();
  const none = await cred(home, ['setup'], { terminal: noTerminal });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /real terminal/);
  const viaArg = await cred(home, ['setup', '--token', TOKEN], { terminal: fakeSecretTerminal([]) });
  assert.equal(viaArg.code, 1);
  const viaEnv = await callMain(['credential', 'setup'], { env: { RIVERWRIGHT_HOME: home, GH_TOKEN: TOKEN, RIVERWRIGHT_PASSPHRASE: PASSPHRASE }, testing: { kdf: FAST_KDF }, terminal: noTerminal });
  assert.equal(viaEnv.code, 1);
  assert.equal(fs.existsSync(vaultFile(home)), false);
});

test('an existing vault is not replaced without --replace, and the refusal comes before any prompt', async () => {
  const home = tmpDir();
  await cred(home, ['setup'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) });
  const t = fakeSecretTerminal([]);
  const r = await cred(home, ['setup'], { terminal: t });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--replace/);
  assert.equal(t.written.join(''), '');
  const replaced = await cred(home, ['setup', '--replace'], { terminal: fakeSecretTerminal(['ghp_anotherTokenValue0123456789', PASSPHRASE, PASSPHRASE]) });
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.equal(openVault(readVault(home), PASSPHRASE).token, 'ghp_anotherTokenValue0123456789');
});

test('credential status shows the fingerprint and no secret, and says so when there is no vault', async () => {
  const home = tmpDir();
  const none = await cred(home, ['status']);
  assert.equal(none.code, 0);
  assert.match(none.stdout, /No sealed credential/);
  await cred(home, ['setup'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) });
  const r = await cred(home, ['status']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(fingerprint(readVault(home).publicKey)));
  assert.match(r.stdout, /argon2id|scrypt/);
  assert.equal(r.stdout.includes(TOKEN) || r.stdout.includes(PASSPHRASE), false);
});

test('credential status lists ambient credential routes and never their values', async () => {
  const home = tmpDir();
  const r = await callMain(['credential', 'status'], { env: { RIVERWRIGHT_HOME: home, GH_TOKEN: TOKEN, PATH: '' }, testing: { kdf: FAST_KDF } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /GH_TOKEN/);
  assert.match(r.stdout, /without Riverwright/);
  assert.equal(r.stdout.includes(TOKEN), false);
});

test('credential remove deletes the vault only after "remove" is typed at the terminal', async () => {
  const home = tmpDir();
  await cred(home, ['setup'], { terminal: fakeSecretTerminal([TOKEN, PASSPHRASE, PASSPHRASE]) });
  const wrong = await cred(home, ['remove'], { terminal: fakeSecretTerminal(['no']) });
  assert.equal(wrong.code, 1);
  assert.equal(fs.existsSync(vaultFile(home)), true);
  const ok = await cred(home, ['remove'], { terminal: fakeSecretTerminal(['remove']) });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(fs.existsSync(vaultFile(home)), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/credential-cli.test.mjs`

Expected: FAIL, 7 tests, each with `riverwright: unknown command "credential"`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/commands/credential.mjs`:

```js
import fs from 'node:fs';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { RiverwrightError } from '../errors.mjs';
import { riverwrightHome } from '../paths.mjs';
import { nowIso } from '../clock.mjs';
import { openTerminal, readSecret } from '../tty.mjs';
import { defaultKdf, fingerprint, readVault, sealVault, vaultFile, writeVault } from '../vault.mjs';
import { auditAmbient } from '../ambient.mjs';

const USAGE = 'usage: riverwright credential <setup [--replace] | status | remove>';

const terminalOf = (io) => (io.openTerminal ? io.openTerminal() : openTerminal({ platform: io.platform }));

async function setup(values, io, home) {
  // Refuse before any prompt, so nothing is typed for a vault that will not be written.
  if (!values.replace && fs.existsSync(vaultFile(home))) {
    throw new RiverwrightError('VAULT_EXISTS', `a sealed credential already exists at ${vaultFile(home)}; pass --replace to overwrite it`);
  }
  const terminal = terminalOf(io);
  try {
    terminal.output.write('Riverwright will seal a GitHub token under a passphrase you choose. Nothing you type is shown.\n');
    const token = await readSecret({ terminal, question: 'GitHub token: ' });
    const passphrase = await readSecret({ terminal, question: 'New passphrase (12+ characters): ' });
    const again = await readSecret({ terminal, question: 'Type the passphrase again: ' });
    if (passphrase !== again) throw new RiverwrightError('MISMATCH', 'the two passphrases did not match; nothing was saved');
    const vault = sealVault({ token, passphrase, kdf: io.testing?.kdf ?? defaultKdf(), now: nowIso(io) });
    writeVault(home, vault, { replace: Boolean(values.replace) });
    io.stdout.write([
      `Sealed credential saved to ${vaultFile(home)}`,
      `Public-key fingerprint: ${fingerprint(vault.publicKey)}`,
      'Note the fingerprint: "riverwright credential status" shows it again, and it is how you know the receipts are yours.',
      'Type your passphrase only into a prompt started by "riverwright submit" or "riverwright post" in a terminal, never into a chat with an agent.',
      '',
    ].join('\n'));
  } finally {
    terminal.close?.();
  }
}

async function status(io, home) {
  let vault = null;
  try {
    vault = readVault(home);
  } catch (e) {
    if (e.code !== 'NO_VAULT') throw e;
  }
  if (!vault) io.stdout.write(`No sealed credential yet (looked in ${vaultFile(home)}). Run "riverwright credential setup" in a terminal.\n`);
  else io.stdout.write(`Sealed credential: ${vaultFile(home)}\nPublic-key fingerprint: ${fingerprint(vault.publicKey)}\nKey derivation: ${vault.kdf.name}\nCreated: ${vault.createdAt ?? 'unknown'}\n`);
  const findings = await auditAmbient({ env: io.env, userHome: os.userInfo().homedir });
  if (findings.length === 0) {
    io.stdout.write('No credential routes found that an agent could use without Riverwright.\n');
  } else {
    io.stdout.write('\nCredential routes an agent could use without Riverwright (Riverwright cannot remove these for you):\n');
    for (const f of findings) io.stdout.write(`  - ${f.what} ${f.fix}\n`);
  }
  return 0;
}

async function remove(io, home) {
  readVault(home);
  const terminal = terminalOf(io);
  try {
    const answer = await new Promise((resolve) => {
      terminal.output.write(`This deletes the sealed credential at ${vaultFile(home)}. Type "remove" to confirm: `);
      let buf = '';
      terminal.input.on('data', (d) => { buf += String(d); if (buf.includes('\n')) resolve(buf.split('\n')[0].trim()); });
      terminal.input.on('end', () => resolve(''));
    });
    if (answer !== 'remove') throw new RiverwrightError('NOT_CONFIRMED', 'not removed');
    fs.rmSync(vaultFile(home));
    io.stdout.write('Sealed credential removed.\n');
  } finally {
    terminal.close?.();
  }
}

export async function run(args, io) {
  const [sub, ...rest] = args;
  // A person runs this command, so RIVERWRIGHT_HOME is honored. No secret is read from an argument or the environment.
  const { values } = parseArgs({ args: rest, options: { replace: { type: 'boolean', default: false } } });
  const home = riverwrightHome(io.env);
  switch (sub) {
    case 'setup': await setup(values, io, home); return 0;
    case 'status': return status(io, home);
    case 'remove': await remove(io, home); return 0;
    default: throw new RiverwrightError('USAGE', USAGE);
  }
}
```

In `scripts/lib/cli.mjs`, add this line to `COMMANDS` after `approve`:

```js
  credential: () => import('./commands/credential.mjs'),
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test tests/credential-cli.test.mjs`

Expected: PASS, 7 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/commands/credential.mjs scripts/lib/cli.mjs tests/credential-cli.test.mjs
git commit -m "feat(security): riverwright credential setup, status and remove"
```

### Task 7: The collapsed public gate — `runPublicAction`

Spec §6 and §7.5, ADR-0010. One function shows the payload, unlocks with the passphrase, signs a receipt, runs the action with the token, retries a transient failure in the same process, and consumes the receipt. Plan 2b's `submit` and `post` are thin callers of it.

**Files:**

- Create: `scripts/lib/gate.mjs`
- Modify: `scripts/lib/approvals.mjs` (an `unlock` mode; `recordApproval` accepts an already-checked binding)
- Test: `tests/gate.test.mjs`

**Interfaces:**

- Consumes: `readVault`, `openVault`, `readSecret`, `PUBLIC_GATES`, `appendReceipt`, `markConsumed`, `appendEvent`, `ledgerDirFor`, `loadState`, `saveState`, `recordApproval`.
- Produces:
  - `RETRY = Object.freeze({ attempts: 3, windowMs: 120000, backoffMs: [2000, 5000] })`.
  - `runPublicAction({ home, runDir, gate, run, binding, branch?, host?, terminal, summary: string[], warnings?: string[], now: () => iso, clock?: () => ms, sleep?, recompute: async () => binding, action: async ({ token, receipt, attempt }) => any }): Promise<{ result, receipt, attempts }>`.
  - The action signals a retryable failure with an error whose `transient === true`. Errors: `NOT_PUBLIC_GATE`, `NO_VAULT`, `UNLOCK_REFUSED`, `ABORTED`, `PAYLOAD_CHANGED`.
  - `approvals.mjs`: `APPROVAL_MODES = ['host-ask','tty','unlock']`; `checkBinding(binding)`; `recordApproval(state, { gate, binding?, sha?, content?, mode, host?, now, branch? })`.

- [ ] **Step 1: Write the failing test**

`tests/gate.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETRY, runPublicAction } from '../scripts/lib/gate.mjs';
import { findValidReceipt } from '../scripts/lib/receipt.mjs';
import { readEvents } from '../scripts/lib/events.mjs';
import { ledgerDirFor } from '../scripts/lib/ledger.mjs';
import { createState, loadState, saveState } from '../scripts/lib/state.mjs';
import { recordApproval } from '../scripts/lib/approvals.mjs';
import { NOW, NOW_MS, PASSPHRASE, TOKEN, makeTestVault, runDirIn } from './receipt-helpers.mjs';
import { fakeSecretTerminal, tmpDir } from './helpers.mjs';

const RUN = 'ruvnet/ruflo#3509';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BRANCH = 'riverwright/3509-codex';
const binding = { kind: 'sha', value: A };

function setup() {
  const home = tmpDir();
  const runDir = runDirIn(home);
  saveState(runDir, createState({ runId: RUN, now: NOW }));
  const keys = makeTestVault(home);
  const ledgerDir = ledgerDirFor(runDir);
  const clock = { t: 1_000_000 };
  const sleeps = [];
  const base = {
    home, runDir, gate: 'submit-gate', run: RUN, binding, branch: BRANCH, host: 'claude-code',
    summary: [`Push ${A} to pacphi/ruflo:${BRANCH}`, 'Open a draft pull request against ruvnet/ruflo'],
    warnings: [], now: () => NOW, clock: () => clock.t,
    sleep: async (ms) => { sleeps.push(ms); clock.t += ms; },
    recompute: async () => binding,
  };
  return { home, runDir, keys, ledgerDir, clock, sleeps, base };
}
const events = (s) => readEvents(s.ledgerDir).map((e) => e.event);
const transient = (msg = 'network down') => Object.assign(new Error(msg), { transient: true });

test('the retry limits are frozen constants: 3 attempts within 2 minutes', () => {
  assert.equal(Object.isFrozen(RETRY), true);
  assert.deepEqual([RETRY.attempts, RETRY.windowMs], [3, 120_000]);
});

test('a correct passphrase signs a receipt, runs the action with the token, and consumes the receipt', async () => {
  const s = setup();
  const t = fakeSecretTerminal([PASSPHRASE]);
  let seen;
  const r = await runPublicAction({ ...s.base, terminal: t, action: async ({ token, receipt, attempt }) => { seen = { token, receipt, attempt }; return 'pushed'; } });
  assert.equal(r.result, 'pushed');
  assert.equal(seen.token, TOKEN);
  assert.equal(seen.attempt, 1);
  assert.deepEqual(events(s), ['approved', 'receipt-consumed']);
  assert.equal(readEvents(s.ledgerDir)[1].data.outcome, 'succeeded');
  assert.equal(findValidReceipt({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey, gate: 'submit-gate', run: RUN, nowMs: NOW_MS }).reason, 'this receipt was already used');
  const approval = loadState(s.runDir).approvals.at(-1);
  assert.deepEqual([approval.gate, approval.mode, approval.branch, approval.binding.value], ['submit-gate', 'unlock', BRANCH, A]);
});

test('the terminal shows the payload and warnings, and never the token or the passphrase', async () => {
  const s = setup();
  const t = fakeSecretTerminal([PASSPHRASE]);
  await runPublicAction({ ...s.base, warnings: ['The environment variable GH_TOKEN is set.'], terminal: t, action: async () => 'ok' });
  const shown = t.written.join('');
  assert.match(shown, new RegExp(`Push ${A}`));
  assert.match(shown, /GH_TOKEN is set/);
  assert.equal(shown.includes(TOKEN) || shown.includes(PASSPHRASE), false);
});

test('a wrong passphrase gets three tries in all, then nothing is released and the refusal is recorded', async () => {
  const s = setup();
  let called = false;
  const wrong = fakeSecretTerminal(['wrong one one one', 'wrong two two two', 'wrong three three']);
  await assert.rejects(runPublicAction({ ...s.base, terminal: wrong, action: async () => { called = true; } }), (e) => e.code === 'UNLOCK_REFUSED');
  assert.equal(called, false);
  assert.deepEqual(events(s), ['unlock-refused']);
  const ok = fakeSecretTerminal(['wrong one one one', PASSPHRASE]);
  const s2 = setup();
  await runPublicAction({ ...s2.base, terminal: ok, action: async () => 'ok' });
  assert.deepEqual(events(s2), ['approved', 'receipt-consumed']);
});

test('cancelling at the prompt releases nothing and is recorded', async () => {
  const s = setup();
  const t = fakeSecretTerminal([]);
  t.input.end('abc\u0003');
  await assert.rejects(runPublicAction({ ...s.base, terminal: t, action: async () => { throw new Error('must not run'); } }), (e) => e.code === 'ABORTED');
  assert.deepEqual(events(s), ['unlock-refused']);
});

test('with no vault the message says how to create one, and nothing is written', async () => {
  const s = setup();
  const empty = tmpDir();
  await assert.rejects(runPublicAction({ ...s.base, home: empty, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => 'x' }), (e) => e.code === 'NO_VAULT' && /credential setup/.test(e.message));
  assert.deepEqual(events(s), []);
});

test('only the three public gates can be unlocked', async () => {
  const s = setup();
  for (const gate of ['checkpoint-1', 'merge', undefined]) {
    await assert.rejects(runPublicAction({ ...s.base, gate, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => 'x' }), /public gate/);
  }
});

test('a payload that changed between the summary and the unlock is refused before any receipt exists', async () => {
  const s = setup();
  let called = false;
  await assert.rejects(runPublicAction({ ...s.base, recompute: async () => ({ kind: 'sha', value: B }), terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { called = true; } }), (e) => e.code === 'PAYLOAD_CHANGED');
  assert.equal(called, false);
  assert.deepEqual(events(s), ['unlock-refused']);
  assert.equal(loadState(s.runDir).approvals.length, 0);
});

test('a transient failure is retried in the same process without asking for the passphrase again', async () => {
  const s = setup();
  const t = fakeSecretTerminal([PASSPHRASE]);
  let n = 0;
  const r = await runPublicAction({ ...s.base, terminal: t, action: async ({ attempt }) => { n += 1; if (attempt < 3) throw transient(); return 'done'; } });
  assert.equal(r.result, 'done');
  assert.equal(n, 3);
  assert.deepEqual(s.sleeps, [2000, 5000]);
  assert.deepEqual(events(s), ['approved', 'receipt-consumed']);
  assert.equal(t.written.join('').split('Passphrase').length - 1, 1);
});

test('retries stop after three attempts, the receipt is consumed as failed, and a new run needs a new unlock', async () => {
  const s = setup();
  let n = 0;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { n += 1; throw transient(`down ${n}`); } }), /down 3/);
  assert.equal(n, 3);
  assert.equal(readEvents(s.ledgerDir).at(-1).data.outcome, 'failed');
  assert.match(findValidReceipt({ ledgerDir: s.ledgerDir, publicKey: s.keys.publicKey, gate: 'submit-gate', run: RUN, nowMs: NOW_MS }).reason, /already used/);
});

test('a definitive failure is not retried', async () => {
  const s = setup();
  let n = 0;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { n += 1; throw new Error('401 bad credentials'); } }), /401/);
  assert.equal(n, 1);
  assert.deepEqual(s.sleeps, []);
  assert.equal(readEvents(s.ledgerDir).at(-1).data.outcome, 'failed');
});

test('no retry starts once the two-minute window has passed', async () => {
  const s = setup();
  let n = 0;
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { n += 1; s.clock.t += RETRY.windowMs + 1; throw transient(); } }), /network down/);
  assert.equal(n, 1);
});

test('a payload that changes while retrying stops the retry', async () => {
  const s = setup();
  let calls = 0;
  let n = 0;
  await assert.rejects(runPublicAction({
    ...s.base,
    terminal: fakeSecretTerminal([PASSPHRASE]),
    recompute: async () => { calls += 1; return calls === 1 ? binding : { kind: 'sha', value: B }; },
    action: async () => { n += 1; throw transient(); },
  }), (e) => e.code === 'PAYLOAD_CHANGED');
  assert.equal(n, 1);
  assert.equal(readEvents(s.ledgerDir).at(-1).data.outcome, 'failed');
});

test('the token is removed from any error the action throws', async () => {
  const s = setup();
  await assert.rejects(runPublicAction({ ...s.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async () => { throw new Error(`request failed for token ${TOKEN}`); } }), (e) => !e.message.includes(TOKEN) && /redacted/.test(e.message));
});

test('a forged approval already in state.json does not stand in for an unlock', async () => {
  const s = setup();
  saveState(s.runDir, recordApproval(loadState(s.runDir), { gate: 'submit-gate', sha: A, mode: 'host-ask', now: 't', branch: BRANCH }));
  let called = false;
  const t = fakeSecretTerminal(['wrong one one one', 'wrong two two two', 'wrong three three']);
  await assert.rejects(runPublicAction({ ...s.base, terminal: t, action: async () => { called = true; } }), (e) => e.code === 'UNLOCK_REFUSED');
  assert.equal(called, false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/gate.test.mjs`

Expected: FAIL to load, `ERR_MODULE_NOT_FOUND` for `scripts/lib/gate.mjs`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/gate.mjs`:

```js
// The collapsed public gate (ADR-0010): show the payload, unlock with the passphrase, sign a receipt, run the
// action with the token, retry a transient failure a few times in this same process, consume the receipt.
// The token lives only in this function's memory. Nothing is cached across runs, so a run that exits needs
// a new unlock. The retry limits are constants here, not settings an agent could change.
import { RiverwrightError } from './errors.mjs';
import { openVault, readVault } from './vault.mjs';
import { readSecret } from './tty.mjs';
import { PUBLIC_GATES, appendReceipt, markConsumed } from './receipt.mjs';
import { appendEvent, ledgerDirFor } from './ledger.mjs';
import { loadState, saveState } from './state.mjs';
import { recordApproval } from './approvals.mjs';

export const RETRY = Object.freeze({ attempts: 3, windowMs: 120_000, backoffMs: Object.freeze([2000, 5000]) });
const PASSPHRASE_TRIES = 3;

const same = (a, b) => a?.kind === b?.kind && a?.value === b?.value;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function redact(error, token) {
  if (!token || !error) return error;
  try {
    if (typeof error.message === 'string' && error.message.includes(token)) error.message = error.message.split(token).join('[redacted]');
    if (typeof error.stack === 'string' && error.stack.includes(token)) error.stack = error.stack.split(token).join('[redacted]');
  } catch { /* frozen error object */ }
  return error;
}

// action({ token, receipt, attempt }) does the public thing. It throws an error with `transient: true` for a
// network error, a 5xx or a rate limit; anything else is final. recompute() returns the payload's binding as it
// is now (a commit SHA or a content hash) and is called again before every retry.
export async function runPublicAction({ home, runDir, gate, run, binding, branch = null, host = null, terminal, summary, warnings = [], now, clock = Date.now, sleep = defaultSleep, recompute, action }) {
  if (!PUBLIC_GATES.includes(gate)) throw new RiverwrightError('NOT_PUBLIC_GATE', `"${gate}" is not a public gate (${PUBLIC_GATES.join(', ')})`);
  const vault = readVault(home);
  const refuse = (reason) => appendEvent(runDir, { type: 'unlock-refused', at: now(), actor: { type: 'human' }, run, gate, reason });
  const out = terminal.output;
  out.write(`\nRiverwright is about to act publicly (${gate}) for ${run}:\n`);
  for (const line of summary) out.write(`  ${line}\n`);
  if (warnings.length) {
    out.write('\nRiverwright cannot stop these routes to your credentials:\n');
    for (const w of warnings) out.write(`  - ${w}\n`);
  }
  out.write('\nType your passphrase to approve this exact action. Nothing you type is shown.\n');

  let opened = null;
  for (let i = 0; i < PASSPHRASE_TRIES && !opened; i += 1) {
    let passphrase;
    try {
      passphrase = await readSecret({ terminal, question: 'Passphrase: ' });
    } catch (e) {
      if (e.code === 'ABORTED') refuse('aborted');
      throw e;
    }
    try {
      opened = openVault(vault, passphrase);
    } catch (e) {
      if (e.code !== 'BAD_PASSPHRASE') throw e;
      out.write('That passphrase did not open the vault.\n');
    }
  }
  if (!opened) {
    refuse('wrong passphrase');
    throw new RiverwrightError('UNLOCK_REFUSED', `the passphrase did not open the vault after ${PASSPHRASE_TRIES} tries; nothing was published`);
  }

  let token = opened.token;
  const changed = () => new RiverwrightError('PAYLOAD_CHANGED', 'what would be published changed after it was shown to you; nothing was published. Run the command again.');
  if (!same(await recompute(), binding)) {
    refuse('payload changed');
    throw changed();
  }

  const ledgerDir = ledgerDirFor(runDir);
  const written = appendReceipt({ ledgerDir, privateKey: opened.privateKey, gate, run, binding, branch, at: now() });
  const receipt = written.record.data.receipt;
  const consume = (outcome) => markConsumed({ ledgerDir, nonce: receipt.nonce, outcome, at: now() });
  try {
    saveState(runDir, recordApproval(loadState(runDir), { gate, binding, mode: 'unlock', host, now: now(), branch }));
    const started = clock();
    let attempt = 0;
    let result;
    for (;;) {
      attempt += 1;
      try {
        result = await action({ token, receipt, attempt });
        break;
      } catch (e) {
        const wait = RETRY.backoffMs[attempt - 1];
        const canRetry = e?.transient === true && attempt < RETRY.attempts && wait !== undefined && clock() - started + wait <= RETRY.windowMs;
        if (!canRetry) throw e;
        await sleep(wait);
        if (!same(await recompute(), binding)) throw changed();
      }
    }
    consume('succeeded');
    return { result, receipt, attempts: attempt };
  } catch (e) {
    consume('failed');
    throw redact(e, token);
  } finally {
    token = null;
  }
}
```

Then apply this change to `scripts/lib/approvals.mjs`:

```diff
diff --git a/scripts/lib/approvals.mjs b/scripts/lib/approvals.mjs
--- a/scripts/lib/approvals.mjs
+++ b/scripts/lib/approvals.mjs
@@ -4,7 +4,8 @@ import { toLf } from './fsx.mjs';
 import { assertHost } from './hosts.mjs';
 
 export const GATES = ['checkpoint-1', 'submit-gate', 'post-issue', 'post-comment'];
-export const APPROVAL_MODES = ['host-ask', 'tty'];
+// `unlock` is a public gate approved by the passphrase unlock inside submit or post (ADR-0010).
+export const APPROVAL_MODES = ['host-ask', 'tty', 'unlock'];
 const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
 
 export function contentHash(text) {
@@ -34,10 +35,19 @@ export function normalizeBranch(branch) {
   return b;
 }
 
-export function recordApproval(state, { gate, sha, content, mode, host = null, now, branch }) {
+const CONTENT = /^sha256:[0-9a-f]{64}$/;
+
+// A binding that was already computed (an unlock passes the one it verified) is checked, not recomputed.
+export function checkBinding(binding) {
+  const ok = (binding?.kind === 'sha' && SHA.test(binding.value)) || (binding?.kind === 'content' && CONTENT.test(binding.value));
+  if (!ok) throw new RiverwrightError('BAD_BINDING', 'a binding is a full commit SHA or a sha256: content hash');
+  return { kind: binding.kind, value: binding.value };
+}
+
+export function recordApproval(state, { gate, sha, content, binding: given, mode, host = null, now, branch }) {
   if (!GATES.includes(gate)) throw new RiverwrightError('UNKNOWN_GATE', `unknown gate "${gate}" (use ${GATES.join(', ')})`);
-  if (!APPROVAL_MODES.includes(mode)) throw new RiverwrightError('UNKNOWN_MODE', `unknown approval mode "${mode}" (use host-ask or tty)`);
-  const binding = makeBinding({ sha, content });
+  if (!APPROVAL_MODES.includes(mode)) throw new RiverwrightError('UNKNOWN_MODE', `unknown approval mode "${mode}" (use host-ask, tty or unlock)`);
+  const binding = given === undefined ? makeBinding({ sha, content }) : checkBinding(given);
   const approval = { gate, binding, approvedAt: now, mode, host: assertHost(host), revoked: false };
   if (branch !== undefined && branch !== null) approval.branch = normalizeBranch(branch);
   return { ...state, approvals: [...state.approvals, approval] };
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test tests/gate.test.mjs tests/approvals.test.mjs`

Expected: PASS, 15 gate tests and Plan 1's approvals tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/gate.mjs scripts/lib/approvals.mjs tests/gate.test.mjs
git commit -m "feat(security): the public gate, an unlock that signs a receipt and bounds its retries"
```

### Task 8: The pre-push guard trusts a verified receipt, not `state.json`

Spec §7.1. The guard finds the newest receipt for this run in the ledger and checks its signature against the vault's public key, that its seq and ledger head match its own position, that it is unused, current, and for the exact commit and branch being pushed. `state.json` is not consulted for consent, because an agent can write it.

This task changes existing behavior, so several Plan 1 tests change with it. The tests that assert a forged run must be **denied** stay as they are and become stronger.

**Files:**

- Modify: `scripts/lib/commands/guard.mjs`, `scripts/lib/guard.mjs`
- Modify (tests): `tests/receipt-helpers.mjs` (add `armRun`), `tests/guard.test.mjs`, `tests/seams.test.mjs`, `tests/workspace-home.test.mjs`
- Create (test): `tests/guard-receipt.test.mjs`

**Interfaces:**

- Consumes: `findValidReceipt`, `readVault`, `ledgerDirFor`, `decidePrePush` (unchanged signature).
- Produces: `armRun({ home, runDir, sha?, branch?, run?, at? }): keys` in `tests/receipt-helpers.mjs` (a real vault plus a signed, current receipt, dated now unless `at` is given). The guard's deny messages now say "Nothing has been unlocked at the submit gate yet" and append the receipt reason, for example "(the receipt expired)".

- [ ] **Step 1: Write the failing tests**

Apply this patch to the existing tests and the helper:

```diff
diff --git a/tests/guard.test.mjs b/tests/guard.test.mjs
--- a/tests/guard.test.mjs
+++ b/tests/guard.test.mjs
@@ -9,6 +9,7 @@ import { recordApproval } from '../scripts/lib/approvals.mjs';
 import { readLedger } from '../scripts/lib/ledger.mjs';
 import { runFile } from '../scripts/lib/exec.mjs';
 import { callMain, runRiverwright, tmpDir } from './helpers.mjs';
+import { NOW, armRun } from './receipt-helpers.mjs';
 
 const A = 'a'.repeat(40);
 const B = 'b'.repeat(40);
@@ -40,7 +41,7 @@ test('pushing to upstream is refused, even by literal URL', () => {
 test('everything else is refused with a reason', () => {
   const cases = [
     [{ forkUrl: null, approvedSha: A, updates: line(A) }, /no fork yet/],
-    [{ forkUrl: FORK, approvedSha: null, updates: line(A) }, /Nothing has been approved/],
+    [{ forkUrl: FORK, approvedSha: null, updates: line(A) }, /Nothing has been unlocked/],
     [{ forkUrl: FORK, approvedSha: A, updates: line(B) }, /not the approved commit/],
     [{ forkUrl: FORK, approvedSha: A, updates: line(A, 'refs/heads/main') }, /Only branches named riverwright/],
     [{ forkUrl: FORK, approvedSha: A, updates: line(A, 'refs/tags/v1') }, /Only branches named riverwright/],
@@ -62,10 +63,10 @@ test('renderPrePushHook quotes install paths with spaces and refuses unsafe ones
 
 async function runWithApproval(sha) {
   const dir = tmpDir();
-  let s = setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK);
-  s = recordApproval(s, { gate: 'submit-gate', sha: A, mode: 'host-ask', now: 't', branch: 'riverwright/3509-codex' });
-  saveState(dir, s);
-  const r = await callMain(['guard', 'pre-push', 'fork', FORK], { stdin: line(sha), testing: { allowRunDirOverride: true, runDir: dir, now: 't' } });
+  const home = tmpDir('riverwright-home-');
+  saveState(dir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
+  armRun({ home, runDir: dir, sha: A, at: NOW });
+  const r = await callMain(['guard', 'pre-push', '--home', home, '--', 'fork', FORK], { stdin: line(sha), testing: { allowRunDirOverride: true, runDir: dir, now: NOW } });
   return { r, dir };
 }
 
@@ -85,11 +86,12 @@ test('riverwright guard pre-push blocks an unapproved commit and records why', a
 test('riverwright guard finds the run through git config riverwright.run', async () => {
   const repo = tmpDir();
   const dir = tmpDir();
-  let s = setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK);
-  saveState(dir, recordApproval(s, { gate: 'submit-gate', sha: A, mode: 'host-ask', now: 't', branch: 'riverwright/3509-codex' }));
+  const home = tmpDir('riverwright-home-');
+  saveState(dir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
+  armRun({ home, runDir: dir, sha: A, at: NOW });
   await runFile('git', ['init', '-q'], { cwd: repo });
   await runFile('git', ['config', 'riverwright.run', dir], { cwd: repo });
-  const r = await callMain(['guard', 'pre-push', 'fork', FORK], { stdin: line(A), cwd: repo, testing: { allowRunDirOverride: true, now: 't' } });
+  const r = await callMain(['guard', 'pre-push', '--home', home, '--', 'fork', FORK], { stdin: line(A), cwd: repo, testing: { allowRunDirOverride: true, now: NOW } });
   assert.equal(r.code, 0, r.stderr);
 });
 
@@ -112,9 +114,8 @@ async function workspace({ runId = 'ruvnet/ruflo#3509', approve = true } = {}) {
   fs.mkdirSync(worktree, { recursive: true });
   await runFile('git', ['init', '-q'], { cwd: worktree });
   const dir = path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509');
-  let s = setFork(createState({ runId, now: 't' }), FORK);
-  if (approve) s = recordApproval(s, { gate: 'submit-gate', sha: A, mode: 'tty', now: 't', branch: 'riverwright/3509-codex' });
-  saveState(dir, s);
+  saveState(dir, setFork(createState({ runId, now: 't' }), FORK));
+  if (approve) armRun({ home, runDir: dir, sha: A, run: 'ruvnet/ruflo#3509' });
   return { home, worktree, dir };
 }
 
@@ -139,7 +140,7 @@ test('a forged RIVERWRIGHT_RUN_DIR does not make the guard allow', async () => {
   const w = await workspace({ approve: false });
   const r2 = await callMain(['guard', 'pre-push', '--home', w.home, '--', 'fork', FORK], { stdin: line(A), cwd: w.worktree, env: { RIVERWRIGHT_RUN_DIR: await forgedRun() } });
   assert.notEqual(r2.code, 0);
-  assert.match(r2.stderr, /Nothing has been approved/);
+  assert.match(r2.stderr, /Nothing has been unlocked/);
 });
 
 test('a forged git config riverwright.run does not make the guard allow', async () => {
@@ -188,7 +189,8 @@ test('the guard finds the run from a linked worktree of the clone (git worktree
   const added = await git(clone, 'worktree', 'add', '-q', '-b', 'riverwright/3509-codex', worktree);
   assert.equal(added.code, 0, added.stderr);
   const dir = path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509');
-  saveState(dir, recordApproval(setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK), { gate: 'submit-gate', sha: A, mode: 'tty', now: 't', branch: 'riverwright/3509-codex' }));
+  saveState(dir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
+  armRun({ home, runDir: dir, sha: A });
   const r = await callMain(['guard', 'pre-push', '--home', home, '--', 'fork', FORK], { stdin: line(A), cwd: path.join(worktree) });
   assert.equal(r.code, 0, r.stderr);
 });
@@ -255,7 +257,8 @@ test('the guard finds the run with the environment git gives a pre-push hook in
   await git(clone, 'worktree', 'add', '-q', '-b', 'riverwright/3509-codex', worktree);
   const gitDir = (await git(worktree, 'rev-parse', '--absolute-git-dir')).stdout.trim();
   const dir = path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509');
-  saveState(dir, recordApproval(setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK), { gate: 'submit-gate', sha: A, mode: 'tty', now: 't', branch: 'riverwright/3509-codex' }));
+  saveState(dir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
+  armRun({ home, runDir: dir, sha: A });
   // Git runs hooks from the worktree root with GIT_DIR (and GIT_INDEX_FILE) exported, and no GIT_WORK_TREE.
   const hookEnv = { RIVERWRIGHT_TEST: '', RIVERWRIGHT_RUN_DIR: '', GIT_DIR: gitDir, GIT_INDEX_FILE: path.join(gitDir, 'index'), GIT_PREFIX: '' };
   const hookArgs = ['guard', 'pre-push', '--home', home, '--', 'fork', FORK];
diff --git a/tests/receipt-helpers.mjs b/tests/receipt-helpers.mjs
--- a/tests/receipt-helpers.mjs
+++ b/tests/receipt-helpers.mjs
@@ -24,3 +24,11 @@ export function issueReceipt({ runDir, keys, gate = 'submit-gate', run = 'ruvnet
 }
 
 export const runDirIn = (home, owner = 'ruvnet', repo = 'ruflo', n = 3509) => path.join(home, owner, repo, 'runs', `issue-${n}`);
+
+// A run that has been unlocked: a real vault under `home` and a signed, current receipt in the run's ledger.
+// The receipt is dated now unless `at` is given, for tests that do not pin the clock.
+export function armRun({ home, runDir, sha = 'a'.repeat(40), branch = 'riverwright/3509-codex', run = 'ruvnet/ruflo#3509', at = new Date().toISOString() }) {
+  const keys = makeTestVault(home);
+  issueReceipt({ runDir, keys, sha, branch, run, at });
+  return keys;
+}
diff --git a/tests/seams.test.mjs b/tests/seams.test.mjs
--- a/tests/seams.test.mjs
+++ b/tests/seams.test.mjs
@@ -7,6 +7,7 @@ import { recordApproval } from '../scripts/lib/approvals.mjs';
 import { readLedger } from '../scripts/lib/ledger.mjs';
 import { runFile } from '../scripts/lib/exec.mjs';
 import { callMain, runRiverwright, tmpDir, ROOT, RIVERWRIGHT } from './helpers.mjs';
+import { armRun } from './receipt-helpers.mjs';
 
 // Test seams live in io.testing, which only the in-process helper (callMain) supplies. These tests run
 // the real entry point with every variable the old seams read, set the way an agent would set them.
@@ -77,7 +78,7 @@ test('in a real process, the guard records the real time even with RIVERWRIGHT_T
     stdin: LINE, cwd: worktree, env: seamEnv(forgedRun()),
   });
   assert.notEqual(r.code, 0);
-  assert.match(r.stderr, /Nothing has been approved/);
+  assert.match(r.stderr, /Nothing has been unlocked/);
   const last = readLedger(dir).at(-1);
   assert.equal(last.decision, 'deny');
   assert.ok(recent(last.at), last.at);
@@ -104,6 +105,7 @@ test('io.testing is honored in process: now pins the clock and runDir is used on
   const home = tmpDir('riverwright-home-');
   const without = await callMain(['guard', 'pre-push', '--home', home, '--', 'fork', FORK], { stdin: LINE, cwd: repo, testing: { runDir: forged } });
   assert.notEqual(without.code, 0);
+  armRun({ home, runDir: forged, sha: A });
   const withOverride = await callMain(['guard', 'pre-push', '--home', home, '--', 'fork', FORK], { stdin: LINE, cwd: repo, testing: { runDir: forged, allowRunDirOverride: true } });
   assert.equal(withOverride.code, 0, withOverride.stderr);
 });
diff --git a/tests/workspace-home.test.mjs b/tests/workspace-home.test.mjs
--- a/tests/workspace-home.test.mjs
+++ b/tests/workspace-home.test.mjs
@@ -10,6 +10,7 @@ import { runFile, launcherHookCommand } from '../scripts/lib/exec.mjs';
 import { renderPrePushHook } from '../scripts/lib/guard.mjs';
 import { workspaceHomeFromArg } from '../scripts/lib/paths.mjs';
 import { callMain, runRiverwright, tmpDir, ROOT, RIVERWRIGHT } from './helpers.mjs';
+import { armRun } from './receipt-helpers.mjs';
 
 // The pre-push guard and the host hook take the workspace home from --home (the generated hook files
 // carry it) or the account's home directory; never from RIVERWRIGHT_HOME or HOME in the environment.
@@ -45,7 +46,8 @@ async function realAndForged({ forgedHome } = {}) {
 async function approvedWorkspace(home = tmpDir('riverwright-home-')) {
   fs.mkdirSync(worktreeOf(home), { recursive: true });
   await git(worktreeOf(home), 'init', '-q');
-  saveState(runDirOf(home), approved());
+  saveState(runDirOf(home), setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
+  armRun({ home, runDir: runDirOf(home), sha: A, branch: BRANCH });
   return { home, worktree: worktreeOf(home), dir: runDirOf(home) };
 }
 
```

Create the new test file:

`tests/guard-receipt.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createState, saveState, setFork } from '../scripts/lib/state.mjs';
import { recordApproval } from '../scripts/lib/approvals.mjs';
import { appendChained } from '../scripts/lib/events.mjs';
import { buildReceipt, markConsumed, signReceipt } from '../scripts/lib/receipt.mjs';
import { ledgerDirFor } from '../scripts/lib/ledger.mjs';
import { runFile } from '../scripts/lib/exec.mjs';
import { callMain, tmpDir } from './helpers.mjs';
import { armRun, issueReceipt, makeTestVault, runDirIn } from './receipt-helpers.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);
const FORK = 'https://github.com/pacphi/ruflo.git';
const BRANCH = 'riverwright/3509-codex';
const line = (sha, ref = `refs/heads/${BRANCH}`) => `refs/heads/${BRANCH} ${sha} ${ref} ${ZERO}\n`;

async function workspace() {
  const home = tmpDir('riverwright-home-');
  const worktree = path.join(home, 'ruvnet', 'ruflo', 'worktrees', 'issue-3509');
  fs.mkdirSync(worktree, { recursive: true });
  await runFile('git', ['init', '-q'], { cwd: worktree });
  const runDir = runDirIn(home);
  saveState(runDir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
  return { home, worktree, runDir };
}
const push = (w, sha = A, ref) => callMain(['guard', 'pre-push', '--home', w.home, '--', 'fork', FORK], { stdin: line(sha, ref), cwd: w.worktree });

test('a fresh receipt for the exact commit and branch lets the push through', async () => {
  const w = await workspace();
  armRun({ home: w.home, runDir: w.runDir, sha: A });
  const r = await push(w);
  assert.equal(r.code, 0, r.stderr);
});

test('an approval written into state.json is not consent: it never lets a push through', async () => {
  const w = await workspace();
  makeTestVault(w.home);
  saveState(w.runDir, recordApproval(setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK), { gate: 'submit-gate', sha: A, mode: 'unlock', now: 't', branch: BRANCH }));
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Nothing has been unlocked/);
});

test('without a vault nothing is allowed, and the reason says so', async () => {
  const w = await workspace();
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no sealed credential/);
});

test('a receipt signed by any other key is refused, even with a well-formed ledger', async () => {
  const w = await workspace();
  makeTestVault(w.home);
  const attacker = crypto.generateKeyPairSync('ed25519');
  appendChained(ledgerDirFor(w.runDir), ({ prev, seq }) => ({
    event: 'approved', at: new Date().toISOString(), actor: { type: 'human' }, run: 'ruvnet/ruflo#3509',
    data: { receipt: signReceipt(buildReceipt({ gate: 'submit-gate', run: 'ruvnet/ruflo#3509', binding: { kind: 'sha', value: A }, branch: BRANCH, ledgerHead: prev, seq, at: new Date().toISOString() }), attacker.privateKey) },
  }));
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /signature/);
});

test('a used receipt cannot be reused for a second push', async () => {
  const w = await workspace();
  const keys = armRun({ home: w.home, runDir: w.runDir, sha: A });
  const first = await push(w);
  assert.equal(first.code, 0, first.stderr);
  const nonce = JSON.parse(fs.readFileSync(path.join(ledgerDirFor(w.runDir), 'events.ndjson'), 'utf8').split('\n')[0]).data.receipt.nonce;
  markConsumed({ ledgerDir: ledgerDirFor(w.runDir), nonce, outcome: 'succeeded', at: new Date().toISOString() });
  const second = await push(w);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /already used/);
  assert.ok(keys);
});

test('an old receipt is refused', async () => {
  const w = await workspace();
  armRun({ home: w.home, runDir: w.runDir, sha: A, at: new Date(Date.now() - 11 * 60_000).toISOString() });
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /expired/);
});

test('a receipt for another commit, another branch or another run is refused', async () => {
  const w = await workspace();
  armRun({ home: w.home, runDir: w.runDir, sha: A });
  assert.notEqual((await push(w, B)).code, 0);
  assert.match((await push(w, A, 'refs/heads/riverwright/3509-other')).stderr, /approved branch/);
  const other = await workspace();
  makeTestVault(other.home);
  issueReceipt({ runDir: other.runDir, keys: makeTestVault(other.home), run: 'ruvnet/ruflo#1', sha: A, at: new Date().toISOString() });
  const r = await push(other);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no receipt for this gate and run/);
});

test('rewriting the ledger before the receipt makes the guard refuse', async () => {
  const w = await workspace();
  appendChained(ledgerDirFor(w.runDir), () => ({ event: 'note', at: new Date().toISOString(), actor: { type: 'agent' }, data: { n: 1 } }));
  armRun({ home: w.home, runDir: w.runDir, sha: A });
  const file = path.join(ledgerDirFor(w.runDir), 'events.ndjson');
  const ls = fs.readFileSync(file, 'utf8').trim().split('\n');
  const first = JSON.parse(ls[0]);
  first.data = { n: 2 };
  ls[0] = JSON.stringify(first);
  const second = JSON.parse(ls[1]);
  second.prev = `sha256:${crypto.createHash('sha256').update(ls[0]).digest('hex')}`;
  ls[1] = JSON.stringify(second);
  fs.writeFileSync(file, `${ls.join('\n')}\n`);
  const r = await push(w);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /ledger head/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/guard.test.mjs tests/seams.test.mjs tests/workspace-home.test.mjs tests/guard-receipt.test.mjs`

Expected: FAIL. Every test that expects an allow now fails because the guard still reads `state.json`, and the new `guard-receipt` tests fail for the same reason (19 failures in all).

- [ ] **Step 3: Write the implementation**

```diff
diff --git a/scripts/lib/commands/guard.mjs b/scripts/lib/commands/guard.mjs
--- a/scripts/lib/commands/guard.mjs
+++ b/scripts/lib/commands/guard.mjs
@@ -5,8 +5,9 @@ import { readAll } from '../io.mjs';
 import { runFile } from '../exec.mjs';
 import { workspaceHomeFromArg, isInside, realish, runDirForPath } from '../paths.mjs';
 import { loadState } from '../state.mjs';
-import { approvedSha, approvedBranch } from '../approvals.mjs';
-import { appendEvent } from '../ledger.mjs';
+import { appendEvent, ledgerDirFor } from '../ledger.mjs';
+import { readVault } from '../vault.mjs';
+import { findValidReceipt } from '../receipt.mjs';
 import { parsePrePushLines, decidePrePush } from '../guard.mjs';
 import { nowIso } from '../clock.mjs';
 
@@ -32,6 +33,15 @@ async function runFromRepository(io, home) {
   return dir ? { dir, runId: `${parts[0]}/${parts[1]}#${m[1]}` } : null;
 }
 
+function latestReceipt({ home, dir, runId, nowMs }) {
+  try {
+    const found = findValidReceipt({ ledgerDir: ledgerDirFor(dir), publicKey: readVault(home).publicKey, gate: 'submit-gate', run: runId, nowMs });
+    return found.ok ? { receipt: found.receipt, why: null } : { receipt: null, why: found.reason };
+  } catch (e) {
+    return { receipt: null, why: e.code === 'NO_VAULT' ? 'there is no sealed credential' : e.message };
+  }
+}
+
 const USAGE = 'usage: riverwright guard pre-push [--home <workspace>] -- <remote-name> <remote-url>';
 
 export async function run(args, io) {
@@ -62,7 +72,15 @@ export async function run(args, io) {
     io.stderr.write(`Riverwright blocked this push: ${reason}\n`);
     return 1;
   }
-  const decision = decidePrePush({ remoteUrl: destination, updates, forkUrl: state.fork?.url ?? null, approvedSha: approvedSha(state, 'submit-gate'), approvedBranch: approvedBranch(state, 'submit-gate') });
+  // Consent is a signed, unused, current receipt for this run in the ledger (ADR-0010), verified against the
+  // vault's public key. state.json is not consulted: an agent can write it.
+  const { receipt, why } = latestReceipt({ home, dir, runId: state.runId, nowMs: Date.parse(at) });
+  const decision = decidePrePush({
+    remoteUrl: destination, updates, forkUrl: state.fork?.url ?? null,
+    approvedSha: receipt?.binding.kind === 'sha' ? receipt.binding.value : null,
+    approvedBranch: receipt?.branch ?? null,
+  });
+  if (!decision.allow && why) decision.reason = `${decision.reason} (${why})`;
   appendEvent(dir, { type: 'guard', at, decision: decision.allow ? 'allow' : 'deny', reason: decision.reason, remoteUrl: destination });
   if (!decision.allow) {
     io.stderr.write(`Riverwright blocked this push: ${decision.reason}\n`);
diff --git a/scripts/lib/guard.mjs b/scripts/lib/guard.mjs
--- a/scripts/lib/guard.mjs
+++ b/scripts/lib/guard.mjs
@@ -20,14 +20,14 @@ export function decidePrePush({ remoteUrl, updates, forkUrl, approvedSha, approv
   if (!dest || dest !== normalizeRemoteUrl(forkUrl)) {
     return deny(`Push destination ${remoteUrl} is not your fork (${forkUrl}). Riverwright never pushes anywhere else.`);
   }
-  if (!approvedSha) return deny('Nothing has been approved at the submit gate yet.');
-  if (!approvedBranch) return deny('The submit-gate approval does not name a branch. Approve again with --branch riverwright/<number>-<slug>.');
+  if (!approvedSha) return deny('Nothing has been unlocked at the submit gate yet. Pushes happen only through "riverwright submit".');
+  if (!approvedBranch) return deny('The submit-gate receipt does not name a branch.');
   for (const u of updates) {
     if (!u.localSha || ZERO.test(u.localSha)) return deny(`Deleting ${u.remoteRef} is not allowed.`);
     if (!String(u.remoteRef).startsWith('refs/heads/riverwright/')) return deny(`Only branches named riverwright/… may be pushed (got ${u.remoteRef}).`);
     if (u.remoteRef !== `refs/heads/${approvedBranch}`) return deny(`Only the approved branch ${approvedBranch} may be pushed (got ${u.remoteRef}).`);
     if (u.localSha.toLowerCase() !== approvedSha) {
-      return deny(`Commit ${u.localSha.slice(0, 12)} is not the approved commit ${approvedSha.slice(0, 12)}. Approve the new commit first.`);
+      return deny(`Commit ${u.localSha.slice(0, 12)} is not the approved commit ${approvedSha.slice(0, 12)}. Run "riverwright submit" again to approve the new commit.`);
     }
   }
   return { allow: true, reason: 'approved push to your fork' };
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/guard.test.mjs tests/seams.test.mjs tests/workspace-home.test.mjs tests/guard-receipt.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/commands/guard.mjs scripts/lib/guard.mjs tests/receipt-helpers.mjs tests/guard.test.mjs tests/seams.test.mjs tests/workspace-home.test.mjs tests/guard-receipt.test.mjs
git commit -m "feat(security): the pre-push guard trusts a signed receipt, not state.json"
```

### Task 9: `riverwright approve` handles `checkpoint-1` only

Spec §6. The public gates are approved by the unlock inside `submit` and `post`. `approve` refuses them with a message that says where to go, and the retired flags `--branch` and `--allow-host-ask-submit` are no longer accepted.

**Files:**

- Modify: `scripts/lib/commands/approve.mjs` (rewritten)
- Modify (tests): `tests/state-cli.test.mjs`

**Interfaces:**

- Consumes: `PUBLIC_GATES` (`receipt.mjs`), `makeBinding`, `recordApproval`, `appendEvent`.
- Produces: `riverwright approve checkpoint-1 --run DIR (--sha SHA | --content-file FILE) [--mode host-ask|tty] [--host ID]`. Any public gate exits 1 with `USE_UNLOCK` and records nothing. The approval event is written with `actor: { type: 'human' }`.

- [ ] **Step 1: Write the failing tests**

Apply this patch to `tests/state-cli.test.mjs`. It replaces the tests that described the submit-gate flow:

```diff
diff --git a/tests/state-cli.test.mjs b/tests/state-cli.test.mjs
--- a/tests/state-cli.test.mjs
+++ b/tests/state-cli.test.mjs
@@ -2,7 +2,8 @@ import { test } from 'node:test';
 import assert from 'node:assert/strict';
 import { callMain, fakeTerminal, tmpDir } from './helpers.mjs';
 import { loadState } from '../scripts/lib/state.mjs';
-import { readLedger } from '../scripts/lib/ledger.mjs';
+import { ledgerDirFor, readLedger } from '../scripts/lib/ledger.mjs';
+import { readEvents } from '../scripts/lib/events.mjs';
 
 const A = 'a'.repeat(40);
 // The run is named with --run, as a human would; the clock is pinned through the in-process test seam.
@@ -30,46 +31,57 @@ test('riverwright state refuses an illegal transition with a clear message', asy
 test('riverwright approve in tty mode records only after the human types the short SHA', async () => {
   const dir = tmpDir();
   await rw(dir, ['state', 'create', '--id', 'o/r#1']);
-  const wrong = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x', '--mode', 'tty'], { terminal: fakeTerminal('yes') });
+  const wrong = await rw(dir, ['approve', 'checkpoint-1', '--sha', A, '--mode', 'tty'], { terminal: fakeTerminal('yes') });
   assert.equal(wrong.code, 1);
   assert.equal(loadState(dir).approvals.length, 0);
-  const right = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x', '--mode', 'tty'], { terminal: fakeTerminal('aaaaaaa') });
+  const right = await rw(dir, ['approve', 'checkpoint-1', '--sha', A, '--mode', 'tty'], { terminal: fakeTerminal('aaaaaaa') });
   assert.equal(right.code, 0, right.stderr);
   assert.equal(loadState(dir).approvals[0].binding.value, A);
   assert.equal(readLedger(dir).at(-1).type, 'approval');
 });
 
-test('the submit gate defaults to terminal approval', async () => {
+test('host-ask is the default for checkpoint-1', async () => {
   const dir = tmpDir();
   await rw(dir, ['state', 'create', '--id', 'o/r#1']);
-  const terminal = fakeTerminal('aaaaaaa');
-  const r = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x'], { terminal });
+  const r = await rw(dir, ['approve', 'checkpoint-1', '--sha', A]);
   assert.equal(r.code, 0, r.stderr);
-  assert.match(terminal.written.join(''), /Approve submit-gate/);
-  assert.equal(loadState(dir).approvals[0].mode, 'tty');
+  assert.equal(loadState(dir).approvals[0].mode, 'host-ask');
+  assert.equal(readEvents(ledgerDirFor(dir)).at(-1).actor.type, 'human');
 });
 
-test('host-ask is refused for the submit gate unless explicitly allowed', async () => {
+// The public gates are approved by the unlock inside submit and post (ADR-0010), so approve refuses them and
+// tells the human where to go. Nothing is recorded, whatever flags or terminal are supplied.
+test('approve refuses every public gate and points at submit and post', async () => {
   const dir = tmpDir();
   await rw(dir, ['state', 'create', '--id', 'o/r#1']);
-  const refused = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x', '--mode', 'host-ask']);
-  assert.equal(refused.code, 1);
-  assert.match(refused.stderr, /--allow-host-ask-submit/);
-  // RIVERWRIGHT_APPROVAL_MODE no longer selects host-ask: the gate stays in the terminal, and a wrong answer records nothing.
-  const viaEnv = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x'], { env: { RIVERWRIGHT_APPROVAL_MODE: 'host-ask' }, terminal: fakeTerminal('no') });
-  assert.equal(viaEnv.code, 1);
-  assert.match(viaEnv.stderr, /Not approved/);
+  for (const gate of ['submit-gate', 'post-issue', 'post-comment']) {
+    const r = await rw(dir, ['approve', gate, '--sha', A], { terminal: fakeTerminal('aaaaaaa') });
+    assert.equal(r.code, 1, gate);
+    assert.match(r.stderr, /riverwright submit|riverwright post/, gate);
+    assert.match(r.stderr, /unlock/, gate);
+  }
   assert.equal(loadState(dir).approvals.length, 0);
-  const ok = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x', '--mode', 'host-ask', '--allow-host-ask-submit']);
-  assert.equal(ok.code, 0, ok.stderr);
-  assert.equal(loadState(dir).approvals[0].mode, 'host-ask');
 });
 
-test('host-ask stays the default for checkpoint-1 and posts', async () => {
+test('the retired flags --branch and --allow-host-ask-submit are no longer accepted', async () => {
   const dir = tmpDir();
   await rw(dir, ['state', 'create', '--id', 'o/r#1']);
-  const r = await rw(dir, ['approve', 'checkpoint-1', '--sha', A]);
+  for (const flag of [['--branch', 'riverwright/1-x'], ['--allow-host-ask-submit']]) {
+    const r = await rw(dir, ['approve', 'checkpoint-1', '--sha', A, ...flag]);
+    assert.equal(r.code, 1, flag.join(' '));
+  }
+  assert.equal(loadState(dir).approvals.length, 0);
+});
+
+// Environment variables never change the mode: checkpoint-1 stays host-ask, and a tty prompt is opened only
+// by --mode tty on the command line.
+test('RIVERWRIGHT_APPROVAL_MODE in the environment does not change approval', async () => {
+  const dir = tmpDir();
+  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
+  const terminal = fakeTerminal('no');
+  const r = await rw(dir, ['approve', 'checkpoint-1', '--sha', A], { env: { RIVERWRIGHT_APPROVAL_MODE: 'tty' }, terminal });
   assert.equal(r.code, 0, r.stderr);
+  assert.equal(terminal.written.join(''), '');
   assert.equal(loadState(dir).approvals[0].mode, 'host-ask');
 });
 
@@ -87,50 +99,3 @@ test('--host must be a known host id', async () => {
   const ok = await rw(dir, ['state', 'begin', 'start', '--host', 'codex']);
   assert.equal(ok.code, 0, ok.stderr);
 });
-
-test('approving the submit gate needs the run branch, and records it', async () => {
-  const dir = tmpDir();
-  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
-  const missing = await rw(dir, ['approve', 'submit-gate', '--sha', A], { terminal: fakeTerminal('aaaaaaa') });
-  assert.equal(missing.code, 1);
-  assert.match(missing.stderr, /--branch/);
-  const terminal = fakeTerminal('aaaaaaa');
-  const ok = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-fix'], { terminal });
-  assert.equal(ok.code, 0, ok.stderr);
-  assert.match(terminal.written.join(''), /riverwright\/1-fix/);
-  assert.equal(loadState(dir).approvals[0].branch, 'riverwright/1-fix');
-});
-
-// The switches that weaken the submit gate are command-line flags, so they appear in the command the
-// host shows in its permission prompt. Environment variables alone change nothing.
-test('RIVERWRIGHT_APPROVAL_MODE and RIVERWRIGHT_ALLOW_HOST_ASK_SUBMIT in the environment do not change approval', async () => {
-  const dir = tmpDir();
-  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
-  const weak = { RIVERWRIGHT_APPROVAL_MODE: 'host-ask', RIVERWRIGHT_ALLOW_HOST_ASK_SUBMIT: '1' };
-  const terminal = fakeTerminal('aaaaaaa');
-  const r = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x'], { env: weak, terminal });
-  assert.equal(r.code, 0, r.stderr);
-  assert.match(terminal.written.join(''), /Approve submit-gate/);
-  assert.equal(loadState(dir).approvals[0].mode, 'tty');
-  const refused = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x', '--mode', 'host-ask'], { env: weak, terminal: fakeTerminal('aaaaaaa') });
-  assert.equal(refused.code, 1);
-  assert.match(refused.stderr, /--allow-host-ask-submit/);
-  assert.equal(loadState(dir).approvals.length, 1);
-  const cp = fakeTerminal('no');
-  const checkpoint = await rw(dir, ['approve', 'checkpoint-1', '--sha', A], { env: { RIVERWRIGHT_APPROVAL_MODE: 'tty' }, terminal: cp });
-  assert.equal(checkpoint.code, 0, checkpoint.stderr);
-  assert.equal(cp.written.join(''), '');
-  assert.equal(loadState(dir).approvals[1].mode, 'host-ask');
-});
-
-test('--allow-host-ask-submit on the command line permits host-ask for the submit gate, and only there', async () => {
-  const dir = tmpDir();
-  await rw(dir, ['state', 'create', '--id', 'o/r#1']);
-  const ok = await rw(dir, ['approve', 'submit-gate', '--sha', A, '--branch', 'riverwright/1-x', '--mode', 'host-ask', '--allow-host-ask-submit']);
-  assert.equal(ok.code, 0, ok.stderr);
-  assert.equal(loadState(dir).approvals[0].mode, 'host-ask');
-  const misplaced = await rw(dir, ['approve', 'checkpoint-1', '--sha', A, '--allow-host-ask-submit']);
-  assert.equal(misplaced.code, 1);
-  assert.match(misplaced.stderr, /applies only to the submit gate/);
-  assert.equal(loadState(dir).approvals.length, 1);
-});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/state-cli.test.mjs`

Expected: FAIL, 2 tests: `approve refuses every public gate and points at submit and post` and `host-ask is the default for checkpoint-1` (the actor is not yet `human`).

- [ ] **Step 3: Write the implementation**

`scripts/lib/commands/approve.mjs`:

```js
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { RiverwrightError } from '../errors.mjs';
import { makeBinding, recordApproval } from '../approvals.mjs';
import { loadState, saveState } from '../state.mjs';
import { appendEvent } from '../ledger.mjs';
import { openTerminal, confirmTyped } from '../tty.mjs';
import { nowIso } from '../clock.mjs';
import { assertHost } from '../hosts.mjs';
import { PUBLIC_GATES } from '../receipt.mjs';

// Only checkpoint-1, which publishes nothing, is approved here. The public gates are approved by the
// passphrase unlock inside `riverwright submit` and `riverwright post` (ADR-0010), so a record an agent
// can write is never what lets something out. The mode is a command-line flag, so it appears in the
// command the human sees in the host's permission prompt; no environment variable changes it.
const MODES = ['host-ask', 'tty'];

export async function run(args, io) {
  const [gate, ...rest] = args;
  if (PUBLIC_GATES.includes(gate)) {
    const via = gate === 'submit-gate' ? 'riverwright submit' : 'riverwright post';
    throw new RiverwrightError('USE_UNLOCK', `${gate} is approved by the passphrase unlock inside "${via}", not by "riverwright approve". Run "${via}" in a terminal.`);
  }
  if (gate !== 'checkpoint-1') throw new RiverwrightError('UNKNOWN_GATE', `unknown gate "${gate}": "riverwright approve" handles checkpoint-1 only`);
  const { values } = parseArgs({
    args: rest,
    options: { run: { type: 'string' }, sha: { type: 'string' }, 'content-file': { type: 'string' }, mode: { type: 'string' }, host: { type: 'string' } },
  });
  // The run is named on the command line, where the human sees it; no environment variable chooses it.
  const dir = values.run;
  if (!dir) throw new RiverwrightError('NO_RUN', 'pass --run <run directory>');
  const host = assertHost(values.host ?? null);
  const mode = values.mode ?? 'host-ask';
  if (!MODES.includes(mode)) throw new RiverwrightError('UNKNOWN_MODE', `unknown approval mode "${mode}" (use host-ask or tty)`);
  const now = nowIso(io);
  const content = values['content-file'] !== undefined ? fs.readFileSync(values['content-file'], 'utf8') : undefined;
  const binding = makeBinding({ sha: values.sha, content });
  const state = loadState(dir);
  if (mode === 'tty') {
    const terminal = io.openTerminal ? io.openTerminal() : openTerminal({ platform: io.platform });
    const expected = binding.kind === 'sha' ? binding.value.slice(0, 7) : 'yes';
    const what = binding.kind === 'sha' ? `commit ${binding.value}` : `content ${binding.value}`;
    const how = binding.kind === 'sha' ? 'the first 7 characters of the commit' : 'yes';
    const ok = await confirmTyped({ terminal, question: `Approve ${gate} for ${state.runId} (${what})?\nType ${how} to approve: `, expected });
    if (!ok) {
      io.stderr.write('Not approved. Nothing was recorded.\n');
      return 1;
    }
  }
  saveState(dir, recordApproval(state, { gate, sha: values.sha, content, mode, host, now }));
  appendEvent(dir, { type: 'approval', at: now, actor: { type: 'human' }, gate, binding, mode, host });
  io.stdout.write(`Approved ${gate} for ${state.runId}: ${binding.kind} ${binding.value}\n`);
  return 0;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test tests/state-cli.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/commands/approve.mjs tests/state-cli.test.mjs
git commit -m "feat(security): approve handles checkpoint-1 only; public gates are approved by the unlock"
```

### Task 10: `ledger verify` checks receipt signatures

Spec §7.5 and thread-record §13: "`ledger verify` checks the chain, the signatures and that no nonce was used twice." The vault sits at the workspace home: `--home`, else the home a run directory's layout implies, else `RIVERWRIGHT_HOME`.

**Files:**

- Modify: `scripts/lib/commands/ledger.mjs`
- Modify (tests): `tests/ledger-cli.test.mjs`

**Interfaces:**

- Consumes: `readVault`, `verifyReceipts`, `readEvents`, `riverwrightHome`.
- Produces: `riverwright ledger verify --run DIR [--home DIR] [--head sha256:HEX] [--seq N]` also verifies every `approved` event against the vault's public key. Without a vault it still checks the chain and says signatures were not checked.

- [ ] **Step 1: Write the failing tests**

```diff
diff --git a/tests/ledger-cli.test.mjs b/tests/ledger-cli.test.mjs
--- a/tests/ledger-cli.test.mjs
+++ b/tests/ledger-cli.test.mjs
@@ -56,3 +56,40 @@ test('ledger verify accepts an anchored head and seq, and fails when they no lon
   assert.equal(cut.code, 1);
   assert.match(cut.stderr, /truncated/);
 });
+
+// Receipts: verify checks each `approved` event against the vault's public key.
+import crypto from 'node:crypto';
+import { appendChained } from '../scripts/lib/events.mjs';
+import { buildReceipt, signReceipt } from '../scripts/lib/receipt.mjs';
+import { armRun } from './receipt-helpers.mjs';
+
+test('ledger verify checks receipt signatures against the vault and reports how many it checked', async () => {
+  const home = tmpDir();
+  const runDir = path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509');
+  armRun({ home, runDir });
+  const r = await callMain(['ledger', 'verify', '--run', runDir]);
+  assert.equal(r.code, 0, r.stderr);
+  assert.match(r.stdout, /1 receipt signature checked/);
+});
+
+test('ledger verify fails on a receipt signed by another key', async () => {
+  const home = tmpDir();
+  const runDir = path.join(home, 'ruvnet', 'ruflo', 'runs', 'issue-3509');
+  armRun({ home, runDir });
+  const attacker = crypto.generateKeyPairSync('ed25519');
+  appendChained(ledgerDirFor(runDir), ({ prev, seq }) => ({
+    event: 'approved', at: 't', actor: { type: 'human' },
+    data: { receipt: signReceipt(buildReceipt({ gate: 'post-comment', run: 'ruvnet/ruflo#3509', binding: { kind: 'content', value: `sha256:${'c'.repeat(64)}` }, ledgerHead: prev, seq, at: 't' }), attacker.privateKey) },
+  }));
+  const r = await callMain(['ledger', 'verify', '--run', runDir]);
+  assert.equal(r.code, 1);
+  assert.match(r.stderr, /signature/);
+});
+
+test('without a vault, verify still checks the chain and says signatures were not checked', async () => {
+  const dir = tmpDir();
+  appendEvent(dir, { type: 'note', at: 't' });
+  const r = await callMain(['ledger', 'verify', '--run', dir], { env: { RIVERWRIGHT_HOME: tmpDir() } });
+  assert.equal(r.code, 0, r.stderr);
+  assert.match(r.stdout, /signatures were not checked/);
+});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/ledger-cli.test.mjs`

Expected: FAIL, 3 tests (the three new receipt tests).

- [ ] **Step 3: Write the implementation**

`scripts/lib/commands/ledger.mjs`:

```js
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RiverwrightError } from '../errors.mjs';
import { ledgerDirFor } from '../ledger.mjs';
import { readEvents, verifyChain } from '../events.mjs';
import { readVault } from '../vault.mjs';
import { verifyReceipts } from '../receipt.mjs';
import { riverwrightHome } from '../paths.mjs';

const USAGE = 'usage: riverwright ledger verify --run <run directory> [--home <workspace>] [--head sha256:<hex>] [--seq <n>]';

export async function run(args, io) {
  const [sub, ...rest] = args;
  if (sub !== 'verify') throw new RiverwrightError('USAGE', USAGE);
  const { values } = parseArgs({ args: rest, options: { run: { type: 'string' }, home: { type: 'string' }, head: { type: 'string' }, seq: { type: 'string' } } });
  if (!values.run) throw new RiverwrightError('NO_RUN', 'pass --run <run directory>');
  if (values.head !== undefined && !/^sha256:[0-9a-f]{64}$/.test(values.head)) throw new RiverwrightError('USAGE', '--head must look like sha256:<64 hex digits>');
  if (values.seq !== undefined && !/^[1-9]\d*$/.test(values.seq)) throw new RiverwrightError('USAGE', '--seq must be a positive whole number');
  const ledgerDir = ledgerDirFor(values.run);
  const result = verifyChain(ledgerDir, { expectHead: values.head ?? null, expectSeq: values.seq === undefined ? null : Number(values.seq) });
  // The vault sits at the workspace home: --home, else the home a run directory's layout implies
  // (<home>/<owner>/<repo>/runs/issue-<n>), else RIVERWRIGHT_HOME (a person runs this command).
  const runDir = path.resolve(values.run);
  const inLayout = path.basename(path.dirname(runDir)) === 'runs';
  const home = values.home ? path.resolve(values.home) : inLayout ? path.dirname(path.dirname(path.dirname(path.dirname(runDir)))) : riverwrightHome(io.env);
  let receipts = null;
  try {
    const publicKey = readVault(home).publicKey;
    receipts = readEvents(ledgerDir).filter((e) => e.event === 'approved' && e.data?.receipt).length;
    result.problems.push(...verifyReceipts({ ledgerDir, publicKey }));
    result.ok = result.problems.length === 0;
  } catch (e) {
    if (e.code !== 'NO_VAULT') throw e;
  }
  if (!result.ok) {
    const [first] = result.problems;
    io.stderr.write(`Ledger check failed at line ${first.line}: ${first.reason}\n`);
    if (result.problems.length > 1) io.stderr.write(`(${result.problems.length - 1} more problem${result.problems.length === 2 ? '' : 's'} follow)\n`);
    return 1;
  }
  const checked = receipts === null ? 'No vault found here, so receipt signatures were not checked.' : `${receipts} receipt signature${receipts === 1 ? '' : 's'} checked against the vault key.`;
  io.stdout.write(`Ledger intact: ${result.count} events, seq ${result.seq}, head ${result.head}\n${checked}\n`);
  return 0;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test tests/ledger-cli.test.mjs`

Expected: PASS, 8 tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/commands/ledger.mjs tests/ledger-cli.test.mjs
git commit -m "feat(ledger): ledger verify checks receipt signatures against the vault key"
```

### Task 11: Hooks — deny `riverwright credential`, and always carry `--home`

Spec §7.2 and §7.5. Sealing, replacing or removing the credential is something the human does in their own terminal, so an agent's shell command that names it is denied in any spelling (inside the workspace, like every other Lock 2 rule). Generated hook commands can no longer be built without `--home`. Limiting a hook to shell tools only needs each host's verified matcher, which belongs to the adapter generator in Plan 2c.

**Files:**

- Modify: `scripts/lib/hooks/classify.mjs`, `scripts/lib/exec.mjs`
- Modify (tests): `tests/exec.test.mjs`
- Create (test): `tests/hook-credential.test.mjs`

**Interfaces:**

- Consumes: `outward`, `isDynamic`, `nameOf`, `base` (already in `classify.mjs`).
- Produces: `classifyCommand` returns `{ outward: true, rule: 'riverwright-credential' }` for `riverwright credential ...` (also `rw`, an absolute path, or `node .../riverwright.mjs`). `launcherHookCommand(root, host, { platform?, shell?, home })` throws `NO_HOME` when `home` is missing or blank; the command always ends with `--home "<home>"`.

- [ ] **Step 1: Write the failing tests**

`tests/hook-credential.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand } from '../scripts/lib/hooks/classify.mjs';

// Sealing, replacing or removing the credential is something the human does in their own terminal.
const DENIED = [
  'riverwright credential setup',
  'rw credential remove',
  '/usr/local/bin/riverwright credential setup --replace',
  'node /opt/riverwright/scripts/riverwright.mjs credential setup',
  'RIVERWRIGHT_HOME=/tmp/x riverwright credential status',
  'cd /tmp && riverwright credential setup',
  'echo ok; rw credential setup',
  'bash -c "riverwright credential setup"',
  'sudo -u me riverwright credential setup',
  'riverwright.cmd credential remove',
];
const ALLOWED = [
  'riverwright ledger verify --run /tmp/x',
  'riverwright state get --run /tmp/x',
  'git commit -m "rotate credential handling"',
  'echo credential',
  'grep -r credential src',
  'npm test',
];

test('the hook denies an agent shell command that runs riverwright credential in any spelling', () => {
  for (const c of DENIED) {
    const v = classifyCommand(c);
    assert.equal(v.outward, true, c);
    // Setting RIVERWRIGHT_HOME is refused first by the stricter riverwright-env rule; either way it is denied.
    if (!c.startsWith('RIVERWRIGHT_HOME=')) assert.equal(v.rule, 'riverwright-credential', c);
  }
});

test('other riverwright commands and unrelated uses of the word are not blocked by that rule', () => {
  for (const c of ALLOWED) assert.equal(classifyCommand(c).outward, false, c);
});
```

Apply this patch to `tests/exec.test.mjs`:

```diff
diff --git a/tests/exec.test.mjs b/tests/exec.test.mjs
--- a/tests/exec.test.mjs
+++ b/tests/exec.test.mjs
@@ -77,7 +77,7 @@ test('buildHookCommand quotes paths with spaces and refuses unsafe paths', () =>
 const posixOnly = { skip: process.platform === 'win32' };
 
 test('launcherHookCommand goes through the launcher, which denies (exit 2) when node is missing', posixOnly, () => {
-  const cmd = launcherHookCommand(ROOT, 'claude-code', { platform: 'darwin' });
+  const cmd = launcherHookCommand(ROOT, 'claude-code', { platform: 'darwin', home: tmpDir('riverwright-home-') });
   const r = spawnSync('/bin/sh', ['-c', cmd], { input: '{}', encoding: 'utf8', env: { PATH: '/nonexistent' } });
   assert.equal(r.status, 2, `${cmd}\n${r.stderr}`);
   assert.match(r.stderr, /needs Node\.js 24/);
@@ -91,20 +91,20 @@ test('launcherHookCommand runs the hook when node is present', posixOnly, () =>
 
 test('launcherHookCommand quotes paths with spaces for sh, cmd and PowerShell', () => {
   assert.equal(
-    launcherHookCommand('/Users/Jane Doe/Library/Application Support/riverwright', 'claude-code', { platform: 'darwin' }),
-    '/bin/sh "/Users/Jane Doe/Library/Application Support/riverwright/bin/riverwright" hook claude-code',
+    launcherHookCommand('/Users/Jane Doe/Library/Application Support/riverwright', 'claude-code', { platform: 'darwin', home: '/Users/Jane Doe/.riverwright' }),
+    '/bin/sh "/Users/Jane Doe/Library/Application Support/riverwright/bin/riverwright" hook claude-code --home "/Users/Jane Doe/.riverwright"',
   );
   assert.equal(
-    launcherHookCommand('C:\\Program Files\\riverwright', 'cursor', { platform: 'win32' }),
-    '"C:\\Program Files\\riverwright\\bin\\riverwright.cmd" hook cursor',
+    launcherHookCommand('C:\\Program Files\\riverwright', 'cursor', { platform: 'win32', home: 'C:\\Users\\Jane Doe\\.riverwright' }),
+    '"C:\\Program Files\\riverwright\\bin\\riverwright.cmd" hook cursor --home "C:\\Users\\Jane Doe\\.riverwright"',
   );
   assert.equal(
-    launcherHookCommand('C:\\Program Files\\riverwright', 'codex', { platform: 'win32', shell: 'powershell' }),
-    String.raw`$ErrorActionPreference = 'Stop'; try { $global:LASTEXITCODE = $null; & "C:\Program Files\riverwright\bin\riverwright.cmd" hook codex; if ($null -eq $LASTEXITCODE) { exit 2 }; exit $LASTEXITCODE } catch { exit 2 }`,
+    launcherHookCommand('C:\\Program Files\\riverwright', 'codex', { platform: 'win32', shell: 'powershell', home: 'C:\\Users\\Jane Doe\\.riverwright' }),
+    String.raw`$ErrorActionPreference = 'Stop'; try { $global:LASTEXITCODE = $null; & "C:\Program Files\riverwright\bin\riverwright.cmd" hook codex --home "C:\Users\Jane Doe\.riverwright"; if ($null -eq $LASTEXITCODE) { exit 2 }; exit $LASTEXITCODE } catch { exit 2 }`,
   );
   assert.equal(
-    launcherHookCommand('C:\\Program Files\\riverwright', 'claude-code', { platform: 'win32', shell: 'sh' }),
-    '/bin/sh "C:/Program Files/riverwright/bin/riverwright" hook claude-code',
+    launcherHookCommand('C:\\Program Files\\riverwright', 'claude-code', { platform: 'win32', shell: 'sh', home: 'C:\\Users\\Jane Doe\\.riverwright' }),
+    '/bin/sh "C:/Program Files/riverwright/bin/riverwright" hook claude-code --home "C:/Users/Jane Doe/.riverwright"',
   );
 });
 
@@ -116,8 +116,15 @@ test('launcherHookCommand refuses relative and unquotable roots, unknown hosts a
   assert.throws(() => launcherHookCommand('/a/riverwright', 'codex', { platform: 'linux', shell: 'fish' }), /unknown shell/);
 });
 
+test('a generated hook command must carry --home: without it nothing is generated', () => {
+  for (const home of [undefined, null, '', '   ']) {
+    assert.throws(() => launcherHookCommand('/a/riverwright', 'codex', { platform: 'linux', home }), (e) => e.code === 'NO_HOME' && /--home/.test(e.message), JSON.stringify(home));
+    assert.throws(() => launcherHookCommand('C:\\rw', 'codex', { platform: 'win32', shell: 'powershell', home }), /--home/, JSON.stringify(home));
+  }
+});
+
 test('Windows launcher hook command denies (exit 2) under cmd when node is missing', { skip: process.platform !== 'win32' }, () => {
-  const cmd = launcherHookCommand(ROOT, 'claude-code', { platform: 'win32' });
+  const cmd = launcherHookCommand(ROOT, 'claude-code', { platform: 'win32', home: tmpDir('riverwright-home-') });
   const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], {
     input: '{}', encoding: 'utf8', windowsVerbatimArguments: true, env: { PATH: 'C:\\nonexistent', SystemRoot: process.env.SystemRoot },
   });
@@ -125,7 +132,7 @@ test('Windows launcher hook command denies (exit 2) under cmd when node is missi
 });
 
 test('Windows launcher hook command denies (exit 2) under PowerShell when node is missing', { skip: process.platform !== 'win32' }, () => {
-  const cmd = launcherHookCommand(ROOT, 'codex', { platform: 'win32', shell: 'powershell' });
+  const cmd = launcherHookCommand(ROOT, 'codex', { platform: 'win32', shell: 'powershell', home: tmpDir('riverwright-home-') });
   const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
   // PowerShell starts a .cmd through cmd.exe, which it finds via ComSpec; node stays absent.
   const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], {
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/hook-credential.test.mjs tests/exec.test.mjs`

Expected: FAIL, 2 tests: `the hook denies an agent shell command that runs riverwright credential in any spelling` and `a generated hook command must carry --home: without it nothing is generated`.

- [ ] **Step 3: Write the implementation**

```diff
diff --git a/scripts/lib/exec.mjs b/scripts/lib/exec.mjs
--- a/scripts/lib/exec.mjs
+++ b/scripts/lib/exec.mjs
@@ -99,27 +99,29 @@ export function powershellFailClosed(invocation) {
 // The hook command a host runs. It goes through bin/riverwright or bin/riverwright.cmd, which exit 2 (deny) when node
 // is missing. `shell` is the shell the host runs hook commands with: sh (POSIX, Git Bash), cmd, or
 // PowerShell (whose -Command turns native exit codes other than 0/1 into 1 unless passed through).
-// `home` is written into the command as --home, so the hook's workspace is fixed when the adapter is
-// generated and never read from the environment; without it the hook uses the account's ~/.riverwright.
+// `home` is required and is written into the command as --home, so the hook's workspace is fixed when the
+// adapter is generated and never read from the environment.
 export function launcherHookCommand(root, host, { platform = process.platform, shell, home } = {}) {
   if (!HOSTS.includes(host)) throw new RiverwrightError('UNKNOWN_HOST', `unknown host "${host}"`);
   const r = String(root);
   assertQuotablePath(r, 'plugin root');
   const sh = shell ?? (platform === 'win32' ? 'cmd' : 'sh');
   if (!HOOK_SHELLS.includes(sh)) throw new RiverwrightError('UNKNOWN_SHELL', `unknown shell "${sh}" (use ${HOOK_SHELLS.join(', ')})`);
-  let h = null;
-  if (home !== undefined && home !== null) {
-    // A trailing backslash would escape the closing quote for the Windows argument parser.
-    h = String(home).replace(/[\\/]+$/, '');
-    assertQuotablePath(h, 'workspace home');
+  // A generated hook always carries --home, so its workspace is fixed when the adapter is written and no
+  // default (the account's ~/.riverwright, or anything in the environment) is ever assumed.
+  if (home === undefined || home === null || String(home).trim() === '') {
+    throw new RiverwrightError('NO_HOME', 'a generated hook command must carry --home <workspace>');
   }
+  // A trailing backslash would escape the closing quote for the Windows argument parser.
+  const h = String(home).replace(/[\\/]+$/, '');
+  assertQuotablePath(h, 'workspace home');
   if (sh === 'sh') {
     // /bin/sh runs the launcher even if the plugin cache dropped its executable bit.
     const launcher = `${r.replace(/\\/g, '/').replace(/\/+$/, '')}/bin/riverwright`;
-    return `/bin/sh "${launcher}" hook ${host}${h === null ? '' : ` --home "${h.replace(/\\/g, '/')}"`}`;
+    return `/bin/sh "${launcher}" hook ${host} --home "${h.replace(/\\/g, '/')}"`;
   }
   const launcher = `${r.replace(/\//g, '\\').replace(/\\+$/, '')}\\bin\\riverwright.cmd`;
-  const homeArg = h === null ? '' : ` --home "${h}"`;
+  const homeArg = ` --home "${h}"`;
   if (sh === 'cmd') return `"${launcher}" hook ${host}${homeArg}`;
   return powershellFailClosed(`& "${launcher}" hook ${host}${homeArg}`);
 }
diff --git a/scripts/lib/hooks/classify.mjs b/scripts/lib/hooks/classify.mjs
--- a/scripts/lib/hooks/classify.mjs
+++ b/scripts/lib/hooks/classify.mjs
@@ -341,6 +341,22 @@ function classifyInvocation(words, cmd, ctx) {
   return null;
 }
 
+// "riverwright credential ..." seals, replaces or removes the credential. The human runs it in their own
+// terminal, so an agent's shell command that names it is denied in any spelling: the launcher, an absolute
+// path, "rw", or node running scripts/riverwright.mjs. A literal "credential" argument after such a program
+// is enough, so a command that merely mentions the word for another program is left alone.
+const RIVERWRIGHT_PROGRAM = /^(?:riverwright|rw)(?:\.mjs)?$/;
+
+function classifyRiverwrightCredential(words) {
+  for (let j = 0; j < words.length; j += 1) {
+    if (isDynamic(words[j]) || !RIVERWRIGHT_PROGRAM.test(base(nameOf(words[j])))) continue;
+    if (words.slice(j + 1).some((w) => !isDynamic(w) && nameOf(w) === 'credential')) {
+      return outward('riverwright-credential', 'riverwright credential (sealing or removing your credential is something you do yourself, in your own terminal)');
+    }
+  }
+  return null;
+}
+
 function classifySimple(cmd, ctx) {
   const all = [...cmd.words, ...cmd.redirects, ...cmd.herestrings];
   // Substitutions run before the command itself.
@@ -367,6 +383,8 @@ function classifySimple(cmd, ctx) {
     break;
   }
   if (i < cmd.words.length) {
+    const c = classifyRiverwrightCredential(cmd.words.slice(i));
+    if (c) return c;
     const v = classifyInvocation(cmd.words.slice(i), cmd, ctx);
     if (v) return v;
   }
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/hook-credential.test.mjs tests/exec.test.mjs tests/classify.test.mjs tests/classify-bypass.test.mjs tests/hook.test.mjs`

Expected: PASS. Plan 1's 107 classifier-bypass cases still pass, so the new rule added no hole.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/hooks/classify.mjs scripts/lib/exec.mjs tests/exec.test.mjs tests/hook-credential.test.mjs
git commit -m "feat(security): deny agent use of riverwright credential; generated hooks require --home"
```

### Task 12: Install the guard into a clone

Spec §7.1 and ADR-0008. Every push URL is disabled, the local credential helper is emptied, and the pre-push hook is written. Everything is validated before anything changes, and a pre-push hook that is not ours is never overwritten. Plan 2b's `init` calls `installGuard`, and `doctor` calls `checkGuard`.

**Files:**

- Create: `scripts/lib/clone-guard.mjs`
- Test: `tests/clone-guard.test.mjs`

**Interfaces:**

- Consumes: `runFile`, `writeFileAtomic`, `renderPrePushHook` (`guard.mjs`), `RiverwrightError`.
- Produces:
  - `DISABLED_PUSH_URL = 'DISABLED_BY_RIVERWRIGHT'`, `HOOK_MARKER = 'Installed by Riverwright'`.
  - `installGuard({ cloneDir, scriptPath, home }): Promise<{ remotesDisabled: string[], credentialHelperCleared: true, hook: 'installed'|'updated'|'unchanged', hookFile }>`. Errors: `NOT_A_REPO`, `HOOKS_PATH_SET`, `HOOK_EXISTS`, `GIT_FAILED`.
  - `checkGuard({ cloneDir, scriptPath, home }): Promise<{ ok, problems: string[] }>` (read-only).

- [ ] **Step 1: Write the failing test**

`tests/clone-guard.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { installGuard, checkGuard, DISABLED_PUSH_URL, HOOK_MARKER } from '../scripts/lib/clone-guard.mjs';
import { runFile } from '../scripts/lib/exec.mjs';
import { RIVERWRIGHT, tmpDir } from './helpers.mjs';

const git = (cwd, ...a) => runFile('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd });
const posixOnly = { skip: process.platform === 'win32' };

async function clone({ remotes = { origin: 'https://github.com/ruvnet/ruflo.git' } } = {}) {
  const dir = tmpDir('rw-clone-');
  await git(dir, 'init', '-q');
  await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  for (const [name, url] of Object.entries(remotes)) await git(dir, 'remote', 'add', name, url);
  return dir;
}
const home = () => path.join(tmpDir('rw-user-'), 'Riverwright Home');
const hookOf = (dir) => path.join(dir, '.git', 'hooks', 'pre-push');
const install = (dir, h = home()) => installGuard({ cloneDir: dir, scriptPath: RIVERWRIGHT, home: h });

test('installGuard disables every push URL, empties the credential helper and installs the pre-push hook', async () => {
  const dir = await clone({ remotes: { origin: 'https://github.com/ruvnet/ruflo.git', upstream: 'https://github.com/other/ruflo.git' } });
  const h = home();
  const r = await install(dir, h);
  assert.deepEqual(r.remotesDisabled.sort(), ['origin', 'upstream']);
  for (const name of ['origin', 'upstream']) {
    assert.equal((await git(dir, 'remote', 'get-url', '--push', name)).stdout.trim(), DISABLED_PUSH_URL);
  }
  assert.equal((await git(dir, 'remote', 'get-url', 'origin')).stdout.trim(), 'https://github.com/ruvnet/ruflo.git', 'fetch URL is untouched');
  assert.deepEqual((await git(dir, 'config', '--local', '--get-all', 'credential.helper')).stdout.split('\n').slice(0, -1), ['']);
  const hook = fs.readFileSync(hookOf(dir), 'utf8');
  assert.match(hook, new RegExp(HOOK_MARKER));
  assert.ok(hook.includes(`--home "${h.replace(/\\/g, '/')}"`));
  if (process.platform !== 'win32') assert.equal(fs.statSync(hookOf(dir)).mode & 0o111, 0o111);
});

test('a push from the guarded clone fails before it reaches any network', posixOnly, async () => {
  const dir = await clone();
  await install(dir);
  const r = await git(dir, 'push', 'origin', 'HEAD:refs/heads/riverwright/1-x');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /DISABLED_BY_RIVERWRIGHT|does not appear to be a git repository/);
});

test('installing again changes nothing', async () => {
  const dir = await clone();
  const h = home();
  await install(dir, h);
  const before = fs.readFileSync(hookOf(dir), 'utf8');
  const r = await install(dir, h);
  assert.equal(r.hook, 'unchanged');
  assert.equal(fs.readFileSync(hookOf(dir), 'utf8'), before);
});

test('a hook Riverwright installed earlier is updated when the home or script changes', async () => {
  const dir = await clone();
  await install(dir, home());
  const other = home();
  const r = await install(dir, other);
  assert.equal(r.hook, 'updated');
  assert.ok(fs.readFileSync(hookOf(dir), 'utf8').includes(other.replace(/\\/g, '/')));
});

test('a pre-push hook that is not ours is never overwritten, and nothing else is changed either', async () => {
  const dir = await clone();
  fs.mkdirSync(path.dirname(hookOf(dir)), { recursive: true });
  const theirs = '#!/bin/sh\n# my own check\nexit 0\n';
  fs.writeFileSync(hookOf(dir), theirs);
  await assert.rejects(install(dir), (e) => e.code === 'HOOK_EXISTS' && /pre-push/.test(e.message));
  assert.equal(fs.readFileSync(hookOf(dir), 'utf8'), theirs);
  assert.notEqual((await git(dir, 'remote', 'get-url', '--push', 'origin')).stdout.trim(), DISABLED_PUSH_URL);
  assert.equal((await git(dir, 'config', '--local', '--get-all', 'credential.helper')).code, 1);
});

test('a core.hooksPath setting is refused, because the hook would not run from where we write it', async () => {
  const dir = await clone();
  await git(dir, 'config', '--local', 'core.hooksPath', '/tmp/somewhere');
  await assert.rejects(install(dir), (e) => e.code === 'HOOKS_PATH_SET');
  assert.equal(fs.existsSync(hookOf(dir)), false);
});

test('a directory that is not a git repository is refused', async () => {
  await assert.rejects(install(tmpDir()), (e) => e.code === 'NOT_A_REPO');
});

test('a linked worktree gets the guard through the shared hooks directory', async () => {
  const dir = await clone();
  const wt = path.join(tmpDir('rw-wt-'), 'issue-1');
  const added = await git(dir, 'worktree', 'add', '-q', '-b', 'riverwright/1-x', wt);
  assert.equal(added.code, 0, added.stderr);
  await install(wt);
  assert.equal(fs.existsSync(hookOf(dir)), true);
});

test('checkGuard passes after install and names what changed afterwards', async () => {
  const dir = await clone();
  const h = home();
  await install(dir, h);
  assert.deepEqual(await checkGuard({ cloneDir: dir, scriptPath: RIVERWRIGHT, home: h }), { ok: true, problems: [] });
  await git(dir, 'remote', 'set-url', '--push', 'origin', 'https://github.com/x/y.git');
  await git(dir, 'config', '--local', '--add', 'credential.helper', 'store');
  fs.rmSync(hookOf(dir));
  const bad = await checkGuard({ cloneDir: dir, scriptPath: RIVERWRIGHT, home: h });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(' | '), /push URL/);
  assert.match(bad.problems.join(' | '), /credential helper/);
  assert.match(bad.problems.join(' | '), /pre-push hook/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/clone-guard.test.mjs`

Expected: FAIL to load, `ERR_MODULE_NOT_FOUND` for `scripts/lib/clone-guard.mjs`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/clone-guard.mjs`:

```js
// Installs Lock 1 into a clone (core spec §7.1): every push URL disabled, the local credential helper
// emptied, and the pre-push hook that runs "riverwright guard pre-push". Everything is validated before
// anything is changed, and a hook that is not ours is never overwritten (ADR-0008).
import fs from 'node:fs';
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';
import { runFile } from './exec.mjs';
import { writeFileAtomic } from './fsx.mjs';
import { renderPrePushHook } from './guard.mjs';

export const DISABLED_PUSH_URL = 'DISABLED_BY_RIVERWRIGHT';
export const HOOK_MARKER = 'Installed by Riverwright';

const git = (cloneDir, args) => runFile('git', args, { cwd: cloneDir });

async function hooksDir(cloneDir) {
  const inside = await git(cloneDir, ['rev-parse', '--git-dir']);
  if (inside.code !== 0) throw new RiverwrightError('NOT_A_REPO', `${cloneDir} is not a git repository`);
  const r = await git(cloneDir, ['rev-parse', '--git-path', 'hooks']);
  return path.resolve(cloneDir, r.stdout.trim());
}

async function remoteNames(cloneDir) {
  const r = await git(cloneDir, ['remote']);
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

export async function installGuard({ cloneDir, scriptPath, home }) {
  const dir = await hooksDir(cloneDir);
  const hooksPath = await git(cloneDir, ['config', '--get', 'core.hooksPath']);
  if (hooksPath.code === 0 && hooksPath.stdout.trim()) {
    throw new RiverwrightError('HOOKS_PATH_SET', `core.hooksPath is set (${hooksPath.stdout.trim()}), so a hook written to ${dir} would not run. Unset it or install the guard yourself.`);
  }
  const hookFile = path.join(dir, 'pre-push');
  const wanted = renderPrePushHook(scriptPath, { home });
  let hook = 'installed';
  if (fs.existsSync(hookFile)) {
    const existing = fs.readFileSync(hookFile, 'utf8');
    if (!existing.includes(HOOK_MARKER)) {
      throw new RiverwrightError('HOOK_EXISTS', `${hookFile} is a pre-push hook Riverwright did not write, so it was left alone and nothing was changed. Add "riverwright guard pre-push" to it yourself, or move it aside.`);
    }
    hook = existing === wanted ? 'unchanged' : 'updated';
  }
  const remotes = await remoteNames(cloneDir);
  for (const name of remotes) {
    const r = await git(cloneDir, ['remote', 'set-url', '--push', name, DISABLED_PUSH_URL]);
    if (r.code !== 0) throw new RiverwrightError('GIT_FAILED', `could not disable the push URL of remote "${name}": ${r.stderr.trim()}`);
  }
  // An empty value resets git's list of credential helpers, so nothing configured elsewhere applies here.
  const helper = await git(cloneDir, ['config', '--local', '--replace-all', 'credential.helper', '']);
  if (helper.code !== 0) throw new RiverwrightError('GIT_FAILED', `could not clear the credential helper: ${helper.stderr.trim()}`);
  if (hook !== 'unchanged') {
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(hookFile, wanted, { mode: 0o755 });
  }
  return { remotesDisabled: remotes, credentialHelperCleared: true, hook, hookFile };
}

// Read-only: what is still true of an installed guard. `doctor` prints these problems.
export async function checkGuard({ cloneDir, scriptPath, home }) {
  const problems = [];
  for (const name of await remoteNames(cloneDir)) {
    const r = await git(cloneDir, ['remote', 'get-url', '--push', name]);
    if (r.stdout.trim() !== DISABLED_PUSH_URL) problems.push(`the push URL of remote "${name}" is not disabled`);
  }
  const helpers = await git(cloneDir, ['config', '--local', '--get-all', 'credential.helper']);
  const listed = helpers.code === 0 ? helpers.stdout.split('\n').slice(0, -1) : null;
  if (!listed || listed.length !== 1 || listed[0] !== '') problems.push('the local git credential helper list is not empty');
  const hookFile = path.join(await hooksDir(cloneDir), 'pre-push');
  if (!fs.existsSync(hookFile)) problems.push('the pre-push hook is missing');
  else if (fs.readFileSync(hookFile, 'utf8') !== renderPrePushHook(scriptPath, { home })) problems.push('the pre-push hook is not the one Riverwright installs for this workspace');
  return { ok: problems.length === 0, problems };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test tests/clone-guard.test.mjs`

Expected: PASS, 9 tests (the push test is skipped on Windows).

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/clone-guard.mjs tests/clone-guard.test.mjs
git commit -m "feat(security): install the guard into a clone without overwriting anything"
```

### Task 13: The optional hardware push key

ADR-0010 tier 2. A FIDO2 security-key SSH key (`sk-` type) may sign the push only; the private key never leaves the hardware, so a same-user agent cannot sign without a touch. It is opt-in, it needs no compiled helper (it only spawns `ssh`), and pull requests and comments still use the sealed token.

**This task can only be partly verified without a security key.** The tests cover parsing, storage and the command that is built. Whether a real touch is required, and whether Apple's bundled OpenSSH can talk to a token, must be checked by the owner (Task 16). Until then mark the feature `implemented`, never `verified`.

**Files:**

- Create: `scripts/lib/pushkey.mjs`
- Modify: `scripts/lib/commands/credential.mjs`
- Test: `tests/pushkey.test.mjs`

**Interfaces:**

- Consumes: `RiverwrightError`, `readTextIfExists`, `writeFileAtomic`.
- Produces:
  - `PUSHKEY_SCHEMA = 'riverwright-pushkey/1'`, `SK_TYPES`, `pushKeyFile(home)`.
  - `parsePushKey(text): { type }` (refuses an ordinary SSH key); `savePushKey(home, { publicKeyFile })`, `readPushKey(home)`, `clearPushKey(home)`.
  - `sshPushEnv(home): { GIT_SSH_COMMAND } | null` (`ssh -i "<private key>" -o IdentitiesOnly=yes -o IdentityAgent=none`).
  - `riverwright credential push-key set <file.pub> | show | clear`.

- [ ] **Step 1: Write the failing test**

`tests/pushkey.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePushKey, readPushKey, savePushKey, clearPushKey, sshPushEnv, pushKeyFile } from '../scripts/lib/pushkey.mjs';
import { callMain, tmpDir } from './helpers.mjs';

const SK = 'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIA me@laptop';
const PLAIN = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA me@laptop';

function keyFiles() {
  const dir = tmpDir('rw-sshkey-');
  const pub = path.join(dir, 'id_ed25519_sk.pub');
  fs.writeFileSync(pub, `${SK}\n`);
  fs.writeFileSync(path.join(dir, 'id_ed25519_sk'), 'not a real key handle');
  return { dir, pub, priv: path.join(dir, 'id_ed25519_sk') };
}

test('only a FIDO2 security-key public key is accepted, never an ordinary SSH key', () => {
  assert.equal(parsePushKey(SK).type, 'sk-ssh-ed25519@openssh.com');
  assert.equal(parsePushKey('sk-ecdsa-sha2-nistp256@openssh.com AAAA x').type, 'sk-ecdsa-sha2-nistp256@openssh.com');
  for (const bad of [PLAIN, '', 'garbage', 'ssh-rsa AAAA x', `${SK}\n${SK}`]) assert.throws(() => parsePushKey(bad), /security-key|FIDO2/, JSON.stringify(bad));
});

test('the config is saved under the workspace vault directory and read back', () => {
  const home = tmpDir();
  const k = keyFiles();
  assert.equal(readPushKey(home), null);
  savePushKey(home, { publicKeyFile: k.pub });
  assert.equal(pushKeyFile(home), path.join(home, 'vault', 'push-key.json'));
  assert.deepEqual(readPushKey(home), { schema: 'riverwright-pushkey/1', publicKeyFile: k.pub, privateKeyFile: k.priv, type: 'sk-ssh-ed25519@openssh.com' });
  clearPushKey(home);
  assert.equal(readPushKey(home), null);
});

test('a missing key file, a relative path or an unquotable path is refused', () => {
  const home = tmpDir();
  assert.throws(() => savePushKey(home, { publicKeyFile: path.join(tmpDir(), 'nope.pub') }), /not found|no such/i);
  assert.throws(() => savePushKey(home, { publicKeyFile: 'id_ed25519_sk.pub' }), /absolute/);
  const dir = tmpDir();
  const weird = path.join(dir, 'a$b.pub');
  fs.writeFileSync(weird, SK);
  assert.throws(() => savePushKey(home, { publicKeyFile: weird }), /quoted safely/);
  const plain = path.join(dir, 'plain.pub');
  fs.writeFileSync(plain, PLAIN);
  assert.throws(() => savePushKey(home, { publicKeyFile: plain }), /security-key/);
});

test('sshPushEnv builds an ssh command that uses only that key, and is null when none is set', () => {
  const home = tmpDir();
  assert.equal(sshPushEnv(home), null);
  const k = keyFiles();
  savePushKey(home, { publicKeyFile: k.pub });
  const env = sshPushEnv(home);
  assert.deepEqual(Object.keys(env), ['GIT_SSH_COMMAND']);
  assert.ok(env.GIT_SSH_COMMAND.startsWith('ssh '));
  assert.ok(env.GIT_SSH_COMMAND.includes(`-i "${k.priv.replace(/\\/g, '/')}"`));
  assert.match(env.GIT_SSH_COMMAND, /-o IdentitiesOnly=yes/);
  assert.match(env.GIT_SSH_COMMAND, /-o IdentityAgent=none/);
});

test('credential push-key set, show and clear work from the command line and store no secret', async () => {
  const home = tmpDir();
  const k = keyFiles();
  const run = (args) => callMain(['credential', ...args], { env: { RIVERWRIGHT_HOME: home, PATH: '' } });
  const set = await run(['push-key', 'set', k.pub]);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /touch/i);
  assert.match((await run(['push-key', 'show'])).stdout, /id_ed25519_sk/);
  assert.equal(fs.readFileSync(pushKeyFile(home), 'utf8').includes('not a real key handle'), false);
  assert.equal((await run(['push-key', 'clear'])).code, 0);
  assert.match((await run(['push-key', 'show'])).stdout, /No hardware push key/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test tests/pushkey.test.mjs`

Expected: FAIL to load, `ERR_MODULE_NOT_FOUND` for `scripts/lib/pushkey.mjs`.

- [ ] **Step 3: Write the implementation**

`scripts/lib/pushkey.mjs`:

```js
// Optional hardware push key (ADR-0010, tier 2). A FIDO2 security-key SSH key ("sk-" type) may sign the push
// only: the private key never leaves the hardware, so a same-user agent cannot sign without a touch.
// Pull requests and comments still use the sealed token. This module only records which key to use and builds
// the ssh command; it cannot check that the key was made with "-O verify-required", and it cannot be tested
// without a security key in hand.
import fs from 'node:fs';
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';
import { readTextIfExists, writeFileAtomic } from './fsx.mjs';

export const PUSHKEY_SCHEMA = 'riverwright-pushkey/1';
export const SK_TYPES = ['sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'];
export const pushKeyFile = (home) => path.join(home, 'vault', 'push-key.json');

export function parsePushKey(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const type = lines.length === 1 ? lines[0].split(/\s+/)[0] : null;
  if (!SK_TYPES.includes(type)) {
    throw new RiverwrightError('NOT_SK_KEY', `this is not a FIDO2 security-key public key (expected ${SK_TYPES.join(' or ')}). Create one with: ssh-keygen -t ed25519-sk -O verify-required`);
  }
  return { type };
}

function assertQuotable(p) {
  if (!(path.posix.isAbsolute(p) || path.win32.isAbsolute(p))) throw new RiverwrightError('UNSAFE_PATH', 'the key path must be absolute');
  if (/["$`%\r\n\0]/.test(p)) throw new RiverwrightError('UNSAFE_PATH', `path ${JSON.stringify(p)} cannot be quoted safely in every shell`);
}

export function savePushKey(home, { publicKeyFile }) {
  assertQuotable(String(publicKeyFile));
  const text = readTextIfExists(publicKeyFile);
  if (text === null) throw new RiverwrightError('NO_KEY_FILE', `key file not found: ${publicKeyFile}`);
  const { type } = parsePushKey(text);
  const privateKeyFile = String(publicKeyFile).replace(/\.pub$/, '');
  if (privateKeyFile === publicKeyFile) throw new RiverwrightError('BAD_KEY_NAME', 'name the public key file (it ends in .pub)');
  assertQuotable(privateKeyFile);
  fs.mkdirSync(path.dirname(pushKeyFile(home)), { recursive: true, mode: 0o700 });
  writeFileAtomic(pushKeyFile(home), `${JSON.stringify({ schema: PUSHKEY_SCHEMA, publicKeyFile, privateKeyFile, type }, null, 2)}\n`, { mode: 0o600 });
}

export function readPushKey(home) {
  const text = readTextIfExists(pushKeyFile(home));
  if (text === null) return null;
  const v = JSON.parse(text);
  if (v.schema !== PUSHKEY_SCHEMA) throw new RiverwrightError('BAD_PUSHKEY', `${pushKeyFile(home)} is not a Riverwright push-key file`);
  return v;
}

export function clearPushKey(home) {
  fs.rmSync(pushKeyFile(home), { force: true });
}

// The environment for one git push that must use only the security key. null means "no hardware key set".
export function sshPushEnv(home) {
  const k = readPushKey(home);
  if (!k) return null;
  assertQuotable(k.privateKeyFile);
  return { GIT_SSH_COMMAND: `ssh -i "${k.privateKeyFile.replace(/\\/g, '/')}" -o IdentitiesOnly=yes -o IdentityAgent=none` };
}
```

Apply this patch to `scripts/lib/commands/credential.mjs`:

```diff
diff --git a/scripts/lib/commands/credential.mjs b/scripts/lib/commands/credential.mjs
--- a/scripts/lib/commands/credential.mjs
+++ b/scripts/lib/commands/credential.mjs
@@ -7,8 +7,9 @@ import { nowIso } from '../clock.mjs';
 import { openTerminal, readSecret } from '../tty.mjs';
 import { defaultKdf, fingerprint, readVault, sealVault, vaultFile, writeVault } from '../vault.mjs';
 import { auditAmbient } from '../ambient.mjs';
+import { clearPushKey, readPushKey, savePushKey } from '../pushkey.mjs';
 
-const USAGE = 'usage: riverwright credential <setup [--replace] | status | remove>';
+const USAGE = 'usage: riverwright credential <setup [--replace] | status | remove | push-key <set <file.pub> | show | clear>>';
 
 const terminalOf = (io) => (io.openTerminal ? io.openTerminal() : openTerminal({ platform: io.platform }));
 
@@ -75,11 +76,30 @@ async function remove(io, home) {
   }
 }
 
+function pushKey(rest, io, home) {
+  const [action, file] = rest;
+  if (action === 'set') {
+    if (!file) throw new RiverwrightError('USAGE', USAGE);
+    savePushKey(home, { publicKeyFile: file });
+    io.stdout.write(`Hardware push key set: ${file}\nEach push will need a touch on the security key. Pull requests and comments still use the sealed token.\n`);
+  } else if (action === 'show') {
+    const k = readPushKey(home);
+    io.stdout.write(k ? `Hardware push key: ${k.publicKeyFile} (${k.type})\n` : 'No hardware push key is set.\n');
+  } else if (action === 'clear') {
+    clearPushKey(home);
+    io.stdout.write('Hardware push key cleared.\n');
+  } else {
+    throw new RiverwrightError('USAGE', USAGE);
+  }
+  return 0;
+}
+
 export async function run(args, io) {
   const [sub, ...rest] = args;
+  const home = riverwrightHome(io.env);
   // A person runs this command, so RIVERWRIGHT_HOME is honored. No secret is read from an argument or the environment.
+  if (sub === 'push-key') return pushKey(rest, io, home);
   const { values } = parseArgs({ args: rest, options: { replace: { type: 'boolean', default: false } } });
-  const home = riverwrightHome(io.env);
   switch (sub) {
     case 'setup': await setup(values, io, home); return 0;
     case 'status': return status(io, home);
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test tests/pushkey.test.mjs tests/credential-cli.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS: 558 tests, 551 passing, 7 skipped on Windows-only conditions, 0 failing (Task 14 brings it to 564 and 557).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/pushkey.mjs scripts/lib/commands/credential.mjs tests/pushkey.test.mjs
git commit -m "feat(security): optional FIDO2 hardware push key"
```

### Task 14: A leased re-submit after an amend

[ADR-0012](../adr/0012-leased-force-push-for-resubmits.md). Normally a pull request grows by new commits. When the owner amends a commit that was already pushed, the next push replaces the remote tip. The receipt can carry a `lease`: the SHA of the remote tip the human approved replacing. The signed bytes include it, the gate passes it through, and the guard allows a push that does not fast-forward the remote only when the receipt's lease equals that tip. Plan 2b's `submit` reads the fork branch tip before the unlock and pushes with `--force-with-lease=refs/heads/<branch>:<lease>`; this task builds the parts 2a owns.

**Files:**

- Modify: `scripts/lib/receipt.mjs`, `scripts/lib/gate.mjs`, `scripts/lib/guard.mjs`, `scripts/lib/commands/guard.mjs`
- Modify (tests): `tests/receipt-helpers.mjs`, `tests/receipt.test.mjs`, `tests/gate.test.mjs`, `tests/guard.test.mjs`
- Create (test): `tests/guard-lease.test.mjs`

**Interfaces:**

- Consumes: everything from Tasks 3, 7 and 8.
- Produces:
  - `buildReceipt({ ..., lease?: string | null })`: `lease` is a full SHA, allowed only for a `submit-gate` receipt bound to a commit (`BAD_RECEIPT` otherwise); the receipt has a `lease` field (`null` when absent). `receiptBytes` is now `[gate, run, kind, value, branch, lease, ledgerHead, seq, at, nonce]`, so the lease is signed.
  - `appendReceipt({ ..., lease? })` and `runPublicAction({ ..., lease? })` pass it through to the receipt.
  - `decidePrePush({ ..., approvedLease?: string | null })`: each update may carry `fastForward: boolean`. An update whose remote tip is not all zeros and whose `fastForward` is not `true` is refused unless `approvedLease` equals that tip.
  - The guard command asks git (`git merge-base --is-ancestor <remote tip> <pushed commit>`) for each such update and passes the receipt's `lease` to `decidePrePush`. A tip whose objects are missing, or any git failure, counts as "not a fast-forward".
  - `issueReceipt` and `armRun` in `tests/receipt-helpers.mjs` accept `lease`.

- [ ] **Step 1: Write the failing tests**

```diff
diff --git a/tests/gate.test.mjs b/tests/gate.test.mjs
--- a/tests/gate.test.mjs
+++ b/tests/gate.test.mjs
@@ -173,3 +173,14 @@ test('a forged approval already in state.json does not stand in for an unlock',
   await assert.rejects(runPublicAction({ ...s.base, terminal: t, action: async () => { called = true; } }), (e) => e.code === 'UNLOCK_REFUSED');
   assert.equal(called, false);
 });
+
+test('a lease is carried into the signed receipt, so the unlock approves replacing exactly that commit', async () => {
+  const s = setup();
+  const lease = 'c'.repeat(40);
+  const r = await runPublicAction({ ...s.base, lease, terminal: fakeSecretTerminal([PASSPHRASE]), action: async ({ receipt }) => receipt.lease });
+  assert.equal(r.result, lease);
+  assert.equal(readEvents(s.ledgerDir)[0].data.receipt.lease, lease);
+  const plain = setup();
+  const p = await runPublicAction({ ...plain.base, terminal: fakeSecretTerminal([PASSPHRASE]), action: async ({ receipt }) => receipt.lease });
+  assert.equal(p.result, null);
+});
diff --git a/tests/guard.test.mjs b/tests/guard.test.mjs
--- a/tests/guard.test.mjs
+++ b/tests/guard.test.mjs
@@ -268,3 +268,20 @@ test('the guard finds the run with the environment git gives a pre-push hook in
   assert.notEqual(other.code, 0);
   assert.match(other.stderr, /not the approved commit/);
 });
+
+// A re-submit after an amend replaces the remote tip. Only a receipt whose lease equals that tip allows it (ADR-0012).
+test('a push that does not fast-forward the remote needs a receipt lease equal to the remote tip', () => {
+  const tip = 'c'.repeat(40);
+  const updates = (extra) => parsePrePushLines(`refs/heads/riverwright/3509-codex ${A} refs/heads/riverwright/3509-codex ${tip}\n`).map((u) => ({ ...u, ...extra }));
+  const base = { remoteUrl: FORK, forkUrl: FORK, approvedSha: A, approvedBranch: 'riverwright/3509-codex' };
+  assert.equal(decidePrePush({ ...base, updates: updates({ fastForward: true }) }).allow, true);
+  const none = decidePrePush({ ...base, updates: updates({ fastForward: false }) });
+  assert.equal(none.allow, false);
+  assert.match(none.reason, /replace/);
+  assert.equal(decidePrePush({ ...base, updates: updates({}) }).allow, false, 'unknown fast-forward status is not assumed');
+  assert.equal(decidePrePush({ ...base, approvedLease: tip, updates: updates({ fastForward: false }) }).allow, true);
+  const wrong = decidePrePush({ ...base, approvedLease: 'd'.repeat(40), updates: updates({ fastForward: false }) });
+  assert.equal(wrong.allow, false);
+  assert.match(wrong.reason, /not the commit you approved replacing/);
+  assert.equal(decidePrePush({ ...base, updates: parsePrePushLines(line(A)) }).allow, true, 'a new branch needs no lease');
+});
diff --git a/tests/receipt-helpers.mjs b/tests/receipt-helpers.mjs
--- a/tests/receipt-helpers.mjs
+++ b/tests/receipt-helpers.mjs
@@ -18,17 +18,17 @@ export function makeTestVault(home, { token = TOKEN, passphrase = PASSPHRASE } =
 }
 
 // Appends a signed `approved` event for a public gate, the way an unlock does, to the run's ledger.
-export function issueReceipt({ runDir, keys, gate = 'submit-gate', run = 'ruvnet/ruflo#3509', sha = 'a'.repeat(40), content, branch = 'riverwright/3509-codex', at = NOW }) {
+export function issueReceipt({ runDir, keys, gate = 'submit-gate', run = 'ruvnet/ruflo#3509', sha = 'a'.repeat(40), content, branch = 'riverwright/3509-codex', lease = null, at = NOW }) {
   const binding = content === undefined ? { kind: 'sha', value: sha } : { kind: 'content', value: content };
-  return appendReceipt({ ledgerDir: ledgerDirFor(runDir), privateKey: keys.privateKey, gate, run, binding, branch: gate === 'submit-gate' ? branch : null, at });
+  return appendReceipt({ ledgerDir: ledgerDirFor(runDir), privateKey: keys.privateKey, gate, run, binding, branch: gate === 'submit-gate' ? branch : null, lease, at });
 }
 
 export const runDirIn = (home, owner = 'ruvnet', repo = 'ruflo', n = 3509) => path.join(home, owner, repo, 'runs', `issue-${n}`);
 
 // A run that has been unlocked: a real vault under `home` and a signed, current receipt in the run's ledger.
 // The receipt is dated now unless `at` is given, for tests that do not pin the clock.
-export function armRun({ home, runDir, sha = 'a'.repeat(40), branch = 'riverwright/3509-codex', run = 'ruvnet/ruflo#3509', at = new Date().toISOString() }) {
+export function armRun({ home, runDir, sha = 'a'.repeat(40), branch = 'riverwright/3509-codex', run = 'ruvnet/ruflo#3509', lease = null, at = new Date().toISOString() }) {
   const keys = makeTestVault(home);
-  issueReceipt({ runDir, keys, sha, branch, run, at });
+  issueReceipt({ runDir, keys, sha, branch, run, lease, at });
   return keys;
 }
diff --git a/tests/receipt.test.mjs b/tests/receipt.test.mjs
--- a/tests/receipt.test.mjs
+++ b/tests/receipt.test.mjs
@@ -18,7 +18,7 @@ test('a signed receipt verifies, and changing any signed field breaks it', () =>
   const r = signReceipt(buildReceipt(base), k.privateKey);
   assert.equal(r.schema, RECEIPT_SCHEMA);
   assert.equal(verifyReceipt(r, k.publicKey), true);
-  const edits = { gate: 'post-comment', run: 'ruvnet/ruflo#1', binding: { kind: 'sha', value: 'b'.repeat(40) }, branch: 'riverwright/1-x', ledgerHead: `sha256:${'2'.repeat(64)}`, seq: 5, at: '2026-10-02T14:03:12.000Z', nonce: 'm'.repeat(32) };
+  const edits = { gate: 'post-comment', run: 'ruvnet/ruflo#1', binding: { kind: 'sha', value: 'b'.repeat(40) }, branch: 'riverwright/1-x', lease: 'c'.repeat(40), ledgerHead: `sha256:${'2'.repeat(64)}`, seq: 5, at: '2026-10-02T14:03:12.000Z', nonce: 'm'.repeat(32) };
   for (const [key, value] of Object.entries(edits)) assert.equal(verifyReceipt({ ...r, [key]: value }, k.publicKey), false, key);
   assert.equal(verifyReceipt(r, keysOf().publicKey), false);
   assert.equal(verifyReceipt({ ...r, signature: 'not base64 !!' }, k.publicKey), false);
@@ -29,7 +29,7 @@ test('the signed bytes are a fixed-order JSON array, so no field can slide into
   const r = buildReceipt(base);
   const [tag, body] = receiptBytes(r).toString('utf8').split('\n');
   assert.equal(tag, RECEIPT_SCHEMA);
-  assert.deepEqual(JSON.parse(body), [r.gate, r.run, r.binding.kind, r.binding.value, r.branch, r.ledgerHead, r.seq, r.at, r.nonce]);
+  assert.deepEqual(JSON.parse(body), [r.gate, r.run, r.binding.kind, r.binding.value, r.branch, r.lease, r.ledgerHead, r.seq, r.at, r.nonce]);
   const tricky = buildReceipt({ ...base, run: 'a","b' });
   assert.equal(JSON.parse(receiptBytes(tricky).toString('utf8').split('\n')[1])[1], 'a","b');
 });
@@ -133,3 +133,17 @@ test('verifyReceipts reports a repeated nonce and a receipt that names the wrong
   assert.match(problems.map((p) => p.reason).join(' | '), /seq/);
   assert.equal(readEvents(s.ledgerDir).length, 2);
 });
+
+test('a lease names the remote tip a re-submit replaces, is signed, and belongs to the submit gate and a commit only', () => {
+  const k = keysOf();
+  const C = 'c'.repeat(40);
+  const r = signReceipt(buildReceipt({ ...base, lease: C }), k.privateKey);
+  assert.equal(r.lease, C);
+  assert.equal(verifyReceipt(r, k.publicKey), true);
+  assert.equal(verifyReceipt({ ...r, lease: 'd'.repeat(40) }, k.publicKey), false);
+  assert.equal(verifyReceipt({ ...r, lease: null }, k.publicKey), false);
+  assert.equal(buildReceipt(base).lease, null);
+  assert.throws(() => buildReceipt({ ...base, lease: 'abc' }), /lease/);
+  assert.throws(() => buildReceipt({ ...base, gate: 'post-comment', branch: null, binding: { kind: 'content', value: `sha256:${'c'.repeat(64)}` }, lease: C }), /lease/);
+  assert.throws(() => buildReceipt({ ...base, binding: { kind: 'content', value: `sha256:${'c'.repeat(64)}` }, lease: C }), /lease/);
+});
```

Create the new test file:

`tests/guard-lease.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createState, saveState, setFork } from '../scripts/lib/state.mjs';
import { runFile } from '../scripts/lib/exec.mjs';
import { callMain, tmpDir } from './helpers.mjs';
import { armRun, runDirIn } from './receipt-helpers.mjs';

const FORK = 'https://github.com/pacphi/ruflo.git';
const BRANCH = 'riverwright/3509-codex';
const git = (cwd, ...a) => runFile('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd });
const sha = async (cwd, rev = 'HEAD') => (await git(cwd, 'rev-parse', rev)).stdout.trim();

// A worktree with: A (first push), then the owner amends it to B (A is no longer an ancestor), and C on top of A.
async function amended() {
  const home = tmpDir('riverwright-home-');
  const worktree = path.join(home, 'ruvnet', 'ruflo', 'worktrees', 'issue-3509');
  fs.mkdirSync(worktree, { recursive: true });
  await git(worktree, 'init', '-q');
  await git(worktree, 'commit', '-q', '--allow-empty', '-m', 'fix');
  const A = await sha(worktree);
  await git(worktree, 'commit', '-q', '--allow-empty', '-m', 'more');
  const C = await sha(worktree);
  await git(worktree, 'reset', '-q', '--hard', A);
  await git(worktree, 'commit', '-q', '--amend', '--allow-empty', '-m', 'fix (signed off)');
  const B = await sha(worktree);
  const runDir = runDirIn(home);
  saveState(runDir, setFork(createState({ runId: 'ruvnet/ruflo#3509', now: 't' }), FORK));
  return { home, worktree, runDir, A, B, C };
}
const push = (w, local, remote) => callMain(['guard', 'pre-push', '--home', w.home, '--', 'fork', FORK], { stdin: `refs/heads/${BRANCH} ${local} refs/heads/${BRANCH} ${remote}\n`, cwd: w.worktree });

test('an amended commit replaces the old tip only when the receipt leased exactly that tip', async () => {
  const w = await amended();
  armRun({ home: w.home, runDir: w.runDir, sha: w.B, lease: w.A });
  const r = await push(w, w.B, w.A);
  assert.equal(r.code, 0, r.stderr);
});

test('without a lease, or with the wrong lease, the replacement is refused', async () => {
  const w = await amended();
  armRun({ home: w.home, runDir: w.runDir, sha: w.B });
  const none = await push(w, w.B, w.A);
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /replace/);
  const other = await amended();
  armRun({ home: other.home, runDir: other.runDir, sha: other.B, lease: other.C });
  const wrong = await push(other, other.B, other.A);
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.stderr, /not the commit you approved replacing/);
});

test('an ordinary fast-forward needs no lease, and a remote tip we do not have is treated as a replacement', async () => {
  const w = await amended();
  armRun({ home: w.home, runDir: w.runDir, sha: w.C });
  const ff = await push(w, w.C, w.A);
  assert.equal(ff.code, 0, ff.stderr);
  const unknown = await amended();
  armRun({ home: unknown.home, runDir: unknown.runDir, sha: unknown.B });
  const r = await push(unknown, unknown.B, 'd'.repeat(40));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /replace/);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test tests/receipt.test.mjs tests/gate.test.mjs tests/guard.test.mjs tests/guard-lease.test.mjs`

Expected: FAIL, 7 tests: the two receipt tests that now include the lease, the new receipt lease test, the gate lease test, the `decidePrePush` lease test, and two of the three `guard-lease` tests. The first `guard-lease` test already passes, because without lease handling the guard ignores the remote tip.

- [ ] **Step 3: Write the implementation**

```diff
diff --git a/scripts/lib/commands/guard.mjs b/scripts/lib/commands/guard.mjs
--- a/scripts/lib/commands/guard.mjs
+++ b/scripts/lib/commands/guard.mjs
@@ -33,6 +33,16 @@ async function runFromRepository(io, home) {
   return dir ? { dir, runId: `${parts[0]}/${parts[1]}#${m[1]}` } : null;
 }
 
+// Whether each push fast-forwards the remote tip git reported, asked of git itself. A tip whose objects we do not
+// have, or any git failure, is reported as not a fast-forward.
+async function withFastForward(updates, cwd) {
+  return Promise.all(updates.map(async (u) => {
+    if (!u.remoteSha || /^0+$/.test(u.remoteSha) || !u.localSha) return u;
+    const r = await runFile('git', ['merge-base', '--is-ancestor', u.remoteSha, u.localSha], { cwd });
+    return { ...u, fastForward: r.code === 0 };
+  }));
+}
+
 function latestReceipt({ home, dir, runId, nowMs }) {
   try {
     const found = findValidReceipt({ ledgerDir: ledgerDirFor(dir), publicKey: readVault(home).publicKey, gate: 'submit-gate', run: runId, nowMs });
@@ -51,7 +61,7 @@ export async function run(args, io) {
   const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { home: { type: 'string' } } });
   const [remoteName, remoteUrl] = positionals;
   const home = workspaceHomeFromArg(values.home);
-  const updates = parsePrePushLines(await readAll(io.stdin));
+  const updates = await withFastForward(parsePrePushLines(await readAll(io.stdin)), io.cwd);
   let located = null;
   if (io.testing?.allowRunDirOverride) {
     const dir = await testRunDir(io);
@@ -79,6 +89,7 @@ export async function run(args, io) {
     remoteUrl: destination, updates, forkUrl: state.fork?.url ?? null,
     approvedSha: receipt?.binding.kind === 'sha' ? receipt.binding.value : null,
     approvedBranch: receipt?.branch ?? null,
+    approvedLease: receipt?.lease ?? null,
   });
   if (!decision.allow && why) decision.reason = `${decision.reason} (${why})`;
   appendEvent(dir, { type: 'guard', at, decision: decision.allow ? 'allow' : 'deny', reason: decision.reason, remoteUrl: destination });
diff --git a/scripts/lib/gate.mjs b/scripts/lib/gate.mjs
--- a/scripts/lib/gate.mjs
+++ b/scripts/lib/gate.mjs
@@ -28,7 +28,7 @@ function redact(error, token) {
 // action({ token, receipt, attempt }) does the public thing. It throws an error with `transient: true` for a
 // network error, a 5xx or a rate limit; anything else is final. recompute() returns the payload's binding as it
 // is now (a commit SHA or a content hash) and is called again before every retry.
-export async function runPublicAction({ home, runDir, gate, run, binding, branch = null, host = null, terminal, summary, warnings = [], now, clock = Date.now, sleep = defaultSleep, recompute, action }) {
+export async function runPublicAction({ home, runDir, gate, run, binding, branch = null, lease = null, host = null, terminal, summary, warnings = [], now, clock = Date.now, sleep = defaultSleep, recompute, action }) {
   if (!PUBLIC_GATES.includes(gate)) throw new RiverwrightError('NOT_PUBLIC_GATE', `"${gate}" is not a public gate (${PUBLIC_GATES.join(', ')})`);
   const vault = readVault(home);
   const refuse = (reason) => appendEvent(runDir, { type: 'unlock-refused', at: now(), actor: { type: 'human' }, run, gate, reason });
@@ -70,7 +70,7 @@ export async function runPublicAction({ home, runDir, gate, run, binding, branch
   }
 
   const ledgerDir = ledgerDirFor(runDir);
-  const written = appendReceipt({ ledgerDir, privateKey: opened.privateKey, gate, run, binding, branch, at: now() });
+  const written = appendReceipt({ ledgerDir, privateKey: opened.privateKey, gate, run, binding, branch, lease, at: now() });
   const receipt = written.record.data.receipt;
   const consume = (outcome) => markConsumed({ ledgerDir, nonce: receipt.nonce, outcome, at: now() });
   try {
diff --git a/scripts/lib/guard.mjs b/scripts/lib/guard.mjs
--- a/scripts/lib/guard.mjs
+++ b/scripts/lib/guard.mjs
@@ -14,7 +14,7 @@ export function parsePrePushLines(text) {
   });
 }
 
-export function decidePrePush({ remoteUrl, updates, forkUrl, approvedSha, approvedBranch = null }) {
+export function decidePrePush({ remoteUrl, updates, forkUrl, approvedSha, approvedBranch = null, approvedLease = null }) {
   if (!forkUrl) return deny('This clone has no fork yet. Pushes happen only through "riverwright submit" after you approve the submit gate.');
   const dest = normalizeRemoteUrl(remoteUrl);
   if (!dest || dest !== normalizeRemoteUrl(forkUrl)) {
@@ -29,6 +29,13 @@ export function decidePrePush({ remoteUrl, updates, forkUrl, approvedSha, approv
     if (u.localSha.toLowerCase() !== approvedSha) {
       return deny(`Commit ${u.localSha.slice(0, 12)} is not the approved commit ${approvedSha.slice(0, 12)}. Run "riverwright submit" again to approve the new commit.`);
     }
+    // A push that does not fast-forward the remote branch replaces its tip. Only a receipt whose lease equals that
+    // exact tip allows it (ADR-0012); an unknown fast-forward status is treated as a replacement.
+    const remoteTip = u.remoteSha && !ZERO.test(u.remoteSha) ? u.remoteSha.toLowerCase() : null;
+    if (remoteTip && u.fastForward !== true) {
+      if (!approvedLease) return deny(`The fork branch already holds ${remoteTip.slice(0, 12)}, which this push would replace. Only a re-submit that you approve with "riverwright submit" may replace it.`);
+      if (remoteTip !== approvedLease) return deny(`The fork branch holds ${remoteTip.slice(0, 12)}, which is not the commit you approved replacing (${approvedLease.slice(0, 12)}).`);
+    }
   }
   return { allow: true, reason: 'approved push to your fork' };
 }
diff --git a/scripts/lib/receipt.mjs b/scripts/lib/receipt.mjs
--- a/scripts/lib/receipt.mjs
+++ b/scripts/lib/receipt.mjs
@@ -17,23 +17,25 @@ const NONCE = /^[A-Za-z0-9]{16,64}$/;
 
 const bad = (msg) => new RiverwrightError('BAD_RECEIPT', msg);
 
-export function buildReceipt({ gate, run, binding, branch = null, ledgerHead, seq, at, nonce = crypto.randomBytes(16).toString('hex') }) {
+export function buildReceipt({ gate, run, binding, branch = null, lease = null, ledgerHead, seq, at, nonce = crypto.randomBytes(16).toString('hex') }) {
   if (!PUBLIC_GATES.includes(gate)) throw bad(`"${gate}" is not a public gate (${PUBLIC_GATES.join(', ')})`);
   if (typeof run !== 'string' || !run) throw bad('a receipt names its run');
   const okBinding = (binding?.kind === 'sha' && SHA.test(binding.value)) || (binding?.kind === 'content' && CONTENT.test(binding.value));
   if (!okBinding) throw bad('binding must be a full commit SHA or a sha256: content hash');
   if (gate === 'submit-gate') branch = normalizeBranch(branch);
   else if (branch !== null) throw bad('only the submit gate names a branch');
+  // A lease (ADR-0012) is the remote tip a re-submit replaces. Only a submit-gate receipt for a commit has one.
+  if (lease !== null && !(gate === 'submit-gate' && binding.kind === 'sha' && SHA.test(lease))) throw bad('a lease is the full SHA of the remote tip, and only a submit-gate receipt for a commit has one');
   if (!HEAD.test(ledgerHead ?? '')) throw bad('ledgerHead must be sha256:<64 hex>');
   if (!Number.isInteger(seq) || seq < 1) throw bad('seq must be a positive integer');
   if (typeof at !== 'string' || !at) throw bad('a receipt needs "at"');
   if (!NONCE.test(nonce)) throw bad('nonce must be 16 to 64 letters or digits');
-  return { schema: RECEIPT_SCHEMA, gate, run, binding: { kind: binding.kind, value: binding.value }, branch, ledgerHead, seq, at, nonce };
+  return { schema: RECEIPT_SCHEMA, gate, run, binding: { kind: binding.kind, value: binding.value }, branch, lease, ledgerHead, seq, at, nonce };
 }
 
 // A JSON array in fixed order, so no field can be moved into its neighbour without changing the bytes.
 export function receiptBytes(r) {
-  return Buffer.from(`${RECEIPT_SCHEMA}\n${JSON.stringify([r.gate, r.run, r.binding.kind, r.binding.value, r.branch, r.ledgerHead, r.seq, r.at, r.nonce])}`, 'utf8');
+  return Buffer.from(`${RECEIPT_SCHEMA}\n${JSON.stringify([r.gate, r.run, r.binding.kind, r.binding.value, r.branch, r.lease, r.ledgerHead, r.seq, r.at, r.nonce])}`, 'utf8');
 }
 
 export function signReceipt(receipt, privateKey) {
@@ -52,13 +54,13 @@ export function verifyReceipt(receipt, publicKey) {
 }
 
 // Signs and appends in one step, under the ledger lock, so the receipt names the exact head and seq it gets.
-export function appendReceipt({ ledgerDir, privateKey, gate, run, binding, branch = null, at, nonce }) {
+export function appendReceipt({ ledgerDir, privateKey, gate, run, binding, branch = null, lease = null, at, nonce }) {
   return appendChained(ledgerDir, ({ prev, seq }) => ({
     event: 'approved',
     at,
     run,
     actor: { type: 'human' },
-    data: { receipt: signReceipt(buildReceipt({ gate, run, binding, branch, ledgerHead: prev, seq, at, nonce }), privateKey) },
+    data: { receipt: signReceipt(buildReceipt({ gate, run, binding, branch, lease, ledgerHead: prev, seq, at, nonce }), privateKey) },
   }));
 }
 
```

- [ ] **Step 4: Run them and see them pass**

Run: `node --test tests/receipt.test.mjs tests/gate.test.mjs tests/guard.test.mjs tests/guard-lease.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `node --test`

Expected: PASS: 564 tests, 557 passing, 7 skipped on Windows-only conditions, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/receipt.mjs scripts/lib/gate.mjs scripts/lib/guard.mjs scripts/lib/commands/guard.mjs tests/receipt-helpers.mjs tests/receipt.test.mjs tests/gate.test.mjs tests/guard.test.mjs tests/guard-lease.test.mjs
git commit -m "feat(security): a leased re-submit may replace the remote tip only with a matching signed lease"
```

### Task 15: Documentation and roadmap

AGENTS.md rule 3: a change in what a feature does updates its spec, and a change in its status updates the roadmap. Statuses need the evidence the keyword promises (`implemented` needs code and tests on `develop`; `verified` needs a green CI run link on all three systems).

**Files:**

- Modify: `docs/adr/0010-sealed-credential-released-by-human-unlock.md`, `docs/adr/0004-three-locks-primary-lock-in-git.md`, `docs/specs/core-single-issue-pipeline.md`, `docs/specs/thread-record-and-audit.md`, `docs/ROADMAP.md`, `docs/plans/README.md`
- Test: `tests/roadmap.test.mjs`, `tests/docs-layout.test.mjs` (existing)

- [ ] **Step 1: Update the two ADRs' implementation status**

In ADR-0010, replace the `## Implementation status` section with:

```markdown
## Implementation status

Built by [Plan 2a](../plans/2026-09-30-plan-2a-security-foundation.md): the vault, signed receipts, the public
gate with its bounded retry, the ledger chain, the guard's use of receipts, the narrowed `approve`, the
ambient-credential audit, the clone guard and the optional hardware push key. The `submit` and `post` commands
that call the gate arrive in Plan 2b. Real-terminal echo behavior and the hardware key are checked by hand
(Plan 2a, Task 16). Updated 2026-09-30.
```

In ADR-0012, replace the `## Implementation status` section with:

```markdown
## Implementation status

The signed `lease`, the gate's pass-through and the guard's check are built by
[Plan 2a](../plans/2026-09-30-plan-2a-security-foundation.md), Task 14. The pre-unlock tip check and the
`--force-with-lease` push arrive with `submit` in Plan 2b. Updated 2026-09-30.
```

In ADR-0004, replace the `## Implementation status` section with:

```markdown
## Implementation status

Locks 1 and 2 are implemented and verified in CI. Lock 1 now trusts a signed receipt instead of `state.json`,
installs into a clone (`installGuard`), and credential separation is built ([ADR-0010](0010-sealed-credential-released-by-human-unlock.md),
Plan 2a). Updated 2026-09-30.
```

- [ ] **Step 2: Update the specs**

In `docs/specs/core-single-issue-pipeline.md` §3.3, add two rows to the subcommand table, after `riverwright approve checkpoint-1 <run>`: `riverwright ledger verify --run <dir>` ("Check the ledger chain, the receipt signatures and that no nonce was used twice") and, already present from the ADR-0010 edit, `riverwright credential`. In §7.1, after the paragraph that lists what the guard allows, add: "A push that does not fast-forward the remote branch is refused unless the receipt's `lease` equals the remote tip ([ADR-0012](../adr/0012-leased-force-push-for-resubmits.md))." In §7.2, add one sentence after the first paragraph: "A shell command that runs `riverwright credential` is denied in any spelling, because sealing or removing the credential is done by the human in their own terminal." In `docs/specs/thread-record-and-audit.md` §9, after the event-names table, add: "Plan 1's names (`run-created`, `station-begin`, `station-complete`, `approval`, `stop`, `reopen`, `guard`, `note`) remain valid event names, and Plan 2a adds `receipt-consumed` and `unlock-refused`. `approved` carries a signed receipt."

- [ ] **Step 3: Update the roadmap**

In `docs/ROADMAP.md`, change these rows (the ID stays; keep the existing feature text unless shown), setting the status and the evidence links:

```markdown
| S-07 | Credential separation: a sealed credential released only by a human unlock inside submit and post, which signs the receipt | `in-progress` | M2 | [code](../scripts/lib/vault.mjs), [tests](../tests/vault.test.mjs), [ADR-0010](adr/0010-sealed-credential-released-by-human-unlock.md), [plan 2a](plans/2026-09-30-plan-2a-security-foundation.md) |
| S-08 | Install the guard into a clone: disabled upstream push URL, empty credential helper, pre-push hook | `implemented` | M2 | [code](../scripts/lib/clone-guard.mjs), [tests](../tests/clone-guard.test.mjs) |
| S-09 | Generated hooks always carry the workspace path and cover shell tools only | `in-progress` | M2 | [code](../scripts/lib/exec.mjs), [tests](../tests/exec.test.mjs), [plan 2a](plans/2026-09-30-plan-2a-security-foundation.md) |
| S-10 | Signed receipts and the collapsed public gate: unlock, bounded in-process retry, consume | `implemented` | M2 | [code](../scripts/lib/gate.mjs), [tests](../tests/gate.test.mjs) |
| S-11 | Ambient-credential audit: names and counts, never values, shown by `credential status` and `doctor` | `implemented` | M2 | [code](../scripts/lib/ambient.mjs), [tests](../tests/ambient.test.mjs) |
| S-12 | Optional FIDO2 hardware key for the push only | `implemented` | M2 | [code](../scripts/lib/pushkey.mjs), [tests](../tests/pushkey.test.mjs) |
| S-13 | Agent shell commands that run `riverwright credential` are denied | `implemented` | M2 | [code](../scripts/lib/hooks/classify.mjs), [tests](../tests/hook-credential.test.mjs) |
| S-14 | A leased re-submit after an amend: a non-fast-forward push only with a signed lease equal to the remote tip | `implemented` | M2 | [code](../scripts/lib/guard.mjs), [tests](../tests/guard-lease.test.mjs), [ADR-0012](adr/0012-leased-force-push-for-resubmits.md) |
| W-02 | Hash-chained event ledger with `ledger verify` (built early, in Plan 2a) | `implemented` | M2 | [code](../scripts/lib/events.mjs), [tests](../tests/events.test.mjs), [plan 2a](plans/2026-09-30-plan-2a-security-foundation.md) |
```

S-07 and S-09 stay `in-progress` until Plan 2b delivers `submit` and `post` and Plan 2c delivers the shell-only matchers. S-08, S-10 to S-13 and W-02 move to `verified` only after a green CI run on all three systems; add the run link then. In the "Risks and open items" table, replace the row about the approval record with: "Ambient credentials (a `gh` login, an SSH agent, a readable terminal) are a route Riverwright cannot close | the result is tamper-evident and injection-resistant, not tamper-proof; `credential status` and `doctor` report each route | M2".

- [ ] **Step 4: Update the plans index**

In `docs/plans/README.md`, replace the row for Plan 2 with three rows, "2a. Security foundation ([plan](2026-09-30-plan-2a-security-foundation.md))", "2b. CLI, skills and publish ([plan](2026-09-30-plan-2b-cli-skills-and-publish.md))" and "2c. Adapters and plugin ([plan](2026-09-30-plan-2c-adapters-and-plugin.md))", each with the "Builds" and "Done when" text from its plan's Goal.

- [ ] **Step 5: Run the documentation checks**

Run: `node --test tests/roadmap.test.mjs tests/docs-layout.test.mjs && pnpm lint:md`

Expected: PASS, 0 lint issues. A broken link, an unknown status word, or an `implemented` row with no code link fails here.

- [ ] **Step 6: Commit**

```bash
git add docs
git commit -m "docs: record Plan 2a in the ADRs, specs, roadmap and plans index"
```

### Task 16: Checks that only a person at a real machine can make

Node's test runner has no pseudo-terminal and there is no CI security key, so these behaviors are checked by the owner and the result is written down. None of them publishes anything.

**Files:**

- Modify: `docs/research/credential-separation.md` (append the results under a new "Results of the manual checks" heading)

- [ ] **Step 1: Hidden typing on each operating system**

In a real terminal on each of macOS, Linux and Windows (Windows Terminal with PowerShell, and `cmd.exe`), from the repository root run:

```bash
node --input-type=module -e "import { openTerminal, readSecret } from './scripts/lib/tty.mjs'; const t = openTerminal(); const s = await readSecret({ terminal: t, question: 'Type test: ' }); t.close(); console.log('length', s.length)"
```

Expected: the characters you type are not shown, Backspace edits, Enter prints `length N`. Then run it again and press Ctrl-C: it exits, and characters you type in the shell afterwards are visible again (raw mode was restored). Record the result for each system. If Windows `CONIN$` does not give a terminal that supports raw mode, `readSecret` refuses with `NO_ECHO_CONTROL` and says so; record that, because it means the wizard needs a different route on Windows.

- [ ] **Step 2: A full setup and status in a throwaway workspace**

```bash
RIVERWRIGHT_HOME="$(mktemp -d)" node scripts/riverwright.mjs credential setup
RIVERWRIGHT_HOME=<the same directory> node scripts/riverwright.mjs credential status
```

Use the fake token `ghp_examplefaketoken0123456789` and a throwaway passphrase. Expected: the prompts hide typing, setup prints a fingerprint and never the token, and `status` lists the credential routes on your machine by name only. Delete the throwaway directory afterwards.

- [ ] **Step 3: The hardware key (optional, needs a FIDO2 key)**

Create a key with `ssh-keygen -t ed25519-sk -O verify-required -f /tmp/rw-sk-test`, then `node scripts/riverwright.mjs credential push-key set /tmp/rw-sk-test.pub` and `push-key show`. Record whether Apple's bundled OpenSSH accepts the key type (`ssh -Q key | grep sk-` already lists it here; whether it can talk to a token is the open question). A real push needs a repository you own and is your decision; do not do it as part of this plan.

- [ ] **Step 4: The fine-grained token question (optional)**

GitHub's documentation says a fine-grained token cannot write to public repositories you neither own nor belong to. To settle whether it can open a pull request on an upstream, use two repositories that you control: a private "upstream" repository in one account or organization, a fork of it in another, and a fine-grained token scoped only to the fork. Try `gh pr create` with that token from the fork. Record the result. This is the only step that touches GitHub, and it uses your own throwaway repositories.

- [ ] **Step 5: Record the results**

Append the results, with the date, operating system and Node version, to `docs/research/credential-separation.md`, and change the matching lines in its "Not verified" section. Then run `pnpm lint:md`.

- [ ] **Step 6: Commit**

```bash
git add docs/research/credential-separation.md
git commit -m "docs(research): record the manual terminal, hardware-key and token checks"
```

### Task 17: Independent security review

AGENTS.md: security code (guard, hook, classifier, approvals) gets a fresh independent review after it is built, one review by a different model family, with reviewers read-only. Everything in this plan is security code.

**Files:**

- Modify: `docs/research/credential-separation.md` (append "Review findings for Plan 2a")

- [ ] **Step 1: Launch the two reviews in parallel, both read-only**

Give each reviewer the same brief. It must say: review-only, change nothing, write nothing outside a scratch directory; the threat is a prompt-injected agent that runs as the user with shell tools and can write any file the user can; the goal is to publish (push, PR, comment) without the human's unlock, or to forge or hide consent; read `docs/adr/0010-sealed-credential-released-by-human-unlock.md`, `docs/specs/core-single-issue-pipeline.md` §6 and §7, and these files: `scripts/lib/{events,vault,receipt,gate,tty,ambient,clone-guard,pushkey,ledger,approvals,guard,exec}.mjs`, `scripts/lib/commands/{credential,ledger,guard,approve}.mjs`, `scripts/lib/hooks/classify.mjs` and their tests; report each finding with file, line, the exact steps an attacker takes, and a confirmed or plausible label.

One reviewer is a Claude agent (use the `superpowers:requesting-code-review` skill or the `code-review` skill). The other is Codex through the `codex:codex-rescue` agent, so a different model family sees the code.

- [ ] **Step 2: Triage**

For each finding, decide fixed, accepted (with the reason, in the ADR's residual-risk section) or not a defect. Every fix is test-first: write the failing test that reproduces the finding, watch it fail, fix it, `node --test`, one commit per finding.

- [ ] **Step 3: Record and re-run**

Append the findings and their outcomes to `docs/research/credential-separation.md`, run `node --test` and `pnpm lint:md`, and only then move S-07, S-08 and S-10 to S-13 toward `verified` once CI is green.

- [ ] **Step 4: Commit**

```bash
git add docs/research/credential-separation.md
git commit -m "docs(research): record the Plan 2a security review and its outcomes"
```

## Plan 2a done when

- `node --test` passes on ubuntu-latest, macos-latest and windows-latest with Node 24 and 26 (564 tests locally, 557 passing, 7 Windows-only skips).
- `pnpm lint:md` reports 0 issues.
- A forged approval in `state.json`, a receipt signed by another key, a reused or expired receipt, and a rewritten ledger are each refused by the guard, and each has a test that failed first.
- `riverwright credential setup` seals a token, `status` prints the fingerprint and the ambient routes without any value, and `ledger verify` checks the chain and every receipt.
- The manual checks in Task 16 are recorded, and the two independent reviews in Task 17 are triaged.
- The roadmap rows in Task 15 are set, with `verified` only where a CI run link exists.

## Self-Review

**Spec coverage (core spec §7.5 and ADR-0010):**

| Requirement | Task |
|---|---|
| Sealed vault, Argon2id or scrypt, AES-256-GCM, authenticated header | 2 |
| Passphrase and token read only from the terminal, hidden | 4, 6 |
| Unlock computes the binding from the live repository, shows the payload | 7 (`recompute`, `summary`) |
| No terminal, wrong passphrase, Ctrl-C: nothing released | 4, 7 |
| Signed receipt with ledger head, seq, nonce; appended before acting | 3, 7 |
| Action with the token in one process; nonce consumed | 7 |
| Retry: 3 attempts, 2 minutes, in-process, payload rechecked, constants | 7 |
| Guard trusts a verified receipt, not `state.json` | 8 |
| `approve` handles `checkpoint-1` only; host-ask exception removed | 9 |
| `ledger verify` checks chain, signatures, nonce reuse | 1, 10 |
| Ambient-credential report, names only | 5, 6 |
| Optional hardware push key | 13 |
| Leased re-submit after an amend (ADR-0012): signed `lease`, guard replaces only the leased tip | 14 |
| Agent shell cannot run `credential`; hooks always carry `--home` | 11 |
| Guard installed into a clone; nothing overwritten | 12 |
| Public gates' `submit` and `post` commands | Plan 2b |
| Shell-tools-only hook matchers per host | Plan 2c |

**Placeholder scan:** none. Every step carries its code, patch or command. The two Task 15 edits that are prose ("keep the existing feature text") point at exact rows and give the exact new text.

**Type consistency:** `PUBLIC_GATES`, `RECEIPT_TTL_MS`, `RETRY`, `defaultKdf`, `appendChained`, `appendReceipt`, `findValidReceipt`, `markConsumed`, `readSecret`, `fakeSecretTerminal`, `armRun`, `installGuard`, `checkGuard`, `sshPushEnv` are each defined in exactly one task and used with the same signature in the tasks that consume them.

## Unverified

- **Real-terminal behavior.** Hidden typing, raw-mode restore after Ctrl-C and `tty.isatty` on Windows `CONIN$` are tested only with fake terminals. Task 16 checks them by hand. If Windows cannot supply raw mode, `readSecret` refuses rather than echo.
- **Hardware key.** No security key was available. Parsing, storage and the built `ssh` command are tested; a real touch requirement, `-O verify-required` and Apple OpenSSH's token support are not.
- **The fine-grained token question** (whether it can open a pull request on an upstream repository you do not own) is inferred from GitHub's documentation and untested (Task 16, Step 4).
- **Node 24.** Everything ran on Node 26.4.0. `crypto.argon2Sync` exists there; the version that introduced it was not checked, so `defaultKdf` falls back to scrypt (N=2^17 with an explicit `maxmem`) when it is missing. That fallback is tested with small parameters and by value, not by running N=2^17 on Node 24. The CI matrix will show.
- **Ledger locking** was exercised with three concurrent processes on macOS. Network file systems and the stale-lock takeover race (two waiters clearing the same dead lock) are not tested; a repeated seq would be reported by `verifyChain`.
- **`gh auth status` and `git config --global`** behavior on Windows is assumed from the exit-status contract, not observed.
- **The result is not tamper-proof.** A same-user agent that reads the terminal or the unlock process's memory, or that uses an ambient `gh` login, can still publish. This is stated in ADR-0010 and in core spec §7.5.
