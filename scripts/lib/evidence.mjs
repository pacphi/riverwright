import fs from 'node:fs';
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';
import { HOSTS } from './hosts.mjs';
import { STATIONS, loadState } from './state.mjs';

export function buildEvidence({ states, hosts = {}, now }) {
  for (const [id, h] of Object.entries(hosts)) {
    if (!HOSTS.includes(id)) throw new RiverwrightError('UNKNOWN_HOST', `unknown host "${id}"`);
    if (![1, 2, 3].includes(h?.level)) throw new RiverwrightError('BAD_LEVEL', `host ${id} needs a level of 1, 2 or 3`);
  }
  return {
    schema: 'riverwright-evidence/1',
    generatedAt: now,
    generatedBy: 'riverwright evidence export',
    hosts,
    runs: states.map((s) => ({
      id: s.runId,
      kind: s.kind,
      status: s.status,
      stop: s.stop?.reason ?? null,
      stations: Object.fromEntries(STATIONS.map((n) => [n, {
        status: s.stations[n].status,
        at: s.stations[n].completedAt,
        host: s.stations[n].host,
        model: s.stations[n].model,
      }])),
      pr: s.pr ?? { url: null, state: null },
    })),
  };
}

const dirs = (p) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
};

export function collectRunStates(home) {
  const states = [];
  const skipped = [];
  for (const owner of dirs(home)) {
    for (const repo of dirs(path.join(home, owner))) {
      const runsDir = path.join(home, owner, repo, 'runs');
      for (const run of dirs(runsDir)) {
        const dir = path.join(runsDir, run);
        if (!fs.existsSync(path.join(dir, 'state.json'))) continue;
        try {
          states.push(loadState(dir));
        } catch (e) {
          skipped.push({ path: dir, reason: e.message });
        }
      }
    }
  }
  return { states, skipped };
}
