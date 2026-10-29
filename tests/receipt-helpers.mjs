import path from 'node:path';
import { openVault, sealVault, writeVault } from '../scripts/lib/vault.mjs';
import { appendReceipt } from '../scripts/lib/receipt.mjs';
import { ledgerDirFor } from '../scripts/lib/ledger.mjs';

export const TOKEN = 'ghp_exampleTokenValue0123456789abcdefghij';
export const PASSPHRASE = 'correct horse battery staple';
export const NOW = '2026-10-02T14:03:11.000Z';
export const NOW_MS = Date.parse(NOW);
export const FAST_KDF = { name: 'argon2id', memory: 8, passes: 1, parallelism: 1 };

// Writes a real vault (small KDF parameters, so tests are fast) under `home` and returns its keys.
export function makeTestVault(home, { token = TOKEN, passphrase = PASSPHRASE } = {}) {
  const vault = sealVault({ token, passphrase, kdf: FAST_KDF, allowWeakKdfForTests: true });
  writeVault(home, vault, { replace: true });
  const { privateKey, publicKey } = openVault(vault, passphrase);
  return { privateKey, publicKey, passphrase, token };
}

// Appends a signed `approved` event for a public gate, the way an unlock does, to the run's ledger.
export function issueReceipt({ runDir, keys, gate = 'submit-gate', run = 'ruvnet/ruflo#3509', sha = 'a'.repeat(40), content, branch = 'riverwright/3509-codex', at = NOW }) {
  const binding = content === undefined ? { kind: 'sha', value: sha } : { kind: 'content', value: content };
  return appendReceipt({ ledgerDir: ledgerDirFor(runDir), privateKey: keys.privateKey, gate, run, binding, branch: gate === 'submit-gate' ? branch : null, at });
}

export const runDirIn = (home, owner = 'ruvnet', repo = 'ruflo', n = 3509) => path.join(home, owner, repo, 'runs', `issue-${n}`);

// A run that has been unlocked: a real vault under `home` and a signed, current receipt in the run's ledger.
// The receipt is dated now unless `at` is given, for tests that do not pin the clock.
export function armRun({ home, runDir, sha = 'a'.repeat(40), branch = 'riverwright/3509-codex', run = 'ruvnet/ruflo#3509', at = new Date().toISOString() }) {
  const keys = makeTestVault(home);
  issueReceipt({ runDir, keys, sha, branch, run, at });
  return keys;
}
