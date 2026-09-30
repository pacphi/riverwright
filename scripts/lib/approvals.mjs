import crypto from 'node:crypto';
import { UpfError } from './errors.mjs';
import { toLf } from './fsx.mjs';

export const GATES = ['checkpoint-1', 'submit-gate', 'post-issue', 'post-comment'];
export const APPROVAL_MODES = ['host-ask', 'tty'];
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function contentHash(text) {
  return `sha256:${crypto.createHash('sha256').update(toLf(String(text)), 'utf8').digest('hex')}`;
}

export function makeBinding({ sha, content } = {}) {
  if ((sha === undefined) === (content === undefined)) {
    throw new UpfError('BAD_BINDING', 'approve exactly one of a commit SHA or a content file');
  }
  if (sha !== undefined) {
    const value = String(sha).toLowerCase();
    if (!SHA.test(value)) throw new UpfError('BAD_SHA', `"${sha}" is not a full commit SHA`);
    return { kind: 'sha', value };
  }
  return { kind: 'content', value: contentHash(content) };
}

export function recordApproval(state, { gate, sha, content, mode, host = null, now }) {
  if (!GATES.includes(gate)) throw new UpfError('UNKNOWN_GATE', `unknown gate "${gate}" (use ${GATES.join(', ')})`);
  if (!APPROVAL_MODES.includes(mode)) throw new UpfError('UNKNOWN_MODE', `unknown approval mode "${mode}" (use host-ask or tty)`);
  const binding = makeBinding({ sha, content });
  return { ...state, approvals: [...state.approvals, { gate, binding, approvedAt: now, mode, host, revoked: false }] };
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

export function revokeGate(state, gate, { now }) {
  return {
    ...state,
    approvals: state.approvals.map((a) => (a.gate === gate && !a.revoked ? { ...a, revoked: true, revokedAt: now } : a)),
  };
}
