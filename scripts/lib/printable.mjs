// Anything read from a file (ledger, vault, state, receipts) or the environment is cleaned before it is
// printed, so a tampered file cannot move the cursor, clear the screen, forge a line or reorder text. Covers
// every control (Cc: C0, DEL, C1 such as \x9b, which some terminals treat as an escape introducer), every
// format character (Cf: bidi overrides and isolates, zero-width characters, U+2060, BOM, tag characters) and
// the line and paragraph separators U+2028/9 (Zl, Zp).
const UNSAFE = '\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\ufeff';
const CONTROL = new RegExp(`[${UNSAFE}]`, 'gu');
const CONTROL_KEEP_LINES = new RegExp(`(?![\\n\\t])[${UNSAFE}]`, 'gu');
// JSON text: C0 is already escaped inside strings by JSON.stringify and the whitespace between tokens must
// stay, so only the rest is escaped.
const JSON_UNSAFE = new RegExp('[\\x7f-\\x9f\\p{Cf}\\p{Zl}\\p{Zp}\\ufeff]', 'gu');

export const printable = (value) => String(value).replace(CONTROL, '?');

// A short, quoted, control-free rendering of an untrusted value for use inside a message.
export function shown(value, max = 40) {
  let text = JSON.stringify(value);
  if (text === undefined) text = String(value);
  if (text.length > max) text = `${text.slice(0, max)}...`;
  return printable(text);
}

// For JSON text that is printed: escape the characters above as \uXXXX (one escape per UTF-16 unit) so the
// output is still the same JSON and safe on a terminal.
export const jsonPrintable = (text) => text.replace(JSON_UNSAFE, (c) => [...c].map((ch) => {
  let out = '';
  for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, '0')}`;
  return out;
}).join(''));

// For a whole message that may legitimately span lines: keeps \n and \t only.
export const printableLines = (value) => String(value).replace(CONTROL_KEEP_LINES, '?');
