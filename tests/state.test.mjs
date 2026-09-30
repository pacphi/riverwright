import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  STATIONS, STATION_STATUSES, RUN_STATUSES, RUN_KINDS, STOP_REASONS, GATE_BEFORE,
  createState, nextStation, beginStation, completeStation, stopRun, reopenForChanges, validateState, saveState, loadState,
} from '../scripts/lib/state.mjs';
import { recordApproval, isApprovalValid, BRANCH } from '../scripts/lib/approvals.mjs';
import { HOSTS } from '../scripts/lib/hosts.mjs';
import { ROOT, tmpDir } from './helpers.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const fresh = () => createState({ runId: 'o/r#1', kind: 'fixture', now: 't0' });

function walkTo(state, target, head = A) {
  let s = state;
  for (const st of STATIONS) {
    if (st === target) return s;
    if (['passed', 'skipped'].includes(s.stations[st].status)) continue;
    const gate = GATE_BEFORE[st];
    if (gate) s = recordApproval(s, { gate, sha: head, mode: 'host-ask', now: 't' });
    s = beginStation(s, st, { now: 't', headSha: head });
    s = completeStation(s, st, 'passed', { now: 't' });
  }
  return s;
}

test('station names are the story contract', () => {
  assert.deepEqual(STATIONS, ['start', 'intake', 'recon', 'environment', 'reproduce', 'root-cause', 'fix', 'review', 'writeup', 'submit']);
});

test('a new run starts at "start" with Balanced budgets', () => {
  const s = fresh();
  assert.equal(nextStation(s), 'start');
  assert.deepEqual(s.budgets, { fixAttempts: 3, reviewRounds: 2 });
  assert.equal(s.status, 'active');
});

test('stations cannot be skipped', () => {
  assert.throws(() => beginStation(fresh(), 'recon', { now: 't' }), /cannot begin recon; the next station is start/);
});

test('root cause needs a checkpoint-1 approval for the same commit', () => {
  const s = walkTo(fresh(), 'root-cause');
  assert.throws(() => beginStation(s, 'root-cause', { now: 't' }), /needs --head/);
  assert.throws(() => beginStation(s, 'root-cause', { now: 't', headSha: A }), /checkpoint-1 has no approval/);
  const approved = recordApproval(s, { gate: 'checkpoint-1', sha: B, mode: 'host-ask', now: 't' });
  assert.throws(() => beginStation(approved, 'root-cause', { now: 't', headSha: A }), /no approval for commit/);
  assert.equal(beginStation(approved, 'root-cause', { now: 't', headSha: B }).current, 'root-cause');
});

test('submit needs a submit-gate approval for the commit being pushed', () => {
  const s = walkTo(fresh(), 'submit');
  assert.throws(() => beginStation(s, 'submit', { now: 't', headSha: B }), /submit-gate has no approval/);
});

test('a full walk ends in "submitted"', () => {
  let s = walkTo(fresh(), 'submit');
  s = recordApproval(s, { gate: 'submit-gate', sha: A, mode: 'host-ask', now: 't' });
  s = completeStation(beginStation(s, 'submit', { now: 't', headSha: A }), 'submit', 'passed', { now: 't' });
  assert.equal(s.status, 'submitted');
  assert.equal(nextStation(s), null);
});

test('review asking for changes sends the run back to fix, within the budget', () => {
  let s = walkTo(fresh(), 'review');
  s = completeStation(beginStation(s, 'review', { now: 't' }), 'review', 'changes-requested', { now: 't' });
  assert.equal(nextStation(s), 'fix');
  assert.equal(s.counters.reviewRounds, 1);
  s = walkTo(s, 'review');
  s = completeStation(beginStation(s, 'review', { now: 't' }), 'review', 'changes-requested', { now: 't' });
  assert.equal(s.status, 'active');
  s = walkTo(s, 'review');
  s = completeStation(beginStation(s, 'review', { now: 't' }), 'review', 'changes-requested', { now: 't' });
  assert.equal(s.status, 'stopped');
  assert.equal(s.stop.reason, 'review-budget-exhausted');
});

