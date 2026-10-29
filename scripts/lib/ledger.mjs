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
