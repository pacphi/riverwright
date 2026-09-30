import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { UpfError } from './errors.mjs';
import { isInside, realish } from './paths.mjs';
import { readTextIfExists, writeFileAtomic, resolveWriteTarget } from './fsx.mjs';
import { upsertBlock, stripBlock, begin, end } from './blocks.mjs';
import { parseJsonStrict, addAbsentKeys, removeAddedKeys, formatJsonLike } from './jsonmerge.mjs';
import { unifiedDiff } from './diff.mjs';
import { runFile } from './exec.mjs';

export const SLUG = 'upstream-pr-filer';
export const REGISTRY = 'src/lib/hook-audit/agentic-dependency-constraints.json';
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
export const TEAM_SETTINGS = Object.freeze({
  extraKnownMarketplaces: { 'upstream-pr-filer': { source: { source: 'github', repo: 'agentic-incubator/upstream-pr-filer' } } },
  enabledPlugins: { 'upstream-pr-filer@upstream-pr-filer': true },
});
export const CURSOR_RULE = [
  '---',
  'description: How this repository sends fixes to upstream dependencies',
  'alwaysApply: false',
  '---',
  'Fixes to upstream dependencies go through upstream-pr-filer (`/upstream-contribute`).',
  'Never push to an upstream remote directly. Project settings: `.upstream-pr.json`.',
  '',
].join('\n');

// Every file upstream-pr-filer may ever create, update or delete in a repository (§12.6).
export const OWNED_TARGETS = Object.freeze([...INSTRUCTION_FILES, '.cursor/rules/upstream-pr-filer.mdc', '.upstream-pr.json', '.claude/settings.json']);
const SETTINGS_FILE = '.claude/settings.json';

// A path from a plan or a backup manifest is acted on only if it is one of the fixed targets and,
// with every symlink resolved, still lands inside the repository.
export function isSafeTarget(root, file) {
  if (typeof file !== 'string' || !OWNED_TARGETS.includes(file)) return false;
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || file.split(/[\\/]/).includes('..')) return false;
  return isInside(realish(path.join(root, file)), root);
}

export const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

export function blockBody(version) {
  return [
    `<!-- Managed by upstream-pr-filer ${version}. Update: upf setup --project · Remove: upf setup --project --remove -->`,
    '## Upstream contributions',
    'Fixes to upstream dependencies go through upstream-pr-filer (`/upstream-contribute`).',
    'Never push to an upstream remote directly. Project settings: `.upstream-pr.json`.',
  ].join('\n');
}

export function projectConfigText({ registry } = {}) {
  const config = { preset: 'balanced', upstreams: [] };
  if (registry) config.registry = registry;
  return `${JSON.stringify(config, null, 2)}\n`;
}

function linkedToAgents(abs) {
  try {
    return fs.lstatSync(abs).isSymbolicLink() && path.basename(fs.realpathSync(abs)).toLowerCase() === 'agents.md';
  } catch {
    return false;
  }
}

export function inspectRepo(repoRoot, { home }) {
  const root = realish(repoRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new UpfError('NO_REPO', `${repoRoot} is not a folder`);
  if (isInside(root, home)) {
    throw new UpfError('UPSTREAM_CLONE', 'This folder is inside the upstream-pr-filer workspace; project integration only applies to your own repositories.');
  }
  const at = (rel) => path.join(root, rel);
  const claudeText = readTextIfExists(at('CLAUDE.md'));
  const claudeImportsAgents = linkedToAgents(at('CLAUDE.md')) || (claudeText !== null && /^\s*@\.?\/?AGENTS\.md\s*$/m.test(claudeText));
  let geminiReadsAgents = linkedToAgents(at('GEMINI.md'));
  const geminiSettings = readTextIfExists(at('.gemini/settings.json'));
  if (geminiSettings !== null) {
    try {
      const fileName = parseJsonStrict(geminiSettings)?.context?.fileName;
      geminiReadsAgents ||= (Array.isArray(fileName) ? fileName : [fileName]).includes('AGENTS.md');
    } catch {
      // Unreadable Gemini settings: assume Gemini does not read AGENTS.md.
    }
  }
  return {
    root,
    has: {
      agents: fs.existsSync(at('AGENTS.md')),
      claude: claudeText !== null || linkedToAgents(at('CLAUDE.md')),
      gemini: fs.existsSync(at('GEMINI.md')),
      cursorDir: fs.existsSync(at('.cursor')),
      projectConfig: fs.existsSync(at('.upstream-pr.json')),
      agenticKitRegistry: fs.existsSync(at(REGISTRY)),
    },
    claudeImportsAgents,
    geminiReadsAgents,
  };
}

export async function changedFiles(root) {
  const r = await runFile('git', ['status', '--porcelain=v1', '-z'], { cwd: root });
  const out = new Set();
  if (r.code !== 0) return out;
  const parts = r.stdout.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i].slice(0, 2);
    out.add(parts[i].slice(3).replace(/\\/g, '/'));
    if (status[0] === 'R' || status[0] === 'C') i += 1;
  }
  return out;
}

