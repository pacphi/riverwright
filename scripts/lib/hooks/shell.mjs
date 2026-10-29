// A small POSIX-shell lexer for the hook classifier. It resolves quoting and escapes the way the shell
// would (so `git "pu"sh` and `g\it push` read as `git push`), splits commands on operators, records
// redirects and here-documents, and marks every word whose value depends on an expansion or a
// substitution the classifier cannot see. It never evaluates anything. Each word also has a shape: its value
// with every expansion ($X, ${X}, $(...), backticks, <(...)) written as "*", so literal text can be told from text an
// expansion supplies.

const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const SPECIAL_PARAM = /[0-9@*#?$!-]/;

const ANSI_C = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

function newCommand(stdin = null) {
  // inputs: the targets of input redirects (<, <&, <>), also listed in redirects.
  return { words: [], redirects: [], inputs: [], heredocs: [], herestrings: [], stdin };
}

// Finds the ")" closing a "$(" or "<(" that starts at `start`, skipping quotes and escapes.
function findClose(src, start, open = '(', close = ')') {
  let depth = 1;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') { i += 1; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); if (j === -1) return -1; i = j; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) return -1;
      i = j;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

// Every reading of a command line a shell might act on, as [text, lex options] pairs. The classifier (classify.mjs)
// and the scope check (scope.mjs) both use these, so they never disagree about what a command says.
//   - A NUL (C1): bash cuts an ANSI-C segment at it, zsh and execve cut the whole word at it (see lex), and a raw NUL
//     in the text may be dropped by the shell that reads it.
//   - On Windows a backslash separates path segments and does not escape, so the text is also read with "/".
export function readingsOf(text, platform = process.platform) {
  const t = String(text ?? '');
  const readings = [[t, {}]];
  if (t.includes("$'") || t.includes('\0')) readings.push([t, { nul: 'word' }]);
  if (t.includes('\0')) readings.push([t.replaceAll('\0', ''), {}]);
  if (platform === 'win32' && t.includes('\\')) readings.push(...readings.map(([x, l]) => [x.replace(/\\/g, '/'), l]));
  return readings;
}

// NUL handling (Task 17 C1). A NUL cannot reach a program: execve ends every argument at its first NUL. Shells differ
// before that. bash cuts an ANSI-C $'...' segment at a decoded NUL and keeps the rest of the word ($'ab\0cd'ef is abef);
// zsh keeps the NUL in the word, so the program receives only the text before it (ab). `nul` picks the reading:
// 'segment' (bash, the default) or 'word' (zsh and execve). The classifier checks both.
export function lex(src, { nul = 'segment' } = {}) {
  const text = String(src ?? '');
  const n = text.length;
  const commands = [];
  let cur = newCommand();
  let word = null;
  let redirect = null;
  let incomplete = false;
  const pendingHeredocs = [];

  const startWord = () => {
    if (!word) word = { value: '', shape: '', dynamic: false, quoted: false, subs: [] };
    return word;
  };
  const endWord = () => {
    if (!word) return;
    if (nul === 'word') {
      const cut = (v) => { const z = v.indexOf('\0'); return z === -1 ? v : v.slice(0, z); };
      word.value = cut(word.value);
      word.shape = cut(word.shape);
    }
    if (redirect === 'heredoc' || redirect === 'heredoc-strip') {
      pendingHeredocs.push({ cmd: cur, delim: word.value, strip: redirect === 'heredoc-strip', quoted: word.quoted });
      cur.stdin = 'heredoc';
    } else if (redirect === 'herestring') {
      cur.herestrings.push(word);
      cur.stdin = 'herestring';
    } else if (redirect) {
      cur.redirects.push(word);
      if (redirect === 'in') cur.inputs.push(word);
      if (redirect === 'in' && !cur.stdin) cur.stdin = 'file';
    } else {
      cur.words.push(word);
    }
    word = null;
    redirect = null;
  };
  const endCommand = (nextStdin = null) => {
    endWord();
    if (redirect) incomplete = true;
    redirect = null;
    const done = cur;
    const kept = cur.words.length || cur.redirects.length || cur.herestrings.length || cur.stdin === 'heredoc';
    if (kept) commands.push(cur);
    cur = newCommand(nextStdin);
    if (nextStdin === 'pipe' && kept) cur.prev = done;
  };
  const readHeredocBodies = (from) => {
    let i = from;
    while (pendingHeredocs.length) {
      const h = pendingHeredocs.shift();
      const lines = [];
      let found = false;
      while (i < n) {
        const nl = text.indexOf('\n', i);
        const raw = text.slice(i, nl === -1 ? n : nl).replace(/\r$/, '');
        i = nl === -1 ? n : nl + 1;
        const line = h.strip ? raw.replace(/^\t+/, '') : raw;
        if (line === h.delim) { found = true; break; }
        lines.push(line);
      }
      // bash runs a here-document that reaches end of input anyway, so a missing delimiter is not an error.
      void found;
      h.cmd.heredocs.push({ text: lines.join('\n'), quoted: h.quoted });
    }
    return i;
  };

  // $... inside or outside double quotes. Returns the index after the expansion.
  const readDollar = (i, inDouble) => {
    const w = startWord();
    const next = text[i + 1];
    if (next === '(') {
      const arith = text[i + 2] === '(';
      const close = findClose(text, i + 2);
      if (close === -1) { incomplete = true; w.value += text.slice(i); w.shape += '*'; w.dynamic = true; return n; }
      const inner = text.slice(i + 2, close);
      w.value += text.slice(i, close + 1); w.shape += '*';
      w.dynamic = true;
      if (!arith) w.subs.push(inner);
      return close + 1;
    }
    if (next === '{') {
      const close = findClose(text, i + 2, '{', '}');
      if (close === -1) { incomplete = true; w.value += text.slice(i); w.shape += '*'; w.dynamic = true; return n; }
      w.value += text.slice(i, close + 1); w.shape += '*';
      w.dynamic = true;
      w.subs.push(text.slice(i + 2, close));
      return close + 1;
    }
    if (next === "'" && !inDouble) {
      let j = i + 2;
      let out = '';
      while (j < n && text[j] !== "'") {
        if (text[j] === '\\' && j + 1 < n) {
          const e = text[j + 1];
          let m;
          if (e in ANSI_C) { out += ANSI_C[e]; j += 2; }
          else if ((m = /^x([0-9A-Fa-f]{1,2})/.exec(text.slice(j + 1)))) { out += String.fromCodePoint(parseInt(m[1], 16)); j += 1 + m[0].length; }
          else if ((m = /^u([0-9A-Fa-f]{1,4})/.exec(text.slice(j + 1))) || (m = /^U([0-9A-Fa-f]{1,8})/.exec(text.slice(j + 1)))) {
            const cp = parseInt(m[1], 16);
            out += cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
            j += 1 + m[0].length;
          } else if ((m = /^([0-7]{1,3})/.exec(text.slice(j + 1)))) { out += String.fromCodePoint(parseInt(m[1], 8)); j += 1 + m[0].length; }
          else if (e === 'c' && j + 2 < n) { out += String.fromCharCode(text.charCodeAt(j + 2) & 0x1f); j += 3; }
          else { out += `\\${e}`; j += 2; }
        } else {
          out += text[j];
          j += 1;
        }
      }
      if (j >= n) incomplete = true;
      if (nul !== 'word' && out.includes('\0')) out = out.slice(0, out.indexOf('\0'));
      w.value += out; w.shape += out;
      w.quoted = true;
      return Math.min(j + 1, n);
    }
    if (next === '"' && !inDouble) return readDouble(i + 2);
    if (next !== undefined && NAME_START.test(next)) {
      let j = i + 2;
      while (j < n && NAME_CHAR.test(text[j])) j += 1;
      w.value += text.slice(i, j); w.shape += '*';
      w.dynamic = true;
      return j;
    }
    if (next !== undefined && SPECIAL_PARAM.test(next)) {
      w.value += text.slice(i, i + 2); w.shape += '*';
      w.dynamic = true;
      return i + 2;
    }
    w.value += '$'; w.shape += '$';
    return i + 1;
  };

  const readBacktick = (i) => {
    const w = startWord();
    let j = i + 1;
    while (j < n && text[j] !== '`') j += text[j] === '\\' ? 2 : 1;
    if (j >= n) { incomplete = true; w.value += text.slice(i); w.shape += '*'; w.dynamic = true; w.subs.push(text.slice(i + 1)); return n; }
    const inner = text.slice(i + 1, j).replace(/\\([`\\$])/g, '$1');
    w.value += text.slice(i, j + 1); w.shape += '*';
    w.dynamic = true;
    w.subs.push(inner);
    return j + 1;
  };

  function readDouble(start) {
    const w = startWord();
    w.quoted = true;
    let i = start;
    while (i < n && text[i] !== '"') {
      const c = text[i];
      if (c === '\\' && i + 1 < n) {
        const e = text[i + 1];
        if (e === '\n') { i += 2; continue; }
        if ('$`"\\'.includes(e)) { w.value += e; w.shape += e; i += 2; continue; }
        w.value += c; w.shape += c;
        i += 1;
        continue;
      }
      if (c === '$') { i = readDollar(i, true); continue; }
      if (c === '`') { i = readBacktick(i); continue; }
      w.value += c; w.shape += c;
      i += 1;
    }
    if (i >= n) { incomplete = true; return n; }
    return i + 1;
  }

  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '\n') { i += 2; continue; }
      if (text[i + 1] === '\r' && text[i + 2] === '\n') { i += 3; continue; }
      const w = startWord();
      if (i + 1 >= n) { w.value += '\\'; w.shape += '\\'; i += 1; continue; }
      w.value += text[i + 1]; w.shape += text[i + 1];
      w.quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const w = startWord();
      const j = text.indexOf("'", i + 1);
      w.quoted = true;
      if (j === -1) { incomplete = true; w.value += text.slice(i + 1); w.shape += text.slice(i + 1); i = n; continue; }
      w.value += text.slice(i + 1, j); w.shape += text.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"') { i = readDouble(i + 1); continue; }
    if (c === '$') { i = readDollar(i, false); continue; }
    if (c === '`') { i = readBacktick(i); continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { endWord(); i += 1; continue; }
    if (c === '\n') { endCommand(); i = readHeredocBodies(i + 1); continue; }
    if (c === '#' && !word) { const j = text.indexOf('\n', i); i = j === -1 ? n : j; continue; }
    if (c === ';') { endCommand(); i += text[i + 1] === ';' ? 2 : 1; continue; }
    if (c === '&') {
      if (text[i + 1] === '>') { endWord(); redirect = 'out'; i += text[i + 2] === '>' ? 3 : 2; continue; }
      endCommand();
      i += text[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '|') {
      if (text[i + 1] === '|') { endCommand(); i += 2; continue; }
      endCommand('pipe');
      i += text[i + 1] === '&' ? 2 : 1;
      continue;
    }
    // An extglob group (@(a|b), !(x), +(x), ?(x), *(x)) is part of its word.
    if (c === '(' && word && /[@!+?*]$/.test(word.shape)) {
      const close = findClose(text, i + 1);
      if (close === -1) { incomplete = true; word.value += text.slice(i); word.shape += text.slice(i); i = n; continue; }
      word.value += text.slice(i, close + 1);
      word.shape += text.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (c === '(' || c === ')' || c === '{' || c === '}') {
      // Braces only group at the start of a word; elsewhere (a{b,c}) they are ordinary characters.
      if ((c === '{' || c === '}') && word) { word.value += c; word.shape += c; i += 1; continue; }
      if ((c === '{' || c === '}') && !/[\s;&|()]/.test(text[i + 1] ?? ' ')) { { const w = startWord(); w.value += c; w.shape += c; } i += 1; continue; }
      // "rw (...)": fish and PowerShell pass the group's output as arguments, so the command records it.
      if (c === '(') cur.parenNext = true;
      endCommand();
      i += 1;
      continue;
    }
    if (c === '<' || c === '>') {
      if (word && /^\d+$/.test(word.value) && !word.quoted && !word.dynamic) word = null;
      else endWord();
      if (text[i + 1] === '(') {
        const close = findClose(text, i + 2);
        const w = startWord();
        w.dynamic = true;
        if (close === -1) { incomplete = true; w.subs.push(text.slice(i + 2)); i = n; continue; }
        w.subs.push(text.slice(i + 2, close));
        w.value += text.slice(i, close + 1); w.shape += '*';
        i = close + 1;
        continue;
      }
      if (c === '<') {
        if (text.startsWith('<<<', i)) { redirect = 'herestring'; i += 3; continue; }
        if (text.startsWith('<<-', i)) { redirect = 'heredoc-strip'; i += 3; continue; }
        if (text.startsWith('<<', i)) { redirect = 'heredoc'; i += 2; continue; }
        redirect = 'in';
        i += text[i + 1] === '&' || text[i + 1] === '>' ? 2 : 1;
        continue;
      }
      redirect = 'out';
      i += ['>', '|', '&'].includes(text[i + 1]) ? 2 : 1;
      continue;
    }
    { const w = startWord(); w.value += c; w.shape += c; }
    i += 1;
  }
  endCommand();
  if (pendingHeredocs.length) readHeredocBodies(n);
  return { commands, incomplete };
}

// cmd.exe escapes with ^ (g^it p^ush runs git push).
export const unCaret = (s) => String(s).replace(/\^([\s\S])/g, '$1');

// %NAME% (cmd.exe) is an expansion too.
const CMD_VAR = /%[A-Za-z_][A-Za-z0-9_]*%/;
export const isDynamic = (word) => Boolean(word?.dynamic) || CMD_VAR.test(String(word?.value ?? ''));

// True when any part of the command depends on a variable or substitution, including inside strings a
// nested shell would run.
export function hasUnresolved(command, depth = 0) {
  const { commands, incomplete } = lex(command);
  if (incomplete) return true;
  for (const cmd of commands) {
    for (const w of [...cmd.words, ...cmd.redirects, ...cmd.herestrings]) {
      if (isDynamic(w)) return true;
      if (depth < 4 && /\s/.test(w.value) && hasUnresolved(w.value, depth + 1)) return true;
    }
    for (const h of cmd.heredocs) if (!h.quoted && /[$`]/.test(h.text)) return true;
  }
  return false;
}
