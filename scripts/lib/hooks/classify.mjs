// Conservative: anything that could publish, rewrite remotes, or bypass git hooks counts as outward.
// A false alarm blocks one command inside the workspace; a miss could publish without approval.
const SEPARATORS = /\|\||&&|[;&|\n]|\$\(|`|\)/;
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const GH_OUTWARD = {
  pr: ['create', 'ready', 'comment', 'edit', 'merge', 'close', 'reopen', 'review'],
  issue: ['create', 'comment', 'edit', 'close', 'reopen', 'transfer', 'delete', 'lock', 'unlock'],
  repo: ['fork', 'create', 'delete', 'edit', 'rename', 'archive', 'sync'],
  release: ['create', 'upload', 'edit', 'delete'],
  gist: ['create', 'edit', 'delete'],
  secret: ['set', 'delete'],
  variable: ['set', 'delete'],
};

function tokens(segment) {
  return (segment.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s"']+/g) ?? []).map((t) => (/^["']/.test(t) ? t.slice(1, -1) : t));
}

function base(tok) {
  return String(tok).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

const outward = (rule, detail) => ({ outward: true, rule, detail });

function classifyGit(rest) {
  if (rest.some((t) => /core\.hookspath/i.test(t))) return outward('git-hooks-path', 'changing core.hooksPath');
  let sub = null;
  let i = 0;
  for (; i < rest.length; i += 1) {
    const t = rest[i];
    if (GIT_OPTS_WITH_VALUE.has(t)) { i += 1; continue; }
    if (t.startsWith('-')) continue;
    sub = t.toLowerCase();
    break;
  }
  const after = rest.slice(i + 1).map((t) => t.toLowerCase());
  if (sub === 'push') return outward('git-push', 'git push');
  if (sub === 'remote' && ['add', 'set-url', 'rename', 'remove', 'rm'].includes(after[0])) return outward('git-remote-change', `git remote ${after[0]}`);
  if (sub === 'config' && after.some((t) => /^(remote\.|credential|url\.|branch\.[^.]+\.(pushremote|remote)|push\.)/.test(t))) {
    return outward('git-config-remote', 'changing remote or credential settings');
  }
  return null;
}

function classifyGh(rest) {
  const words = [];
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    if (t === '-R' || t === '--repo') { i += 1; continue; }
    if (!t.startsWith('-')) words.push(t.toLowerCase());
  }
  const [area, action] = words;
  if (area === 'auth' && action === 'token') return outward('gh-auth-token', 'printing the GitHub token');
  if (GH_OUTWARD[area]?.includes(action)) return outward(`gh-${area}-${action}`, `gh ${area} ${action}`);
  if (area === 'api') {
    let method = null;
    let fields = false;
    for (let i = 0; i < rest.length; i += 1) {
      const t = rest[i];
      if (t === '-X' || t === '--method') method = String(rest[i + 1] ?? '').toLowerCase();
      else if (t.startsWith('--method=')) method = t.slice(9).toLowerCase();
      else if (/^(-f|-F|--field|--raw-field|--input)$/.test(t) || /^--(raw-)?field=|^--input=/.test(t)) fields = true;
    }
    if (method && method !== 'get') return outward('gh-api-write', `gh api ${method.toUpperCase()}`);
    if (!method && fields) return outward('gh-api-write', 'gh api with fields (sent as POST)');
  }
  return null;
}

function isUpfPublish(toks) {
  if (base(toks[0]) === 'upf') return ['submit', 'post'].includes(toks[1]);
  if (base(toks[0]) === 'node' && /upf\.mjs$/i.test(toks[1] ?? '')) return ['submit', 'post'].includes(toks[2]);
  return false;
}

export function classifyCommand(command, depth = 0) {
  const text = String(command ?? '').replace(/\\\r?\n/g, ' ');
  const segments = text.split(SEPARATORS).map((s) => s.trim()).filter(Boolean);
  if (depth === 0 && segments.length === 1 && isUpfPublish(tokens(segments[0]))) return { outward: false, upfPublish: true };
  for (const seg of segments) {
    const toks = tokens(seg);
    if (depth < 3) {
      for (const t of toks) {
        if (/\s/.test(t)) {
          const inner = classifyCommand(t, depth + 1);
          if (inner.outward) return inner;
        }
      }
    }
    const g = toks.findIndex((t) => base(t) === 'git');
    if (g !== -1) {
      const v = classifyGit(toks.slice(g + 1));
      if (v) return v;
    }
    const h = toks.findIndex((t) => base(t) === 'gh');
    if (h !== -1) {
      const v = classifyGh(toks.slice(h + 1));
      if (v) return v;
    }
  }
  return { outward: false };
}
