import fs from 'node:fs';
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';
import { toLf } from './fsx.mjs';
import { normalizeRemoteUrl } from './giturl.mjs';

const ZERO = /^0+$/;
const deny = (reason) => ({ allow: false, reason });

export function parsePrePushLines(text) {
  return toLf(text).split('\n').filter((l) => l.trim()).map((l) => {
    const [localRef, localSha, remoteRef, remoteSha] = l.trim().split(/\s+/);
    return { localRef, localSha, remoteRef, remoteSha };
  });
}

export function decidePrePush({ remoteUrl, updates, forkUrl, approvedSha, approvedBranch = null }) {
  if (!forkUrl) return deny('This clone has no fork yet. Pushes happen only through "riverwright submit" after you approve the submit gate.');
  const dest = normalizeRemoteUrl(remoteUrl);
  if (!dest || dest !== normalizeRemoteUrl(forkUrl)) {
    return deny(`Push destination ${remoteUrl} is not your fork (${forkUrl}). Riverwright never pushes anywhere else.`);
  }
  if (!approvedSha) return deny('Nothing has been approved at the submit gate yet.');
  if (!approvedBranch) return deny('The submit-gate approval does not name a branch. Approve again with --branch riverwright/<number>-<slug>.');
  for (const u of updates) {
    if (!u.localSha || ZERO.test(u.localSha)) return deny(`Deleting ${u.remoteRef} is not allowed.`);
    if (!String(u.remoteRef).startsWith('refs/heads/riverwright/')) return deny(`Only branches named riverwright/… may be pushed (got ${u.remoteRef}).`);
    if (u.remoteRef !== `refs/heads/${approvedBranch}`) return deny(`Only the approved branch ${approvedBranch} may be pushed (got ${u.remoteRef}).`);
    if (u.localSha.toLowerCase() !== approvedSha) {
      return deny(`Commit ${u.localSha.slice(0, 12)} is not the approved commit ${approvedSha.slice(0, 12)}. Approve the new commit first.`);
    }
  }
  return { allow: true, reason: 'approved push to your fork' };
}

export function renderPrePushHook(scriptPath) {
  const p = String(scriptPath);
  if (!(path.posix.isAbsolute(p) || path.win32.isAbsolute(p))) throw new RiverwrightError('UNSAFE_PATH', 'script path must be absolute');
  if (/["$`%\r\n]/.test(p)) throw new RiverwrightError('UNSAFE_PATH', `path ${JSON.stringify(p)} cannot be quoted safely in every shell`);
  const template = fs.readFileSync(new URL('../../templates/pre-push.sh', import.meta.url), 'utf8');
  return template.replace('__RIVERWRIGHT_SCRIPT__', () => p.replace(/\\/g, '/'));
}
