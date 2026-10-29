import fs from 'node:fs';
import readline from 'node:readline';
import tty from 'node:tty';
import { StringDecoder } from 'node:string_decoder';
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
// noEcho is test-only: it is ignored for the streams openTerminal creates (tty.ReadStream, fs.ReadStream),
// so production code cannot use it to skip the echo check.
// Leftover characters after a newline stay in terminal.pending for the next read. The caller must enforce a
// minimum length: bare Enter returns an empty string.
function ignoreLateError() { /* the read is over; nothing to report and no text to leak */ }
const closedMessage = 'the terminal closed before a passphrase was entered';

// Whether readSecret could read from this terminal without echo. Callers that print before asking (the
// public gate) check it first, so a terminal that would echo gets nothing shown and nothing written.
export function canHideInput(terminal) {
  const input = terminal?.input;
  if (!input || !terminal.output) return false;
  const realStream = input instanceof tty.ReadStream || input instanceof fs.ReadStream;
  return typeof input.setRawMode === 'function' || (terminal.noEcho === true && !realStream);
}

export const noEchoControl = () => new RiverwrightError('NO_ECHO_CONTROL', 'This terminal cannot hide what you type, so Riverwright will not ask for a passphrase in it. Run the command in a normal terminal window.');

export function readSecret({ terminal, question }) {
  const { input, output } = terminal;
  const raw = typeof input.setRawMode === 'function';
  if (!canHideInput(terminal)) return Promise.reject(noEchoControl());
  return new Promise((resolve, reject) => {
    let value = '';
    let esc = 0; // 0 none, 1 after ESC, 2 inside a CSI sequence, 3 after ESC O (one more character)
    let settled = false;
    terminal.pending ??= '';
    terminal.decoder ??= new StringDecoder('utf8');
    const markEnded = () => { terminal.ended = true; terminal.pending = ''; };
    const cleanup = () => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('close', onClose);
      input.off('error', onError);
      output.off('error', onError);
      try { if (raw) input.setRawMode(false); } catch { /* the stream is already gone */ }
      try { input.pause?.(); } catch { /* ignore */ }
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { output.write('\n'); } catch { /* the output is already gone */ }
      cleanup();
      // A late asynchronous error (EPIPE on the newline, a destroy(err) after Enter) must not crash the process.
      for (const stream of [input, output]) stream.on('error', ignoreLateError);
      fn(arg);
    };
    const abort = (message) => finish(reject, new RiverwrightError('ABORTED', message));
    function onError() { finish(reject, new RiverwrightError('TERMINAL_ERROR', 'the terminal failed while a passphrase was being read')); }
    function onEnd() { markEnded(); abort(closedMessage); }
    function onClose() { markEnded(); abort(closedMessage); }
    const consume = (text) => {
      const chars = [...text];
      for (let i = 0; i < chars.length; i += 1) {
        const ch = chars[i];
        if (terminal.skipLF) {
          terminal.skipLF = false;
          if (ch === '\n') continue;
        }
        if (esc >= 2) {
          // Enter, Ctrl-C, Ctrl-D and a new ESC break out of an unfinished sequence and are handled normally.
          const breaksOut = ch === '\r' || ch === '\n' || ch === '\u0003' || ch === '\u0004' || ch === '\u001b';
          if (!breaksOut) {
            if (esc === 3 || /[@-~]/.test(ch)) esc = 0;
            continue;
          }
          esc = 0;
        }
        if (esc === 1) {
          if (ch === '[') { esc = 2; continue; }
          if (ch === 'O') { esc = 3; continue; }
          esc = 0; // a lone ESC: drop it and handle this character normally
        }
        if (ch === '\u001b') { esc = 1; continue; }
        if (ch === '\r' || ch === '\n') {
          terminal.skipLF = ch === '\r';
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
      else if (r.done === 'abort') abort('cancelled: no passphrase was entered');
      return r.done !== null;
    };
    function onData(chunk) {
      try { handle(typeof chunk === 'string' ? chunk : terminal.decoder.write(chunk)); } catch { onError(); }
    }
    try {
      output.on('error', onError);
      output.write(question);
      const carried = terminal.pending;
      terminal.pending = '';
      if (carried && handle(carried)) return;
      if (terminal.ended || input.readableEnded || input.destroyed) { abort(closedMessage); return; }
      if (raw) input.setRawMode(true);
      input.on('data', onData);
      input.on('end', onEnd);
      input.on('close', onClose);
      input.on('error', onError);
      input.resume?.();
    } catch {
      onError();
    }
  });
}
