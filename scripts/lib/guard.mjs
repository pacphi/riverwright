import fs from 'node:fs';
import path from 'node:path';
import { UpfError } from './errors.mjs';
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

export function decidePrePush({ remoteUrl, updates, forkUrl, approvedSha }) {
  if (!forkUrl) return deny('This clone has no fork yet. Pushes happen only through "upf submit" after you approve the submit gate.');
  const dest = normalizeRemoteUrl(remoteUrl);
  if (!dest || dest !== normalizeRemoteUrl(forkUrl)) {
    return deny(`Push destination ${remoteUrl} is not your fork (${forkUrl}). upstream-pr-filer never pushes anywhere else.`);
  }
  if (!approvedSha) return deny('Nothing has been approved at the submit gate yet.');
  for (const u of updates) {
    if (!u.localSha || ZERO.test(u.localSha)) return deny(`Deleting ${u.remoteRef} is not allowed.`);
    if (!String(u.remoteRef).startsWith('refs/heads/upf/')) return deny(`Only branches named upf/… may be pushed (got ${u.remoteRef}).`);
    if (u.localSha.toLowerCase() !== approvedSha) {
      return deny(`Commit ${u.localSha.slice(0, 12)} is not the approved commit ${approvedSha.slice(0, 12)}. Approve the new commit first.`);
    }
  }
  return { allow: true, reason: 'approved push to your fork' };
}

export function renderPrePushHook(scriptPath) {
  const p = String(scriptPath);
  if (!(path.posix.isAbsolute(p) || path.win32.isAbsolute(p))) throw new UpfError('UNSAFE_PATH', 'script path must be absolute');
  if (/["$`%\r\n]/.test(p)) throw new UpfError('UNSAFE_PATH', `path ${JSON.stringify(p)} cannot be quoted safely in every shell`);
  const template = fs.readFileSync(new URL('../../templates/pre-push.sh', import.meta.url), 'utf8');
  return template.replace('__UPF_SCRIPT__', () => p.replace(/\\/g, '/'));
}
