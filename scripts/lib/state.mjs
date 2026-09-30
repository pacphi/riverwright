import fs from 'node:fs';
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';
import { GATES, APPROVAL_MODES, BRANCH, isApprovalValid, revokeGate } from './approvals.mjs';
import { preset } from './presets.mjs';
import { readTextIfExists, writeFileAtomic } from './fsx.mjs';
import { normalizeRemoteUrl } from './giturl.mjs';
import { HOSTS, assertHost } from './hosts.mjs';

// Station names are the story contract (docs/story/paddling-upstream.html data-station values).
export const STATIONS = ['start', 'intake', 'recon', 'environment', 'reproduce', 'root-cause', 'fix', 'review', 'writeup', 'submit'];
export const STATION_STATUSES = ['pending', 'in-progress', 'passed', 'skipped', 'failed'];
export const RUN_STATUSES = ['active', 'submitted', 'stopped'];
export const RUN_KINDS = ['real', 'fixture'];
export const GATE_BEFORE = Object.freeze({ 'root-cause': 'checkpoint-1', submit: 'submit-gate' });
export const STOP_REASONS = [
  'issue-closed', 'issue-assigned', 'pr-exists', 'duplicate-found', 'ai-banned', 'policy-unclear', 'cannot-build',
  'fixed-upstream', 'not-reproducible', 'fix-budget-exhausted', 'review-budget-exhausted', 'user-stopped',
];
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*#[1-9]\d*$/;
const DONE = new Set(['passed', 'skipped']);
const pending = () => ({ status: 'pending', startedAt: null, completedAt: null, host: null, model: null });

export function createState({ runId, kind = 'real', presetName = 'balanced', now }) {
  if (!RUN_ID.test(String(runId)) || String(runId).includes('..')) throw new RiverwrightError('BAD_RUN_ID', `"${runId}" is not owner/repo#number`);
  if (!RUN_KINDS.includes(kind)) throw new RiverwrightError('BAD_KIND', `kind must be real or fixture, not "${kind}"`);
  const p = preset(presetName);
  return {
    schema: 'riverwright-state/1', runId, kind, preset: presetName, createdAt: now, status: 'active', current: null,
    stations: Object.fromEntries(STATIONS.map((s) => [s, pending()])),
    approvals: [],
    budgets: { fixAttempts: p.fixAttempts, reviewRounds: p.reviewRounds },
    counters: { fixAttempts: 0, reviewRounds: 0 },
    fork: null, pr: null, stop: null,
  };
}

export function nextStation(state) {
  return STATIONS.find((s) => !DONE.has(state.stations[s].status)) ?? null;
}

const withStation = (state, name, patch) => ({ ...state, stations: { ...state.stations, [name]: { ...state.stations[name], ...patch } } });

function assertActive(state) {
  if (state.status !== 'active') throw new RiverwrightError('RUN_NOT_ACTIVE', `run ${state.runId} is ${state.status}`);
}

export function beginStation(state, name, { now, host = null, model = null, headSha } = {}) {
  assertActive(state);
  assertHost(host);
  if (!STATIONS.includes(name)) throw new RiverwrightError('UNKNOWN_STATION', `unknown station "${name}"`);
  if (state.current) throw new RiverwrightError('STATION_IN_PROGRESS', `${state.current} is still in progress`);
  const next = nextStation(state);
  if (name !== next) throw new RiverwrightError('ILLEGAL_TRANSITION', `cannot begin ${name}; the next station is ${next ?? 'none'}`, { to: name, next });
  const gate = GATE_BEFORE[name];
  if (gate) {
    if (!headSha) throw new RiverwrightError('GATE_NEEDS_SHA', `${name} needs --head <commit> so the ${gate} approval can be checked`);
    if (!isApprovalValid(state, gate, { sha: headSha })) {
      throw new RiverwrightError('GATE_NOT_APPROVED', `${gate} has no approval for commit ${String(headSha).slice(0, 12)}`);
    }
  }
  return { ...withStation(state, name, { status: 'in-progress', startedAt: now, completedAt: null, host, model }), current: name };
}

export function stopRun(state, reason, { now, note = null } = {}) {
  if (state.status === 'stopped') throw new RiverwrightError('RUN_NOT_ACTIVE', `run ${state.runId} is already stopped`);
  if (!STOP_REASONS.includes(reason)) throw new RiverwrightError('BAD_STOP_REASON', `unknown stop reason "${reason}" (use one of: ${STOP_REASONS.join(', ')})`);
  const s = state.current ? withStation(state, state.current, { status: 'failed', completedAt: now }) : state;
  return { ...s, current: null, status: 'stopped', stop: { reason, at: now, note } };
}

