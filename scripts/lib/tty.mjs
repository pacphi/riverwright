import fs from 'node:fs';
import readline from 'node:readline';
import tty from 'node:tty';
import { RiverwrightError } from './errors.mjs';

export function openTerminal({ platform = process.platform, paths } = {}) {
  const [inPath, outPath] = paths ?? (platform === 'win32' ? ['CONIN$', 'CONOUT$'] : ['/dev/tty', '/dev/tty']);
  let inFd;
  let outFd;
  try {
    inFd = fs.openSync(inPath, 'r');
    outFd = fs.openSync(outPath, 'w');
  } catch {
    if (inFd !== undefined) fs.closeSync(inFd);
    throw new RiverwrightError('NO_TTY', 'Terminal approval needs a real terminal. Run this riverwright command yourself in a terminal window.');
  }
  // A real terminal gets a tty.ReadStream, which can switch to raw mode so a passphrase is not echoed.
  const input = tty.isatty(inFd) ? new tty.ReadStream(inFd) : fs.createReadStream('', { fd: inFd, autoClose: true });
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

// Reads one secret line without echo. The terminal must be able to hide typing: a real terminal offers raw
// mode (input.setRawMode), a test terminal declares noEcho. Anything else is refused, because falling back
// to an echoing prompt would put the passphrase on screen and in the scrollback.
// Leftover characters after a newline stay in terminal.pending for the next read.
export function readSecret({ terminal, question }) {
  const { input, output } = terminal;
  const raw = typeof input.setRawMode === 'function';
  if (!raw && terminal.noEcho !== true) {
    return Promise.reject(new RiverwrightError('NO_ECHO_CONTROL', 'This terminal cannot hide what you type, so Riverwright will not ask for a passphrase in it. Run the command in a normal terminal window.'));
  }
  return new Promise((resolve, reject) => {
    let value = '';
    let esc = 0;
    terminal.pending ??= '';
    if (!terminal.watchingEnd) {
      terminal.watchingEnd = true;
      input.once('end', () => { terminal.ended = true; });
    }
    const finish = (fn, arg) => {
      input.off('data', onData);
      input.off('end', onEnd);
      if (raw) input.setRawMode(false);
      input.pause?.();
      output.write('\n');
      fn(arg);
    };
    const consume = (text) => {
      const chars = [...text];
      for (let i = 0; i < chars.length; i += 1) {
        const ch = chars[i];
        if (esc === 1) { esc = ch === '[' ? 2 : 0; continue; }
        if (esc === 2) { if (/[@-~]/.test(ch)) esc = 0; continue; }
        if (ch === '\u001b') { esc = 1; continue; }
        if (ch === '\r' || ch === '\n') {
          terminal.pending = chars.slice(i + 1).join('');
          return { done: 'ok' };
        }
        if (ch === '\u0003' || ch === '\u0004') return { done: 'abort' };
        if (ch === '\u007f' || ch === '\b') { value = [...value].slice(0, -1).join(''); continue; }
        if (ch < ' ') continue;
        value += ch;
      }
      return { done: null };
    };
    const handle = (text) => {
      const r = consume(text);
      if (r.done === 'ok') finish(resolve, value);
      else if (r.done === 'abort') finish(reject, new RiverwrightError('ABORTED', 'cancelled: no passphrase was entered'));
      return r.done !== null;
    };
    const onData = (chunk) => { handle(String(chunk)); };
    const onEnd = () => finish(reject, new RiverwrightError('ABORTED', 'the terminal closed before a passphrase was entered'));
    output.write(question);
    const carried = terminal.pending;
    terminal.pending = '';
    if (carried && handle(carried)) return;
    if (terminal.ended) { finish(reject, new RiverwrightError('ABORTED', 'the terminal closed before a passphrase was entered')); return; }
    if (raw) input.setRawMode(true);
    input.on('data', onData);
    input.on('end', onEnd);
    input.resume?.();
  });
}
