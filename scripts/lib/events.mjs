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