export function completeStation(state, name, outcome, { now } = {}) {
  assertActive(state);
  if (state.current !== name) throw new RiverwrightError('NOT_CURRENT', `${name} is not the station in progress (current: ${state.current ?? 'none'})`);
  const allowed = name === 'review' ? ['passed', 'skipped', 'failed', 'changes-requested'] : ['passed', 'skipped', 'failed'];
  if (!allowed.includes(outcome)) throw new RiverwrightError('BAD_OUTCOME', `${outcome} is not a valid outcome for ${name}`);
  let s = { ...state, current: null };
  if (outcome === 'changes-requested') {
    const rounds = s.counters.reviewRounds + 1;
    s = { ...s, counters: { ...s.counters, reviewRounds: rounds } };
    if (rounds > s.budgets.reviewRounds) {
      return stopRun(withStation(s, 'review', { status: 'failed', completedAt: now }), 'review-budget-exhausted', { now });
    }
    for (const st of ['fix', 'review', 'writeup']) s = withStation(s, st, pending());
    return s;
  }
  s = withStation(s, name, { status: outcome, completedAt: now });
  if (outcome === 'failed' && name === 'fix') {
    const attempts = s.counters.fixAttempts + 1;
    s = { ...s, counters: { ...s.counters, fixAttempts: attempts } };
    if (attempts >= s.budgets.fixAttempts) return stopRun(s, 'fix-budget-exhausted', { now });
  }
  if (name === 'submit' && outcome === 'passed') s = { ...s, status: 'submitted' };
  return s;
}

export function reopenForChanges(state, { now } = {}) {
  if (state.status !== 'submitted') throw new RiverwrightError('NOT_SUBMITTED', 'only a submitted run can be reopened for maintainer changes');
  let s = revokeGate(state, 'submit-gate', { now });
  for (const st of ['fix', 'review', 'writeup', 'submit']) s = withStation(s, st, pending());
  return { ...s, status: 'active', counters: { fixAttempts: 0, reviewRounds: 0 } };
}

export function validateState(s) {
  const fail = (msg) => { throw new RiverwrightError('BAD_STATE', `state.json is invalid: ${msg}`); };
  if (!s || typeof s !== 'object') fail('not an object');
  if (s.schema !== 'riverwright-state/1') fail(`unknown schema ${s.schema}`);
  if (!RUN_ID.test(String(s.runId)) || String(s.runId).includes('..')) fail('runId');
  if (!RUN_KINDS.includes(s.kind)) fail('kind');
  if (!RUN_STATUSES.includes(s.status)) fail('status');
  const keys = Object.keys(s.stations ?? {});
  if (keys.length !== STATIONS.length || !STATIONS.every((k) => keys.includes(k))) fail('stations');
  const knownHost = (h) => h === null || h === undefined || HOSTS.includes(h);
  for (const k of STATIONS) if (!STATION_STATUSES.includes(s.stations[k]?.status)) fail(`station ${k} status`);
  for (const k of STATIONS) if (!knownHost(s.stations[k].host)) fail(`station ${k} host`);
  if (s.current !== null && !STATIONS.includes(s.current)) fail('current');
  if (!Array.isArray(s.approvals)) fail('approvals');
  for (const a of s.approvals) {
    if (!GATES.includes(a.gate) || !APPROVAL_MODES.includes(a.mode) || !['sha', 'content'].includes(a.binding?.kind)) fail('approvals');
    if (!knownHost(a.host)) fail('approval host');
    if (a.branch !== undefined && a.branch !== null && (!BRANCH.test(String(a.branch)) || String(a.branch).includes('..'))) fail('approval branch');
  }
  if (s.stop !== null && !STOP_REASONS.includes(s.stop?.reason)) fail('stop');
  return s;
}

export const stateFile = (dir) => path.join(dir, 'state.json');

export function loadState(dir) {
  const text = readTextIfExists(stateFile(dir));
  if (text === null) throw new RiverwrightError('NO_STATE', `no run record at ${stateFile(dir)}`);
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new RiverwrightError('BAD_STATE', 'state.json is not valid JSON');
  }
  return validateState(obj);
}

export function saveState(dir, state) {
  validateState(state);
  writeFileAtomic(stateFile(dir), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function setFork(state, url) {
  if (!normalizeRemoteUrl(url)) throw new RiverwrightError('BAD_FORK_URL', `"${url}" is not a fork URL`);
  return { ...state, fork: { url: String(url) } };
}

const subdirs = (p) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

// True when any run under the workspace may still act. A record that cannot be read or parsed counts
// as active, so a broken file makes the hook stricter, never looser.
export function hasActiveRun(home) {
  for (const owner of subdirs(home)) {
    for (const repo of subdirs(path.join(home, owner))) {
      const runs = path.join(home, owner, repo, 'runs');
      for (const run of subdirs(runs)) {
        let text;
        try {
          text = readTextIfExists(stateFile(path.join(runs, run)));
        } catch {
          return true;
        }
        if (text === null) continue;
        try {
          const status = JSON.parse(text)?.status;
          if (status !== 'stopped' && status !== 'submitted') return true;
        } catch {
          return true;
        }
      }
    }
  }
  return false;
}
