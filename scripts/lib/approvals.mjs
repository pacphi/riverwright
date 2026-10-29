import crypto from 'node:crypto';
import { RiverwrightError } from './errors.mjs';
import { toLf } from './fsx.mjs';
import { assertHost } from './hosts.mjs';

export const GATES = ['checkpoint-1', 'submit-gate', 'post-issue', 'post-comment'];
// `unlock` is a public gate approved by the passphrase unlock inside submit or post (ADR-0010). Only
// runPublicAction records it; `riverwright approve` refuses it.
export const APPROVAL_MODES = ['host-ask', 'tty', 'unlock'];
// The gates that publish (receipt.mjs PUBLIC_GATES; repeated here because receipt.mjs imports this module).
const UNLOCK_GATES = ['submit-gate', 'post-issue', 'post-comment'];
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CONTENT = /^sha256:[0-9a-f]{64}$/;

export function contentHash(text) {
  return `sha256:${crypto.createHash('sha256').update(toLf(String(text)), 'utf8').digest('hex')}`;
}

export function makeBinding({ sha, content } = {}) {
  if ((sha === undefined) === (content === undefined)) {
    throw new RiverwrightError('BAD_BINDING', 'approve exactly one of a commit SHA or a content file');
  }
  if (sha !== undefined) {
    const value = String(sha).toLowerCase();
    if (!SHA.test(value)) throw new RiverwrightError('BAD_SHA', `"${sha}" is not a full commit SHA`);
    return { kind: 'sha', value };
  }
  return { kind: 'content', value: contentHash(content) };
}

// Run branches are riverwright/<n>-<slug> (spec §3.4). A bare refs/heads/ prefix is accepted and dropped.
export const BRANCH = /^riverwright\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function normalizeBranch(branch) {
  const b = String(branch ?? '').replace(/^refs\/heads\//, '');
  if (!BRANCH.test(b) || b.includes('..') || b.endsWith('.lock') || b.endsWith('.')) {
    throw new RiverwrightError('BAD_BRANCH', `"${branch}" is not a run branch (riverwright/<number>-<slug>)`);
  }
  return b;
}

// A binding that was already computed (an unlock passes the one it verified) is checked, not recomputed.
export function checkBinding(binding) {
  const ok = (binding?.kind === 'sha' && SHA.test(binding.value)) || (binding?.kind === 'content' && CONTENT.test(binding.value));
  if (!ok) throw new RiverwrightError('BAD_BINDING', 'a binding is a full lowercase commit SHA or a sha256: content hash');
  return { kind: binding.kind, value: binding.value };
}

export function recordApproval(state, { gate, sha, content, binding: given, mode, host = null, now, branch }) {
  if (!GATES.includes(gate)) throw new RiverwrightError('UNKNOWN_GATE', `unknown gate "${gate}" (use ${GATES.join(', ')})`);
  if (!APPROVAL_MODES.includes(mode)) throw new RiverwrightError('UNKNOWN_MODE', `unknown approval mode "${mode}" (use host-ask, tty or unlock)`);
  if (mode === 'unlock' && !UNLOCK_GATES.includes(gate)) throw new RiverwrightError('UNKNOWN_MODE', `the unlock mode applies only to the public gates (${UNLOCK_GATES.join(', ')})`);
  if (given !== undefined && (sha !== undefined || content !== undefined)) throw new RiverwrightError('BAD_BINDING', 'pass a checked binding or a sha or content, not both');
  const binding = given === undefined ? makeBinding({ sha, content }) : checkBinding(given);
  const approval = { gate, binding, approvedAt: now, mode, host: assertHost(host), revoked: false };
  if (branch !== undefined && branch !== null) approval.branch = normalizeBranch(branch);
  return { ...state, approvals: [...state.approvals, approval] };
}

function latest(state, gate) {
  return [...state.approvals].reverse().find((a) => a.gate === gate && !a.revoked) ?? null;
}

export function isApprovalValid(state, gate, target) {
  const a = latest(state, gate);
  if (!a) return false;
  const want = makeBinding(target);
  return a.binding.kind === want.kind && a.binding.value === want.value;
}

export function approvedSha(state, gate) {
  const a = latest(state, gate);
  return a && a.binding.kind === 'sha' ? a.binding.value : null;
}

export function approvedBranch(state, gate) {
  return latest(state, gate)?.branch ?? null;
}

export function revokeGate(state, gate, { now }) {
  return {
    ...state,
    approvals: state.approvals.map((a) => (a.gate === gate && !a.revoked ? { ...a, revoked: true, revokedAt: now } : a)),
  };
}