test('failed fixes stop the run when the budget runs out', () => {
  let s = walkTo(fresh(), 'fix');
  for (let i = 0; i < 3; i += 1) s = completeStation(beginStation(s, 'fix', { now: 't' }), 'fix', 'failed', { now: 't' });
  assert.equal(s.status, 'stopped');
  assert.equal(s.stop.reason, 'fix-budget-exhausted');
});

test('stopping marks the station in progress as failed and rejects unknown reasons', () => {
  const s = beginStation(fresh(), 'start', { now: 't' });
  assert.throws(() => stopRun(s, 'bored', { now: 't' }), /unknown stop reason/);
  const stopped = stopRun(s, 'issue-closed', { now: 't', note: 'closed upstream' });
  assert.equal(stopped.stations.start.status, 'failed');
  assert.deepEqual(stopped.stop, { reason: 'issue-closed', at: 't', note: 'closed upstream' });
  assert.throws(() => beginStation(stopped, 'start', { now: 't' }), /is stopped/);
});

test('a submitted run reopens at fix for maintainer changes and needs a new submit approval', () => {
  let s = walkTo(fresh(), 'submit');
  s = recordApproval(s, { gate: 'submit-gate', sha: A, mode: 'host-ask', now: 't' });
  s = completeStation(beginStation(s, 'submit', { now: 't', headSha: A }), 'submit', 'passed', { now: 't' });
  s = reopenForChanges(s, { now: 't2' });
  assert.equal(s.status, 'active');
  assert.equal(nextStation(s), 'fix');
  assert.equal(isApprovalValid(s, 'submit-gate', { sha: A }), false);
  assert.throws(() => reopenForChanges(fresh(), { now: 't' }), /only a submitted run/);
});

test('saveState and loadState round-trip and reject tampering', () => {
  const dir = tmpDir();
  saveState(dir, fresh());
  assert.equal(loadState(dir).runId, 'o/r#1');
  const f = path.join(dir, 'state.json');
  const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
  obj.stations.fix.status = 'done-ish';
  fs.writeFileSync(f, JSON.stringify(obj));
  assert.throws(() => loadState(dir), /station fix status/);
  assert.throws(() => validateState({ ...fresh(), runId: '../x#1' }), /runId/);
});

test('templates/state.schema.json lists the same enums as the code', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'state.schema.json'), 'utf8'));
  assert.deepEqual(schema.properties.stations.required, STATIONS);
  assert.deepEqual(schema.$defs.station.properties.status.enum, STATION_STATUSES);
  assert.deepEqual(schema.properties.status.enum, RUN_STATUSES);
  assert.deepEqual(schema.properties.kind.enum, RUN_KINDS);
  assert.deepEqual(schema.$defs.stopReason.enum, STOP_REASONS);
});

test('hosts recorded in state are known host ids or null', () => {
  assert.throws(() => beginStation(fresh(), 'start', { now: 't', host: 'vim' }), /unknown host/);
  assert.throws(() => recordApproval(fresh(), { gate: 'checkpoint-1', sha: A, mode: 'tty', host: 'vim', now: 't' }), /unknown host/);
  const s = beginStation(fresh(), 'start', { now: 't', host: 'gemini-cli' });
  assert.equal(s.stations.start.host, 'gemini-cli');
  assert.throws(() => validateState({ ...s, stations: { ...s.stations, start: { ...s.stations.start, host: 'vim' } } }), /host/);
});

test('templates/state.schema.json lists the same host ids and branch rule as the code', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'state.schema.json'), 'utf8'));
  assert.deepEqual(schema.$defs.station.properties.host.enum, [null, ...HOSTS]);
  assert.deepEqual(schema.$defs.approval.properties.host.enum, [null, ...HOSTS]);
  assert.equal(schema.$defs.approval.properties.branch.pattern, BRANCH.source.replace(/\\\//g, '/'));
});
