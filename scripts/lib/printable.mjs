// Anything read from a file (ledger, vault, state, receipts) or the environment is cleaned before it is
// printed, so a tampered file cannot move the cursor, clear the screen or forge a line. Covers C0, DEL,
// C1 (such as \x9b, which some terminals treat as an escape introducer) and U+2028/9.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

export const printable = (value) => String(value).replace(CONTROL, '?');

// A short, quoted, control-free rendering of an untrusted value for use inside a message.
export function shown(value, max = 40) {
  let text = JSON.stringify(value);
  if (text === undefined) text = String(value);
  if (text.length > max) text = `${text.slice(0, max)}...`;
  return printable(text);
}

// For JSON text that is printed: JSON.stringify escapes C0 but leaves C1 and U+2028/9 raw. Escape them
// as \uXXXX so the output is still the same JSON and safe on a terminal.
// eslint-disable-next-line no-control-regex
export const jsonPrintable = (text) => text.replace(/[\x7f-\x9f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// For a whole message that may legitimately span lines (error text, stack traces): keeps \n and \t only.
// eslint-disable-next-line no-control-regex
export const printableLines = (value) => String(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/g, '?');
