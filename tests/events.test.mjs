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