function vet(info, step, changed) {
  const abs = path.join(info.root, step.file);
  const snippetOnly = (reason) => ({ file: step.file, kind: step.kind, action: 'print-snippet', reason, snippet: step.snippet, before: step.before, after: null });
  if (step.before !== null) {
    if (!isInside(resolveWriteTarget(abs), info.root)) return snippetOnly('it links to a file outside this repository');
    try {
      fs.accessSync(abs, fs.constants.W_OK);
    } catch {
      return snippetOnly('the file is read-only');
    }
    if (changed.has(step.file)) return snippetOnly('the file has uncommitted changes; commit or stash them first');
  }
  const action = step.before === null ? 'create' : 'update';
  const diff = unifiedDiff(step.before ?? '', step.after, { fromFile: step.before === null ? '/dev/null' : `a/${step.file}`, toFile: `b/${step.file}` });
  return { ...step, action, diff };
}

export function planIntegration(info, { version, team = false, changed = new Set() }) {
  const steps = [];
  const body = blockBody(version);
  const blockText = `${begin(SLUG)}\n${body}\n${end(SLUG)}\n`;
  const propose = (step) => {
    if (step.before !== step.after) steps.push(vet(info, step, changed));
  };

  const targets = [];
  if (info.has.agents || !info.has.claude) targets.push('AGENTS.md');
  if (info.has.claude && !info.claudeImportsAgents) targets.push('CLAUDE.md');
  if (info.has.gemini && !info.geminiReadsAgents) targets.push('GEMINI.md');
  for (const file of targets) {
    const before = readTextIfExists(path.join(info.root, file));
    propose({ file, kind: 'block', before, after: upsertBlock(before ?? '', SLUG, body).text, snippet: blockText });
  }

  const rule = '.cursor/rules/upstream-pr-filer.mdc';
  if (info.has.cursorDir && readTextIfExists(path.join(info.root, rule)) === null) {
    propose({ file: rule, kind: 'owned-file', before: null, after: CURSOR_RULE, snippet: CURSOR_RULE });
  }

  if (!info.has.projectConfig) {
    const text = projectConfigText({ registry: info.has.agenticKitRegistry ? REGISTRY : undefined });
    propose({ file: '.upstream-pr.json', kind: 'owned-file', before: null, after: text, snippet: text });
  }

  if (team) {
    const file = '.claude/settings.json';
    const before = readTextIfExists(path.join(info.root, file));
    const snippet = `${JSON.stringify(TEAM_SETTINGS, null, 2)}\n`;
    if (before === null) {
      propose({ file, kind: 'json', before, after: snippet, snippet, addedPaths: Object.keys(TEAM_SETTINGS).map((k) => [k]) });
    } else {
      let parsed = null;
      try {
        parsed = parseJsonStrict(before);
      } catch {
        steps.push({ file, kind: 'json', action: 'print-snippet', reason: 'the file is not strict JSON (it may contain comments), so it was left alone', snippet, before, after: null });
      }
      if (parsed) {
        const { result, added } = addAbsentKeys(parsed, TEAM_SETTINGS);
        if (added.length) propose({ file, kind: 'json', before, after: formatJsonLike(before, result), snippet, addedPaths: added });
      }
    }
  }
  return { root: info.root, mode: 'install', steps };
}

export function backupRoot(home, repoRoot) {
  const root = realish(repoRoot);
  const id = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
  return path.join(home, 'backups', `${path.basename(root)}-${id}`);
}

export async function applyPlan(plan, { home, now, confirm = async () => true }) {
  const dir = path.join(backupRoot(home, plan.root), String(now).replace(/[:.]/g, '-'));
  const manifest = { root: plan.root, createdAt: now, mode: plan.mode, steps: [] };
  const results = [];
  for (const step of plan.steps) {
    if (!['create', 'update', 'delete'].includes(step.action)) {
      results.push({ file: step.file, result: step.action === 'keep' ? 'kept' : 'snippet', reason: step.reason });
      continue;
    }
    if (!(await confirm(step))) {
      results.push({ file: step.file, result: 'declined' });
      continue;
    }
    // Re-checked here, right before touching the disk: the plan may be old or may not be ours.
    if (!isSafeTarget(plan.root, step.file)) {
      results.push({ file: step.file, result: 'refused', reason: 'it is not a file upstream-pr-filer manages inside this repository' });
      continue;
    }
    const abs = path.join(plan.root, step.file);
    if (step.before !== null) {
      const copy = path.join(dir, 'files', step.file);
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.writeFileSync(copy, step.before, 'utf8');
    }
    if (step.action === 'delete') fs.rmSync(abs);
    else writeFileAtomic(abs, step.after);
    manifest.steps.push({
      file: step.file,
      kind: step.kind,
      action: step.action,
      createdHash: step.action === 'create' ? sha256(step.after) : null,
      afterHash: step.after === null ? null : sha256(step.after),
      addedPaths: step.addedPaths ?? null,
    });
    results.push({ file: step.file, result: { create: 'created', update: 'updated', delete: 'deleted' }[step.action] });
  }
  if (manifest.steps.length) writeFileAtomic(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { results, backup: manifest.steps.length ? dir : null };
}

function installManifests(home, root) {
  const dir = backupRoot(home, root);
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    let m;
    try {
      const text = readTextIfExists(path.join(dir, name, 'manifest.json'));
      m = text === null ? null : JSON.parse(text);
    } catch {
      m = null;
    }
    // Backups live in a folder anyone with shell access can write, so a manifest is only a hint:
    // it must be for this exact repository, and each step is checked again below.
    if (!m || m.mode !== 'install' || m.root !== root || !Array.isArray(m.steps)) continue;
    out.push({ ...m, dir: path.join(dir, name) });
  }
  return out;
}

