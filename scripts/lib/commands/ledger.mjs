import { parseArgs } from 'node:util';
import os from 'node:os';
import { RiverwrightError } from '../errors.mjs';
import { ledgerDirFor } from '../ledger.mjs';
import { readEvents, verifyChain } from '../events.mjs';
import { readVault } from '../vault.mjs';
import { verifyReceipts, verifyConsumptions } from '../receipt.mjs';
import { workspaceHomeFromArg } from '../paths.mjs';
import { printable } from '../printable.mjs';

const USAGE = 'usage: riverwright ledger verify --run <run directory> [--head sha256:<hex>] [--seq <n>]';
const UNANCHORED = 'Note: without --head and --seq from a place the agent cannot write, this check cannot tell a cleanly cut tail (the last lines removed) from a shorter, valid ledger.';

export async function run(args, io) {
  const [sub, ...rest] = args;
  if (sub !== 'verify') throw new RiverwrightError('USAGE', USAGE);
  const { values } = parseArgs({ args: rest, options: { run: { type: 'string' }, home: { type: 'string' }, head: { type: 'string' }, seq: { type: 'string' } } });
  if (!values.run) throw new RiverwrightError('NO_RUN', 'pass --run <run directory>');
  // --home is honored only through the in-process test seam (io.testing, never set by scripts/riverwright.mjs).
  // From real argv it is refused, so a caller cannot choose the vault whose key the receipts are checked
  // against (ruling R20). RIVERWRIGHT_HOME and the run directory's layout do not choose it either.
  const testHome = io.testing?.allowHomeOverride === true ? values.home : undefined;
  if (values.home !== undefined && testHome === undefined) {
    throw new RiverwrightError('BAD_FLAG', `"--home" is not accepted here: receipts are checked against the vault in your account's own Riverwright workspace. ${USAGE}`);
  }
  if (values.head !== undefined && !/^sha256:[0-9a-f]{64}$/.test(values.head)) throw new RiverwrightError('USAGE', '--head must look like sha256:<64 hex digits>');
  if (values.seq !== undefined && !/^[1-9]\d*$/.test(values.seq)) throw new RiverwrightError('USAGE', '--seq must be a positive whole number');
  const ledgerDir = ledgerDirFor(values.run);
  const result = verifyChain(ledgerDir, { expectHead: values.head ?? null, expectSeq: values.seq === undefined ? null : Number(values.seq) });
  const problems = [...result.problems];
  // Receipt checks need readable events; a broken chain is already reported, and a corrupt line makes readEvents throw.
  let receipts = null;
  if (result.ok) {
    problems.push(...verifyConsumptions({ ledgerDir }));
    // The public key comes from the account's vault (password database), never from the environment.
    const home = workspaceHomeFromArg(testHome, { userInfo: io.testing?.userInfo ?? os.userInfo });
    try {
      const { publicKey } = readVault(home);
      receipts = readEvents(ledgerDir).filter((e) => e !== null && typeof e === 'object' && e.event === 'approved' && e.data?.receipt).length;
      problems.push(...verifyReceipts({ ledgerDir, publicKey }));
    } catch (e) {
      if (e.code !== 'NO_VAULT') throw e;
    }
  }
  if (problems.length) {
    const [first] = problems;
    io.stderr.write(`Ledger check failed at line ${printable(first.line)}: ${printable(first.reason)}\n`);
    if (problems.length > 1) io.stderr.write(`(${problems.length - 1} more problem${problems.length === 2 ? '' : 's'} follow)\n`);
    return 1;
  }
  const checked = receipts === null ? 'No vault found in your account\'s Riverwright workspace, so receipt signatures were not checked.' : `${receipts} receipt signature${receipts === 1 ? '' : 's'} checked against the vault key.`;
  io.stdout.write(`Ledger intact: ${printable(result.count)} events, seq ${printable(result.seq)}, head ${printable(result.head)}\n${checked}\n${values.head === undefined && values.seq === undefined ? `${UNANCHORED}\n` : ''}`);
  return 0;
}
