import { toLf } from './fsx.mjs';

function lineOps(x, y) {
  const n = x.length;
  const m = y.length;
  if (n * m > 25_000_000) return [...x.map((s) => ['-', s]), ...y.map((s) => ['+', s])];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { ops.push([' ', x[i]]); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', x[i]]); i += 1; }
    else { ops.push(['+', y[j]]); j += 1; }
  }
  while (i < n) { ops.push(['-', x[i]]); i += 1; }
  while (j < m) { ops.push(['+', y[j]]); j += 1; }
  return ops;
}

export function unifiedDiff(a, b, { fromFile = 'a', toFile = 'b', context = 3 } = {}) {
  const x = toLf(a ?? '').split('\n');
  const y = toLf(b ?? '').split('\n');
  if (x.length && x.at(-1) === '') x.pop();
  if (y.length && y.at(-1) === '') y.pop();
  const ops = lineOps(x, y);
  if (!ops.some(([t]) => t !== ' ')) return '';
  let aLine = 1;
  let bLine = 1;
  const rows = ops.map(([t, s]) => {
    const row = { t, s, a: aLine, b: bLine };
    if (t !== '+') aLine += 1;
    if (t !== '-') bLine += 1;
    return row;
  });
  const hunks = [];
  let start = null;
  let stop = null;
  rows.forEach((r, k) => {
    if (r.t === ' ') return;
    const s = Math.max(0, k - context);
    const e = Math.min(rows.length - 1, k + context);
    if (start === null) { start = s; stop = e; } else if (s <= stop + 1) { stop = Math.max(stop, e); } else { hunks.push([start, stop]); start = s; stop = e; }
  });
  hunks.push([start, stop]);
  const out = [`--- ${fromFile}`, `+++ ${toFile}`];
  for (const [s, e] of hunks) {
    const slice = rows.slice(s, e + 1);
    const aCount = slice.filter((r) => r.t !== '+').length;
    const bCount = slice.filter((r) => r.t !== '-').length;
    const aStart = aCount ? slice.find((r) => r.t !== '+').a : slice[0].a - 1;
    const bStart = bCount ? slice.find((r) => r.t !== '-').b : slice[0].b - 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const r of slice) out.push(`${r.t}${r.s}`);
  }
  return `${out.join('\n')}\n`;
}
