import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { UpfError } from '../errors.mjs';
import { createState, beginStation, completeStation, stopRun, reopenForChanges, nextStation, loadState, saveState, stateFile } from '../state.mjs';
import { appendEvent } from '../ledger.mjs';
import { nowIso } from '../clock.mjs';

const USAGE = 'usage: upf state <create|get|begin|complete|stop|reopen> --run <dir> [options]';

export async function run(args, io) {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      run: { type: 'string' }, id: { type: 'string' }, kind: { type: 'string', default: 'real' }, preset: { type: 'string', default: 'balanced' },
      host: { type: 'string' }, model: { type: 'string' }, head: { type: 'string' }, note: { type: 'string' },
    },
  });
  const dir = values.run ?? io.env.UPF_RUN_DIR;
  if (!dir) throw new UpfError('NO_RUN', 'pass --run <run directory> or set UPF_RUN_DIR');
  const now = nowIso(io.env);
  const host = values.host ?? null;
  const model = values.model ?? null;
  let state;
  switch (sub) {
    case 'create': {
      if (!values.id) throw new UpfError('USAGE', 'upf state create needs --id owner/repo#number');
      if (fs.existsSync(stateFile(dir))) throw new UpfError('RUN_EXISTS', `a run record already exists at ${dir}`);
      state = saveState(dir, createState({ runId: values.id, kind: values.kind, presetName: values.preset, now }));
      appendEvent(dir, { type: 'run-created', at: now, runId: state.runId, kind: state.kind, preset: state.preset });
      break;
    }
    case 'get':
      io.stdout.write(`${JSON.stringify(loadState(dir), null, 2)}\n`);
      return 0;
    case 'begin': {
      const [station] = positionals;
      state = saveState(dir, beginStation(loadState(dir), station, { now, host, model, headSha: values.head }));
      appendEvent(dir, { type: 'station-begin', at: now, station, host, model });
      break;
    }
    case 'complete': {
      const [station, outcome] = positionals;
      state = saveState(dir, completeStation(loadState(dir), station, outcome, { now }));
      appendEvent(dir, { type: 'station-complete', at: now, station, outcome });
      if (state.status === 'stopped') appendEvent(dir, { type: 'stop', at: now, reason: state.stop.reason, note: null });
      break;
    }
    case 'stop': {
      const [reason] = positionals;
      state = saveState(dir, stopRun(loadState(dir), reason, { now, note: values.note ?? null }));
      appendEvent(dir, { type: 'stop', at: now, reason, note: values.note ?? null });
      break;
    }
    case 'reopen':
      state = saveState(dir, reopenForChanges(loadState(dir), { now }));
      appendEvent(dir, { type: 'reopen', at: now });
      break;
    default:
      throw new UpfError('USAGE', USAGE);
  }
  io.stdout.write(`${JSON.stringify({ runId: state.runId, status: state.status, current: state.current, next: nextStation(state), stop: state.stop }, null, 2)}\n`);
  return 0;
}
