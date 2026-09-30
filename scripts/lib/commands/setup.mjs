import { parseArgs } from 'node:util';
import { riverwrightHome } from '../paths.mjs';
import { version } from '../version.mjs';
import { openTerminal, confirmTyped } from '../tty.mjs';
import { inspectRepo, planIntegration, planRemoval, applyPlan, changedFiles } from '../project.mjs';
import { nowIso } from '../clock.mjs';

const USAGE = 'usage: riverwright setup --project [--repo PATH] [--dry-run | --yes | --no-input] [--team] [--remove]\n';

function printPlan(io, plan) {
  if (!plan.steps.length) {
    io.stdout.write(plan.mode === 'remove' ? 'Nothing from Riverwright was found in this repository.\n' : 'This repository is already set up. Nothing to change.\n');
    return;
  }
  for (const s of plan.steps) {
    io.stdout.write(`\n== ${s.file}: ${s.action}${s.reason ? ` (${s.reason})` : ''}\n`);
    if (s.action === 'print-snippet') io.stdout.write(`Add this yourself if you want it:\n${s.snippet}`);
    else if (s.diff) io.stdout.write(s.diff);
  }
}

export async function run(args, io) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: 'boolean', default: false },
      repo: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      'no-input': { type: 'boolean', default: false },
      team: { type: 'boolean', default: false },
      remove: { type: 'boolean', default: false },
    },
  });
  if (!values.project) {
    io.stderr.write(USAGE);
    return 2;
  }
  // A person runs setup, so RIVERWRIGHT_HOME is honored here. The pre-push guard and the host hook never
  // read it: they take --home (see workspaceHomeFromArg).
  const home = riverwrightHome(io.env);
  const now = nowIso(io);
  const info = inspectRepo(values.repo ?? io.cwd, { home });
  const plan = values.remove
    ? planRemoval(info, { home })
    : planIntegration(info, { version: version(), team: values.team, changed: await changedFiles(info.root) });
  printPlan(io, plan);
  const actionable = plan.steps.some((s) => ['create', 'update', 'delete'].includes(s.action));
  if (!actionable) return 0;
  if (values['dry-run'] || (values['no-input'] && !values.yes)) {
    io.stdout.write('\nDry run: nothing was changed.\n');
    return 0;
  }
  const confirm = values.yes
    ? async () => true
    : async (step) => {
      const terminal = io.openTerminal ? io.openTerminal() : openTerminal({ platform: io.platform });
      const verb = plan.mode === 'remove' ? 'Remove Riverwright changes from' : 'Apply this change to';
      return confirmTyped({ terminal, question: `${verb} ${step.file}? Type y to confirm: `, expected: 'y' });
    };
  const { results, backup } = await applyPlan(plan, { home, now, confirm });
  io.stdout.write('\n');
  for (const r of results) io.stdout.write(`${r.file}: ${r.result}${r.reason ? ` (${r.reason})` : ''}\n`);
  if (backup) io.stdout.write(`Backups: ${backup}\n`);
  io.stdout.write('Nothing was committed. Review the changes with git diff and commit them yourself.\n');
  return 0;
}
