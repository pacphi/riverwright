import fs from 'node:fs';
import path from 'node:path';
import { UpfError } from './errors.mjs';
import { readTextIfExists } from './fsx.mjs';

export const EVENT_TYPES = ['run-created', 'station-begin', 'station-complete', 'approval', 'stop', 'reopen', 'guard', 'note'];

export const ledgerFile = (dir) => path.join(dir, 'ledger.jsonl');

export function appendEvent(dir, event) {
  if (!EVENT_TYPES.includes(event?.type)) throw new UpfError('BAD_EVENT', `unknown ledger event "${event?.type}"`);
  if (!event.at) throw new UpfError('BAD_EVENT', 'a ledger event needs "at"');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(ledgerFile(dir), `${JSON.stringify(event)}\n`, 'utf8');
}

export function readLedger(dir) {
  const text = readTextIfExists(ledgerFile(dir));
  if (text === null) return [];
  const events = [];
  text.split('\n').forEach((line, i) => {
    if (line === '') return;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new UpfError('LEDGER_CORRUPT', `ledger line ${i + 1} is not valid JSON`);
    }
  });
  return events;
}
