// riverwright credential setup | status | remove (spec 7.5, ADR-0010). A person runs this in a terminal.
// The token and passphrase are read only from the terminal's hidden prompt: never from an argument, the
// environment or standard input, and they are never printed or written anywhere but the sealed vault.
import fs from 'node:fs';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { RiverwrightError } from '../errors.mjs';
import { riverwrightHome } from '../paths.mjs';
import { nowIso } from '../clock.mjs';
import { confirmTyped, openTerminal, readSecret } from '../tty.mjs';
import { checkPassphrase, checkToken, defaultKdf, fingerprint, readVault, sealVault, vaultFile, writeVault } from '../vault.mjs';
import { auditAmbient } from '../ambient.mjs';
import { clearPushKey, savePushKey, verifiedPushKey } from '../pushkey.mjs';

const USAGE = 'usage: riverwright credential <setup [--replace] | status | remove | push-key <set <file.pub> | show | clear>>';

import { printable } from '../printable.mjs';
export { printable };

const terminalOf = (io) => (io.openTerminal ? io.openTerminal() : openTerminal({ platform: io.platform }));

// parseArgs errors can quote the offending argument, which may be a token someone pasted by mistake.
// So its message is never shown; the usage line is.
function parseFlags(rest, allowReplace) {
  try {
    const options = allowReplace ? { replace: { type: 'boolean', default: false } } : {};
    const { values, positionals } = parseArgs({ args: rest, options, allowPositionals: true });
    if (positionals.length > 0) throw new Error('positional');
    return values;
  } catch {
    throw new RiverwrightError('USAGE', `${USAGE}. Secrets are never taken from arguments: they are typed at a hidden prompt.`);
  }
}

async function setup(values, io, home) {
  // Refuse before any prompt, so nothing is typed for a vault that will not be written.
  if (!values.replace && fs.existsSync(vaultFile(home))) {
    throw new RiverwrightError('VAULT_EXISTS', `a sealed credential already exists at ${vaultFile(home)}; pass --replace to overwrite it`);
  }
  if (values.replace && fs.existsSync(vaultFile(home))) {
    let shown = 'unreadable';
    try {
      shown = fingerprint(readVault(home).publicKey);
    } catch { /* a damaged vault can still be replaced */ }
    io.stdout.write(`Replacing the sealed credential with fingerprint ${printable(shown)}. The old token and key cannot be recovered.\n`);
  }
  const terminal = terminalOf(io);
  try {
    terminal.output.write('Riverwright will seal a GitHub token under a passphrase you choose. Nothing you type is shown.\n');
    const token = await readSecret({ terminal, question: 'GitHub token: ' });
    checkToken(token);
    const passphrase = await readSecret({ terminal, question: 'New passphrase (12+ characters): ' });
    checkPassphrase(passphrase);
    const again = await readSecret({ terminal, question: 'Type the passphrase again: ' });
    if (passphrase !== again) throw new RiverwrightError('MISMATCH', 'the two passphrases did not match; nothing was saved');
    // The weak-parameter allowance exists only for the in-process test seam; the entry point never sets io.testing.
    const testKdf = io.testing?.kdf;
    const vault = sealVault({ token, passphrase, kdf: testKdf ?? defaultKdf(), now: nowIso(io), allowWeakKdfForTests: Boolean(testKdf) });
    writeVault(home, vault, { replace: Boolean(values.replace) });
    io.stdout.write([
      `Sealed credential saved to ${vaultFile(home)}`,
      `Public-key fingerprint: ${fingerprint(vault.publicKey)}`,
      'Note the fingerprint: "riverwright credential status" shows it again, and it is how you know the receipts are yours.',
      'Type your passphrase only into a prompt started by "riverwright submit" or "riverwright post" in a terminal, never into a chat with an agent.',
      '',
    ].join('\n'));
  } finally {
    terminal.close?.();
  }
}

function pushKey(rest, io, home) {
  const [action, ...more] = rest;
  const arity = { set: 1, show: 0, clear: 0 }[action];
  if (arity === undefined || more.length !== arity) throw new RiverwrightError('USAGE', USAGE);
  if (action === 'set') {
    savePushKey(home, { publicKeyFile: more[0] });
    io.stdout.write(`Hardware push key set: ${printable(more[0])}\nA touch is required only if the key was made to require one; Riverwright cannot confirm that from the public key (create keys with -O verify-required). Pull requests and comments still use the sealed token.\n`);
  } else if (action === 'show') {
    const k = verifiedPushKey(home);
    io.stdout.write(k ? `Hardware push key: ${printable(k.publicKeyFile)} (${printable(k.type)})\n` : 'No hardware push key is set.\n');
  } else {
    clearPushKey(home);
    io.stdout.write('Hardware push key cleared.\n');
  }
  return 0;
}

async function status(io, home) {
  let vault = null;
  try {
    vault = readVault(home);
  } catch (e) {
    if (e.code !== 'NO_VAULT') throw e;
  }
  if (!vault) io.stdout.write(`No sealed credential yet (looked in ${printable(vaultFile(home))}). Run "riverwright credential setup" in a terminal.\n`);
  else io.stdout.write(`Sealed credential: ${printable(vaultFile(home))}\nKey derivation: ${printable(vault.kdf.name)}\nCreated: ${printable(vault.createdAt ?? 'unknown')}\n`);
  const findings = await auditAmbient({ env: io.env, userHome: os.userInfo().homedir });
  if (findings.length === 0) {
    io.stdout.write('No credential routes found that an agent could use without Riverwright.\n');
  } else {
    io.stdout.write('\nCredential routes an agent could use without Riverwright (Riverwright cannot remove these for you):\n');
    for (const f of findings) io.stdout.write(`  - ${printable(f.what)} ${printable(f.fix)}\n`);
  }
  // Last, so nothing printed above can scroll it away or pose as it.
  if (vault) io.stdout.write(`Public-key fingerprint: ${printable(fingerprint(vault.publicKey))}\n`);
  return 0;
}

async function remove(io, home) {
  if (!fs.existsSync(vaultFile(home))) throw new RiverwrightError('NO_VAULT', `no sealed credential to remove (looked in ${vaultFile(home)})`);
  const terminal = terminalOf(io);
  const ok = await confirmTyped({ terminal, question: `This deletes the sealed credential at ${vaultFile(home)}. Type "remove" to confirm: `, expected: 'remove' });
  if (!ok) throw new RiverwrightError('NOT_CONFIRMED', 'not removed');
  fs.rmSync(vaultFile(home));
  io.stdout.write('Sealed credential removed.\n');
}

export async function run(args, io) {
  const [sub, ...rest] = args;
  if (sub === 'push-key') return pushKey(rest, io, riverwrightHome(io.env));
  const values = parseFlags(rest, sub === 'setup');
  // A person runs this command, so RIVERWRIGHT_HOME is honored.
  const home = riverwrightHome(io.env);
  switch (sub) {
    case 'setup': await setup(values, io, home); return 0;
    case 'status': return status(io, home);
    case 'remove': await remove(io, home); return 0;
    default: throw new RiverwrightError('USAGE', USAGE);
  }
}
