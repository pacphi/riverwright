import fs from 'node:fs';
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';
import { toLf } from './fsx.mjs';
import { normalizeRemoteUrl, namesRepository } from './giturl.mjs';
import { SHA } from './approvals.mjs';

const ZERO = /^0+$/;
const deny = (reason, code) => ({ allow: false, reason, ...(code ? { code } : {}) });

// One line per ref git is about to push: "<local ref> <local sha> <remote ref> <remote sha>". Exactly four
// fields, each SHA 40 or 64 hex digits (lowercased), CRLF tolerated. Anything else is refused, so later code
// (Task 14 reads remoteSha for its fast-forward check) never sees a field that was not there.
export function parsePrePushLines(text) {
  return toLf(text).split('\n').filter((l) => l.trim()).map((l, i) => {
    const f = l.trim().split(/\s+/);
    if (f.length !== 4) throw new RiverwrightError('BAD_PUSH_LINE', `push line ${i + 1} must have four fields (local ref, local sha, remote ref, remote sha)`);
    const [localRef, localSha, remoteRef, remoteSha] = f;
    for (const sha of [localSha, remoteSha]) {
      if (!SHA.test(sha.toLowerCase())) throw new RiverwrightError('BAD_PUSH_LINE', `push line ${i + 1}: "${sha}" is not a full commit SHA (40 or 64 hex digits)`);
    }
    return { localRef, localSha: localSha.toLowerCase(), remoteRef, remoteSha: remoteSha.toLowerCase() };
  });
}

// Every value named approved* comes from the newest verified receipt; forkUrl comes from state.json, which an
// agent can write, so it is never enough on its own.
// - upstream: the receipt's signed run ("owner/repo#n"). A push to that repository is refused in any URL form (R16(a)).
// - approvedFork: the fork the receipt signed (host/owner/repo). The destination must be exactly that repository
//   (R16(b)), so a forged fork.url cannot send the approved commit anywhere else. A receipt without one allows nothing.
// - approvedLease (ADR-0012): when the receipt carries one, the only update allowed is replacing exactly that remote
//   tip with the approved commit. Without one, an update whose remote tip is not all zeros must be a fast-forward:
//   `fastForward === true`, which the guard command asks of git; anything else counts as a replacement.
export function decidePrePush({ remoteUrl, updates, forkUrl, approvedSha, approvedFork = null, approvedBranch = null, approvedLease = null, upstream = null }) {
  const upstreamRepo = /^([^/#\s]+\/[^/#\s]+)#\d+$/.exec(String(upstream ?? ''))?.[1];
  if (upstreamRepo && namesRepository(remoteUrl, upstreamRepo)) {
    return deny(`Push destination ${remoteUrl} is the upstream repository (${upstreamRepo}), not your fork. Riverwright never pushes there.`);
  }
  if (!forkUrl) return deny('This clone has no fork yet. Pushes happen only through "riverwright submit" after you approve the submit gate.');
  const dest = normalizeRemoteUrl(remoteUrl);
  if (!dest || dest !== normalizeRemoteUrl(forkUrl)) {
    return deny(`Push destination ${remoteUrl} is not your fork (${forkUrl}). Riverwright never pushes anywhere else.`);
  }
  if (!approvedSha) return deny('Nothing has been unlocked at the submit gate yet. Pushes happen only through "riverwright submit".', 'NOTHING_UNLOCKED');
  if (!approvedFork) return deny('The submit-gate receipt does not name the fork it approved. Run "riverwright submit" again to approve this push.');
  if (dest !== approvedFork) return deny(`Push destination ${remoteUrl} is not the fork you approved (${approvedFork}). Riverwright never pushes anywhere else.`);
  if (!approvedBranch) return deny('The submit-gate receipt does not name a branch.');
  for (const u of updates) {
    if (!u.localSha || ZERO.test(u.localSha)) return deny(`Deleting ${u.remoteRef} is not allowed.`);
    if (!String(u.remoteRef).startsWith('refs/heads/riverwright/')) return deny(`Only branches named riverwright/… may be pushed (got ${u.remoteRef}).`);
    if (u.remoteRef !== `refs/heads/${approvedBranch}`) return deny(`Only the approved branch ${approvedBranch} may be pushed (got ${u.remoteRef}).`);
    if (u.localSha !== approvedSha) {
      return deny(`Commit ${u.localSha.slice(0, 12)} is not the approved commit ${approvedSha.slice(0, 12)}. Run "riverwright submit" again to approve the new commit.`);
    }
    if (typeof u.remoteSha !== 'string' || !SHA.test(u.remoteSha)) return deny(`The push of ${u.remoteRef} does not say what the fork branch holds now.`);
    const remoteTip = ZERO.test(u.remoteSha) ? null : u.remoteSha;
    if (approvedLease) {
      if (remoteTip !== approvedLease) {
        return deny(`The fork branch holds ${remoteTip ? remoteTip.slice(0, 12) : 'nothing'}, which is not the commit you approved replacing (${approvedLease.slice(0, 12)}).`);
      }
    } else if (remoteTip && u.fastForward !== true) {
      return deny(`The fork branch already holds ${remoteTip.slice(0, 12)}, which this push would replace. Only a re-submit that you approve with "riverwright submit" may replace it.`);
    }
  }
  // Git runs the hook with no lines when nothing is to be updated (up to date, or every ref refused by git itself,
  // such as a stale lease). Nothing is pushed then, and the ledger says so rather than "approved push" (finding M-5).
  if (!updates.length) return { allow: true, reason: 'nothing to push: git named no ref to update' };
  return { allow: true, reason: 'approved push to your fork' };
}

function assertHookPath(p, what) {
  if (!(path.posix.isAbsolute(p) || path.win32.isAbsolute(p))) throw new RiverwrightError('UNSAFE_PATH', `${what} must be absolute`);
  if (/["$`%\r\n]/.test(p)) throw new RiverwrightError('UNSAFE_PATH', `path ${JSON.stringify(p)} cannot be quoted safely in every shell`);
}

// The hook fixes the workspace home with --home (when given; otherwise the guard uses the account's
// ~/.riverwright), so neither RIVERWRIGHT_HOME nor HOME in the pushing shell can move it. "--" keeps git's
// remote name and URL from being read as options (a remote can be named "--home=/elsewhere").
export function renderPrePushHook(scriptPath, { home } = {}) {
  const p = String(scriptPath);
  assertHookPath(p, 'script path');
  let homeArg = '';
  if (home !== undefined && home !== null) {
    const h = String(home).replace(/[\\/]+$/, '');
    assertHookPath(h, 'workspace home');
    homeArg = ` --home "${h.replace(/\\/g, '/')}"`;
  }
  const template = fs.readFileSync(new URL('../../templates/pre-push.sh', import.meta.url), 'utf8');
  return template.replace('__RIVERWRIGHT_SCRIPT__', () => p.replace(/\\/g, '/')).replace('__RIVERWRIGHT_HOME_ARG__', () => homeArg);
}
