import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// For commands a person runs (init, state, setup, evidence), which may honor RIVERWRIGHT_HOME.
// The pre-push guard and the host hook never call this: see workspaceHomeFromArg.
export function riverwrightHome(env = process.env) {
  const v = env.RIVERWRIGHT_HOME && String(env.RIVERWRIGHT_HOME).trim();
  return path.resolve(v || path.join(os.homedir(), '.riverwright'));
}

// The workspace home for the pre-push guard and the host hook. It comes from their --home argument,
// which the generated hook files carry, or else from the account's home directory as the operating
// system records it (os.userInfo(): the password database, or the user profile on Windows). The
// environment is never read: an agent can export RIVERWRIGHT_HOME or HOME in its shell and point these
// checks at a tree it forged, and os.homedir() follows HOME.
export function workspaceHomeFromArg(value, { userInfo = os.userInfo } = {}) {
  if (value !== undefined && value !== null) {
    const v = String(value);
    if (!v.trim() || !path.isAbsolute(v)) throw new RiverwrightError('BAD_HOME', `--home must be an absolute path (got ${JSON.stringify(v)})`);
    return path.resolve(v);
  }
  let dir = null;
  try {
    dir = userInfo().homedir;
  } catch {
    dir = null;
  }
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    throw new RiverwrightError('NO_HOME', 'cannot find your account\'s home directory; pass --home <absolute path of the Riverwright workspace>');
  }
  return path.join(dir, '.riverwright');
}

export function assertRepoName(kind, value) {
  if (typeof value !== 'string' || !NAME.test(value) || value.includes('..')) {
    throw new RiverwrightError('BAD_NAME', `${kind} "${value}" is not a valid GitHub name`);
  }
  return value;
}

export function parseIssueRef(ref) {
  const m = /^(?:https:\/\/github\.com\/)?([^/\s#]+)\/([^/\s#]+?)(?:\.git)?(?:\/issues\/|#)(\d+)\/?$/.exec(String(ref ?? '').trim());
  if (!m || Number(m[3]) < 1) throw new RiverwrightError('BAD_ISSUE_REF', `"${ref}" is not an issue URL or owner/repo#number`);
  return { owner: assertRepoName('owner', m[1]), repo: assertRepoName('repo', m[2]), number: Number(m[3]) };
}

export function runId({ owner, repo, number }) {
  return `${owner}/${repo}#${number}`;
}

export function repoDir(home, owner, repo) {
  return path.join(home, assertRepoName('owner', owner), assertRepoName('repo', repo));
}

export function runDir(home, { owner, repo, number }) {
  if (!Number.isInteger(number) || number < 1) throw new RiverwrightError('BAD_ISSUE_NUMBER', `issue number ${number} is not valid`);
  return path.join(repoDir(home, owner, repo), 'runs', `issue-${number}`);
}

export function realish(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    return path.join(realish(parent), path.basename(abs));
  }
}

export function isInside(child, parent) {
  const rel = path.relative(realish(parent), realish(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function runDirForPath(home, p) {
  if (!isInside(p, home)) return null;
  const parts = path.relative(realish(home), realish(p)).split(path.sep);
  const [owner, repo, area, issue] = parts;
  if (area !== 'worktrees' || !/^issue-\d+$/.test(issue ?? '')) return null;
  return path.join(realish(home), owner, repo, 'runs', issue);
}
