import { parseArgs } from 'node:util';
import os from 'node:os';
import { RiverwrightError } from '../errors.mjs';
import { ledgerDirFor } from '../ledger.mjs';
import { readEvents, verifyChain } from '../events.mjs';
import { readVault, vaultFile } from '../vault.mjs';
import { verifyReceipts, verifyConsumptions } from '../receipt.mjs';
import { workspaceHomeFromArg } from '../paths.mjs';
import { printable } from '../printable.mjs';

const USAGE = 'usage: riverwright ledger verify --run <run directory> [--head sha256:<hex>] [--seq <n>]';
const EXIT_CODES = 'exit 0: full pass (or nothing to sign-check); exit 1: a problem was found; exit 2: the chain is fine but receipt signatures could not be checked because there is no vault, so this is not a full pass';
const UNANCHORED = 'Note: without --head and --seq from a place the agent cannot write, this check cannot tell a cleanly cut tail (the last lines removed) from a shorter, valid ledger.';

export async function run(args, io) {
  const [sub, ...rest] = args;
  if (sub !== 'verify') throw new RiverwrightError('USAGE', `${USAGE}\n${EXIT_CODES}`);
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
  let receipts = 0;
  let unchecked = null; // the vault path, when receipts exist but could not be sign-checked
  if (result.ok) {
    // Key-free checks first: they run with or without a vault.
    problems.push(...verifyConsumptions({ ledgerDir }));
    receipts = readEvents(ledgerDir).filter((e) => e !== null && typeof e === 'object' && e.event === 'approved' && e.data?.receipt).length;
    // The public key comes from the account's vault (password database), never from the environment.
    let home;
    try {
      home = workspaceHomeFromArg(testHome, { userInfo: io.testing?.userInfo ?? os.userInfo });
    } catch (e) {
      if (e.code !== 'NO_HOME') throw e;
      throw new RiverwrightError('NO_HOME', 'cannot find your account\'s home directory, so the vault cannot be located; run this as the user who owns the Riverwright workspace');
    }
    try {
      const { publicKey } = readVault(home);
      problems.push(...verifyReceipts({ ledgerDir, publicKey }));
    } catch (e) {
      if (e.code === 'NO_VAULT') {
        if (receipts > 0) unchecked = vaultFile(home);
      } else if (e instanceof RiverwrightError) {
        throw e;
      } else {
        throw new RiverwrightError('BAD_VAULT', `cannot read the vault at ${printable(vaultFile(home))}: ${printable(e.code ?? e.message)}`);
      }
    }
  }
  if (problems.length) {
    const [first] = problems;
    io.stderr.write(`Ledger check failed at line ${printable(first.line)}: ${printable(first.reason)}\n`);
    if (problems.length > 1) io.stderr.write(`(${problems.length - 1} more problem${problems.length === 2 ? '' : 's'} follow)\n`);
    return 1;
  }
  const notice = values.head === undefined ? `${UNANCHORED}\n` : '';
  if (unchecked !== null) {
    io.stdout.write(`Chain OK; ${receipts} receipt signature${receipts === 1 ? '' : 's'} NOT checked: no vault at ${printable(unchecked)}; this is not a full pass\n${notice}`);
    return 2;
  }
  const checked = receipts === 0 ? '0 receipts, nothing to sign-check.' : `${receipts} receipt signature${receipts === 1 ? '' : 's'} checked against the vault key.`;
  io.stdout.write(`Ledger intact: ${printable(result.count)} events, seq ${printable(result.seq)}, head ${printable(result.head)}\n${checked}\n${notice}`);
  return 0;
}
