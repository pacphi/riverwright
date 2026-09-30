import { UpfError } from './errors.mjs';
import { detectEol, toLf } from './fsx.mjs';

export const begin = (slug) => `<!-- BEGIN ${slug} -->`;
export const end = (slug) => `<!-- END ${slug} -->`;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function assertSlug(slug) {
  if (!SLUG_RE.test(String(slug))) throw new UpfError('BAD_SLUG', `"${slug}" is not a valid block name`);
}

export function splitLines(text) {
  const out = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') break;
    out.push({ text: m[1], eol: m[2] });
  }
  return out;
}

export function findRanges(texts, slug) {
  const b = begin(slug);
  const e = end(slug);
  const ranges = [];
  const orphans = [];
  let open = -1;
  texts.forEach((line, i) => {
    const t = line.trim();
    if (t === b) {
      if (open !== -1) orphans.push(open);
      open = i;
    } else if (t === e && open !== -1) {
      ranges.push([open, i]);
      open = -1;
    }
  });
  if (open !== -1) orphans.push(open);
  return { ranges, orphans };
}

const join = (lines) => lines.map((l) => l.text + l.eol).join('');

export function hasBlock(text, slug) {
  assertSlug(slug);
  return findRanges(splitLines(text ?? '').map((l) => l.text), slug).ranges.length > 0;
}

export function upsertBlock(text, slug, body) {
  assertSlug(slug);
  const src = text ?? '';
  const eol = detectEol(src);
  const lines = splitLines(src);
  const { ranges, orphans } = findRanges(lines.map((l) => l.text), slug);
  const blockTexts = [begin(slug), ...toLf(body).replace(/\n+$/, '').split('\n'), end(slug)];
  let out;
  let action;
  if (ranges.length) {
    const [s, e] = ranges[0];
    const tailEol = lines[e].eol;
    const block = blockTexts.map((t, i) => ({ text: t, eol: i === blockTexts.length - 1 ? tailEol : eol }));
    out = [...lines.slice(0, s), ...block, ...lines.slice(e + 1)];
    action = 'updated';
  } else if (lines.length === 0) {
    out = blockTexts.map((t) => ({ text: t, eol }));
    action = 'inserted';
  } else {
    const last = lines[lines.length - 1];
    const hadFinal = last.eol !== '';
    const prefix = hadFinal ? lines : [...lines.slice(0, -1), { text: last.text, eol }];
    const block = blockTexts.map((t, i) => ({ text: t, eol: i === blockTexts.length - 1 && !hadFinal ? '' : eol }));
    out = [...prefix, { text: '', eol }, ...block];
    action = 'inserted';
  }
  const result = join(out);
  return {
    text: result,
    changed: result !== src,
    action: result === src ? 'unchanged' : action,
    orphanedBegin: orphans.length > 0,
    duplicates: Math.max(0, ranges.length - 1),
  };
}

export function stripBlock(text, slug) {
  assertSlug(slug);
  const src = text ?? '';
  const lines = splitLines(src);
  const { ranges } = findRanges(lines.map((l) => l.text), slug);
  if (!ranges.length) return { text: src, removed: false };
  const [s, e] = ranges[0];
  let before = lines.slice(0, s);
  const after = lines.slice(e + 1);
  if (before.length && before[before.length - 1].text === '') before = before.slice(0, -1);
  if (after.length === 0 && lines[e].eol === '' && before.length) {
    before = [...before.slice(0, -1), { ...before[before.length - 1], eol: '' }];
  }
  return { text: join([...before, ...after]), removed: true };
}
