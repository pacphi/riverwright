import { parseArgs } from 'node:util';
import { RiverwrightError } from '../errors.mjs';
import { ledgerDirFor } from '../ledger.mjs';
import { verifyChain } from '../events.mjs';
import { printable } from '../printable.mjs';

const USAGE = 'usage: riverwright ledger verify --run <run directory> [--head sha256:<hex>] [--seq <n>]';

export async function run(args, io) {
  const [sub, ...rest] = args;
  if (sub !== 'verify') throw new RiverwrightError('USAGE', USAGE);
  const { values } = parseArgs({ args: rest, options: { run: { type: 'string' }, head: { type: 'string' }, seq: { type: 'string' } } });
  if (!values.run) throw new RiverwrightError('NO_RUN', 'pass --run <run directory>');
  if (values.head !== undefined && !/^sha256:[0-9a-f]{64}$/.test(values.head)) throw new RiverwrightError('USAGE', '--head must look like sha256:<64 hex digits>');
  if (values.seq !== undefined && !/^[1-9]\d*$/.test(values.seq)) throw new RiverwrightError('USAGE', '--seq must be a positive whole number');
  const result = verifyChain(ledgerDirFor(values.run), { expectHead: values.head ?? null, expectSeq: values.seq === undefined ? null : Number(values.seq) });
  if (!result.ok) {
    const [first] = result.problems;
    io.stderr.write(`Ledger check failed at line ${printable(first.line)}: ${printable(first.reason)}\n`);
    if (result.problems.length > 1) io.stderr.write(`(${result.problems.length - 1} more problem${result.problems.length === 2 ? '' : 's'} follow)\n`);
    return 1;
  }
  io.stdout.write(`Ledger intact: ${printable(result.count)} events, seq ${printable(result.seq)}, head ${printable(result.head)}\n`);
  return 0;
}
