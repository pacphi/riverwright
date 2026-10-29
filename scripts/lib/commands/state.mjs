import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { RiverwrightError } from '../errors.mjs';
import { createState, beginStation, completeStation, stopRun, reopenForChanges, nextStation, loadState, saveState, stateFile } from '../state.mjs';
import { appendEvent } from '../ledger.mjs';
import { jsonPrintable } from '../printable.mjs';
import { nowIso } from '../clock.mjs';
import { assertHost } from '../hosts.mjs';
import { makeBinding } from '../approvals.mjs';
import { findNewestValidReceipt } from '../receipt.mjs';
import { readVault } from '../vault.mjs';
import { ledgerDirFor } from '../ledger.mjs';
import { workspaceHomeFromArg, runIdForRunDir } from '../paths.mjs';

const USAGE = 'usage: riverwright state <create|get|begin|complete|stop|reopen> --run <dir> [options]';

export async function run(args, io) {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      run: { type: 'string' }, id: { type: 'string' }, kind: { type: 'string', default: 'real' }, preset: { type: 'string', default: 'balanced' },
      host: { type: 'string' }, model: { type: 'string' }, head: { type: 'string' }, home: { type: 'string' }, note: { type: 'string' },
    },
  });
  // --home is honored only through the in-process test seam (io.testing, never set by scripts/riverwright.mjs),
  // as the guard does for runDir. From real argv it is refused, so a caller cannot choose the vault that proves
  // a public gate (ruling R20).
  const testHome = io.testing?.allowHomeOverride === true ? values.home : undefined;
  if (values.home !== undefined && testHome === undefined) {
    throw new RiverwrightError('BAD_FLAG', `"--home" is not accepted here: the submit proof always comes from your account's own Riverwright workspace. ${USAGE}`);
  }
  // The run is named on the command line, where the human sees it; no environment variable chooses it.
  const dir = values.run;
  if (!dir) throw new RiverwrightError('NO_RUN', 'pass --run <run directory>');
  const now = nowIso(io);
  const host = assertHost(values.host ?? null);
  const model = values.model ?? null;
  let state;
  switch (sub) {
    case 'create': {
      if (!values.id) throw new RiverwrightError('USAGE', 'riverwright state create needs --id owner/repo#number');
      if (fs.existsSync(stateFile(dir))) throw new RiverwrightError('RUN_EXISTS', `a run record already exists at ${dir}`);
      state = saveState(dir, createState({ runId: values.id, kind: values.kind, presetName: values.preset, now }));
      appendEvent(dir, { type: 'run-created', at: now, runId: state.runId, kind: state.kind, preset: state.preset });
      break;
    }
    case 'get':
      io.stdout.write(`${jsonPrintable(JSON.stringify(loadState(dir), null, 2))}\n`);
      return 0;
    case 'begin': {
      const [station] = positionals;
      const current = loadState(dir);
      // A public gate (the submit station) is proved by the newest signed, unused receipt in the ledger for this
      // run and this commit, checked against the vault key. state.json is never consulted for it. The vault and the
      // ledger are the account's real ones: the home comes from the password database (as in the guard), never from
      // the environment or a flag, and --run must resolve (symlinks followed) to <home>/<owner>/<repo>/runs/issue-<n>
      // with a state.json runId that matches that path (ruling R20).
      const publicProof = (gate, sha) => {
        const binding = makeBinding({ sha });
        try {
          const home = workspaceHomeFromArg(testHome);
          const located = runIdForRunDir(home, dir);
          if (!located || located.runId !== current.runId) return false;
          const found = findNewestValidReceipt({
            ledgerDir: ledgerDirFor(located.dir), publicKey: readVault(home).publicKey, gate, run: current.runId, nowMs: Date.parse(now), binding,
          });
          return found.ok;
        } catch (e) {
          if (e instanceof RiverwrightError) return false;
          throw e;
        }
      };
      state = saveState(dir, beginStation(current, station, { now, host, model, headSha: values.head, publicProof }));
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
      throw new RiverwrightError('USAGE', USAGE);
  }
  io.stdout.write(`${jsonPrintable(JSON.stringify({ runId: state.runId, status: state.status, current: state.current, next: nextStation(state), stop: state.stop }, null, 2))}\n`);
  return 0;
}
