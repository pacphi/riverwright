import fs from 'node:fs';
import readline from 'node:readline';
import { UpfError } from './errors.mjs';

export function openTerminal({ platform = process.platform, paths } = {}) {
  const [inPath, outPath] = paths ?? (platform === 'win32' ? ['CONIN$', 'CONOUT$'] : ['/dev/tty', '/dev/tty']);
  let inFd;
  let outFd;
  try {
    inFd = fs.openSync(inPath, 'r');
    outFd = fs.openSync(outPath, 'w');
  } catch {
    if (inFd !== undefined) fs.closeSync(inFd);
    throw new UpfError('NO_TTY', 'Terminal approval needs a real terminal. Run this riverwright command yourself in a terminal window.');
  }
  const input = fs.createReadStream('', { fd: inFd, autoClose: true });
  const output = fs.createWriteStream('', { fd: outFd, autoClose: true });
  return { input, output, close() { input.destroy(); output.end(); } };
}

export async function confirmTyped({ terminal, question, expected }) {
  const rl = readline.createInterface({ input: terminal.input, output: terminal.output, terminal: false });
  try {
    const answer = await new Promise((resolve) => {
      rl.question(question, resolve);
      rl.once('close', () => resolve(''));
    });
    return answer.trim() === String(expected);
  } finally {
    rl.close();
    terminal.close?.();
  }
}
