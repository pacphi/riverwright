import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { runFile } from './exec.mjs';
import { readBounded } from './fsx.mjs';

// Ruling R33-2. The environment of every git process the pre-push guard starts. It is built from an allowlist, never
// by copying the pushing shell's environment: that shell is the agent's, and variables such as
// GIT_TEST_COMMIT_GRAPH (reads the commit-graph whatever core.commitGraph says), GIT_OBJECT_DIRECTORY,
// GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_REPLACE_REF_BASE, GIT_CONFIG_PARAMETERS or GIT_CONFIG_COUNT change what git
// reads. Only what a process needs to start passes through (PATH; LANG and LC_ALL; on Windows SYSTEMROOT, TEMP,
// TMP, PATHEXT and COMSPEC, in whatever case the names have). HOME, USERPROFILE and XDG_CONFIG_HOME are left out:
// the global config is the null device, so git needs no home. GIT_DIR is left out too: git runs the hook from the
// top of the worktree being pushed, so git finds the same repository from the working directory.
// The rest is fixed: no system or global config, no prompts, no replace refs, no grafts, no lazy fetch from a
// promisor remote (a fetch would reach the network) and no optional lock files. "/dev/null" reads as an empty file
// and cannot be created or raced (finding M-4); Git for Windows maps it to NUL itself.
const PASS = ['PATH', 'LANG', 'LC_ALL'];
const PASS_WIN32 = ['SYSTEMROOT', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC'];
const NULL_DEVICE = '/dev/null';

export function guardGitEnv({ env = process.env, platform = process.platform } = {}) {
  const names = platform === 'win32' ? [...PASS, ...PASS_WIN32] : PASS;
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (names.includes(platform === 'win32' ? name.toUpperCase() : name)) out[name] = value;
  }
  return {
    ...out,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: NULL_DEVICE,
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

const HASH_OF = { sha1: { alg: 'sha1', hex: 40 }, sha256: { alg: 'sha256', hex: 64 } };
export const MAX_COMMITS = 10000;
export const MAX_BYTES = 64 * 1024 * 1024;
const MAX_HEADER = 256;
const SHALLOW_MAX = 64 * 1024 * 1024;

// Reads cat-file --batch output as Buffers (object bodies are bytes, never text). Chunks are joined only when
// enough bytes for the next read have arrived, so a large object is copied once.
function batchReader(stream) {
  let buf = Buffer.alloc(0);
  const chunks = [];
  let pending = 0;
  let ended = false;
  let wake = null;
  const poke = () => { const w = wake; wake = null; w?.(); };
  stream.on('data', (d) => { chunks.push(d); pending += d.length; poke(); });
  stream.on('end', () => { ended = true; poke(); });
  stream.on('error', () => { ended = true; poke(); });
  const more = () => new Promise((resolve) => { wake = resolve; });
  const join = () => { if (chunks.length) { buf = Buffer.concat([buf, ...chunks.splice(0)]); pending = 0; } };
  return {
    async line(max) {
      for (;;) {
        join();
        const i = buf.indexOf(0x0a);
        if (i >= 0 && i <= max) {
          const s = buf.subarray(0, i).toString('latin1');
          buf = buf.subarray(i + 1);
          return s;
        }
        if (i > max || buf.length > max || ended) return null;
        await more();
      }
    },
    async bytes(n) {
      while (buf.length + pending < n) {
        if (ended) return null;
        await more();
      }
      join();
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
  };
}

// The parents git itself would read from a commit body: the header must start with "tree <oid>", and the parents
// are the "parent <oid>" lines that follow it directly (git ignores a "parent" line anywhere else). The header must
// also be ended by a blank line: git takes a "parent" line only when more bytes follow it, and every commit git
// writes has the blank line, even with an empty message. Without it the answer is null (not verified; finding M-8).
// The body is scanned in place, never turned into one big string, and null is also the answer once there are more
// than `limit` parents: the walk could never read them all (finding M-9).
export function commitParents(body, hex, limit) {
  const end = body.indexOf('\n\n');
  if (end < 0) return null;
  const line = hex + 7; // "parent " + oid
  const hexOnly = (from, to) => {
    for (let i = from; i < to; i += 1) {
      const c = body[i];
      if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66))) return false;
    }
    return true;
  };
  const treeLine = 5 + hex;
  if (end < treeLine || body.toString('latin1', 0, 5) !== 'tree ' || !hexOnly(5, treeLine) || (end > treeLine && body[treeLine] !== 0x0a)) return null;
  const parents = [];
  let pos = treeLine + 1;
  while (pos + line <= end && body.toString('latin1', pos, pos + 7) === 'parent ' && hexOnly(pos + 7, pos + line)
    && (pos + line === end || body[pos + line] === 0x0a)) {
    if (parents.length >= limit) return null;
    parents.push(body.toString('latin1', pos + 7, pos + line));
    pos += line + 1;
  }
  // A line that starts with "parent " but is malformed stopped the loop: git calls such a commit unparseable (finding M-10).
  if (pos < end && body.toString('latin1', pos, pos + 7) === 'parent ') return null;
  return parents;
}