const isAddedPaths = (v) => Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length > 0 && p.every((k) => typeof k === 'string'));

// Whitespace outside strings removed, so a backup can be compared with JSON.stringify of its content.
function stripJsonWhitespace(text) {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let out = '';
  let inString = false;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += t[i + 1] ?? ''; i += 1; } else if (c === '"') inString = false;
    } else if (c === '"') { inString = true; out += c; } else if (!' \t\n\r'.includes(c)) out += c;
  }
  return out;
}

// True when `text` is `value` and nothing else: same data, no duplicate keys or odd escapes, differing
// from JSON.stringify only in whitespace. Then its bytes can be restored without restoring any content
// the backup might have gained.
function isFormattingOf(text, value) {
  let parsed;
  try {
    parsed = parseJsonStrict(text);
  } catch {
    return false;
  }
  return isDeepStrictEqual(parsed, value) && stripJsonWhitespace(text) === JSON.stringify(parsed);
}

function withDiff(step) {
  const diff = step.after === null
    ? unifiedDiff(step.before, '', { fromFile: `a/${step.file}`, toFile: '/dev/null' })
    : unifiedDiff(step.before, step.after, { fromFile: `a/${step.file}`, toFile: `b/${step.file}` });
  return { ...step, diff };
}

export function planRemoval(info, { home }) {
  const created = new Map();
  const merged = new Map();
  for (const m of installManifests(home, info.root)) {
    for (const s of m.steps) {
      if (!s || !isSafeTarget(info.root, s.file)) continue;
      // Latest create wins (a file can be created, removed and created again).
      if (s.action === 'create') created.set(s.file, s);
      if (s.kind === 'json' && s.action === 'update' && s.file === SETTINGS_FILE && isAddedPaths(s.addedPaths)) {
        // Earliest backup holds the original formatting; the latest afterHash says whether it is still ours.
        const prev = merged.get(s.file);
        merged.set(s.file, { ...s, backupCopy: prev?.backupCopy ?? path.join(m.dir, 'files', s.file), addedPaths: [...(prev?.addedPaths ?? []), ...s.addedPaths] });
      }
    }
  }
  const steps = [];

  for (const file of INSTRUCTION_FILES) {
    const abs = path.join(info.root, file);
    let st = null;
    try {
      st = fs.lstatSync(abs);
    } catch {
      st = null;
    }
    if (!st || st.isSymbolicLink()) continue;
    const before = fs.readFileSync(abs, 'utf8');
    const { text, removed } = stripBlock(before, SLUG);
    if (!removed) continue;
    if (created.has(file) && text === '') steps.push(withDiff({ file, kind: 'block', action: 'delete', before, after: null }));
    else steps.push(withDiff({ file, kind: 'block', action: 'update', before, after: text }));
  }

  for (const [file, s] of created) {
    if (INSTRUCTION_FILES.includes(file)) continue;
    const before = readTextIfExists(path.join(info.root, file));
    if (before === null) continue;
    if (sha256(before) === s.createdHash) {
      steps.push(withDiff({ file, kind: s.kind, action: 'delete', before, after: null }));
    } else if (s.kind === 'json' && file === SETTINGS_FILE && isAddedPaths(s.addedPaths)) {
      merged.set(file, { ...s, backupCopy: null });
    } else {
      steps.push({ file, kind: s.kind, action: 'keep', reason: 'changed since upstream-pr-filer created it, so it was left in place', before, after: null });
    }
  }

  for (const [file, s] of merged) {
    const before = readTextIfExists(path.join(info.root, file));
    if (before === null) continue;
    let parsed;
    try {
      parsed = parseJsonStrict(before);
    } catch {
      steps.push({ file, kind: 'json', action: 'keep', reason: 'no longer strict JSON; remove the upstream-pr-filer entries by hand', before, after: null });
      continue;
    }
    // The content written back is always what removeAddedKeys leaves. The backup copy only supplies the
    // original formatting, and only when it holds exactly that content.
    const { result, removed } = removeAddedKeys(parsed, s.addedPaths, TEAM_SETTINGS);
    if (!removed.length) continue;
    let after = formatJsonLike(before, result);
    if (s.backupCopy && sha256(before) === s.afterHash) {
      let original = null;
      try {
        original = readTextIfExists(s.backupCopy);
      } catch {
        original = null;
      }
      if (original !== null && isFormattingOf(original, result)) after = original;
    }
    steps.push(withDiff({ file, kind: 'json', action: 'update', before, after }));
  }
  return { root: info.root, mode: 'remove', steps };
}