// Ruling R33-1. Is `ancestor` an ancestor of (or equal to) `descendant`? Answered without trusting git's history
// walk: git does not check an object's hash while it walks, and the clone is agent-writable, so a loose object
// rewritten in place (or a forged commit-graph) could add a parent. Here one `git cat-file --batch` (fixed argv, no
// shell, the allowlisted environment) hands over raw objects by id; each one's hash is recomputed from its type,
// size and content with the repository's object format and must equal the id that was asked for (never the id git
// prints back). Only commits are followed, and only through their parent lines. The walk is breadth-first from
// `descendant` and stops when it reaches `ancestor`.
// Every doubt is "not an ancestor": a hash mismatch, a missing object, an object that is not a commit, a commit the
// shallow file lists (its parents are cut off), more than `maxCommits` commits or `maxBytes` bytes read, a timeout,
// a SHA whose length does not fit the object format, or any git failure. Never throws.
export async function isVerifiedAncestor({ cwd, env, ancestor, descendant, maxCommits = MAX_COMMITS, maxBytes = MAX_BYTES, timeoutMs = 30000 }) {
  try {
    const info = await runFile('git', ['rev-parse', '--show-object-format', '--git-path', 'shallow'], { cwd, env, timeoutMs });
    if (info.code !== 0) return false;
    const [format, shallowPath] = info.stdout.split('\n');
    const h = HASH_OF[format];
    if (!h || !shallowPath) return false;
    const sha = new RegExp(`^[0-9a-f]{${h.hex}}$`);
    if (!sha.test(ancestor ?? '') || !sha.test(descendant ?? '')) return false;
    if (ancestor === descendant) return true;
    const shallowText = readBounded(path.resolve(cwd, shallowPath), SHALLOW_MAX);
    const shallow = new Set((shallowText ?? '').split('\n').map((l) => l.trim()).filter(Boolean));
    return await walk({ cwd, env, ancestor, descendant, h, shallow, maxCommits, maxBytes, timeoutMs });
  } catch {
    return false;
  }
}

function walk({ cwd, env, ancestor, descendant, h, shallow, maxCommits, maxBytes, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    let timer;
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.stdin?.destroy(); } catch { /* already closed */ }
      try { child?.kill(); } catch { /* already gone */ }
      resolve(answer);
    };
    try {
      child = spawn('git', ['--no-replace-objects', '-c', 'core.commitGraph=false', '-c', 'protocol.allow=never', 'cat-file', '--batch'], {
        cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false,
      });
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);
    child.on('error', () => finish(false));
    child.stdin.on('error', () => finish(false));
    const reader = batchReader(child.stdout);
    (async () => {
      const queue = [descendant];
      const seen = new Set(queue);
      let read = 0;
      let bytes = 0;
      for (let next = 0; next < queue.length; next += 1) {
        const id = queue[next];
        if (id === ancestor) return true;
        if (read >= maxCommits) return false;
        read += 1;
        child.stdin.write(`${id}\n`);
        const header = await reader.line(MAX_HEADER);
        const m = header && /^([0-9a-f]+) ([a-z]+) (\d+)$/.exec(header);
        if (!m || m[1] !== id || m[2] !== 'commit') return false;
        const size = Number(m[3]);
        bytes += size;
        if (!Number.isSafeInteger(size) || bytes > maxBytes) return false;
        const body = await reader.bytes(size + 1);
        if (!body || body[size] !== 0x0a) return false;
        const content = body.subarray(0, size);
        const actual = crypto.createHash(h.alg).update(`commit ${size}\0`, 'latin1').update(content).digest('hex');
        if (actual !== id) return false;
        if (shallow.has(id)) return false;
        const parents = commitParents(content, h.hex, maxCommits);
        if (!parents) return false;
        for (const p of parents) {
          if (!seen.has(p)) { seen.add(p); queue.push(p); }
        }
      }
      return false;
    })().then(finish, () => finish(false));
  });
}
