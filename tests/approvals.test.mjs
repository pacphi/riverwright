import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_MODES, GATES, checkBinding, contentHash, makeBinding, recordApproval, isApprovalValid, approvedSha, approvedBranch, revokeGate } from '../scripts/lib/approvals.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const base = { approvals: [] };

test('content hashes ignore CRLF versus LF', () => {
  assert.match(contentHash('x'), /^sha256:[0-9a-f]{64}$/);
  assert.equal(contentHash('x\r\ny\r\n'), contentHash('x\ny\n'));
});

test('a binding needs exactly one full SHA or content', () => {
  assert.throws(() => makeBinding({}), /exactly one/);
  assert.throws(() => makeBinding({ sha: A, content: 'x' }), /exactly one/);
  assert.throws(() => makeBinding({ sha: 'abc1234' }), /full commit SHA/);
  assert.deepEqual(makeBinding({ sha: A.toUpperCase() }), { kind: 'sha', value: A });
});

test('an approval is valid only for the approved commit', () => {
  const s = recordApproval(base, { gate: 'submit-gate', sha: A, mode: 'host-ask', now: 't1' });
  assert.equal(isApprovalValid(s, 'submit-gate', { sha: A }), true);
  assert.equal(isApprovalValid(s, 'submit-gate', { sha: B }), false);
  assert.equal(isApprovalValid(s, 'checkpoint-1', { sha: A }), false);
  assert.equal(approvedSha(s, 'submit-gate'), A);
});

test('a DCO sign-off changes the SHA, so the pre-sign-off approval stops counting', () => {
  let s = recordApproval(base, { gate: 'submit-gate', sha: A, mode: 'host-ask', now: 't1' });
  // The human attests; the commit is amended with Signed-off-by and becomes B.
  assert.equal(isApprovalValid(s, 'submit-gate', { sha: B }), false);
  s = recordApproval(s, { gate: 'submit-gate', sha: B, mode: 'host-ask', now: 't2' });
  assert.equal(isApprovalValid(s, 'submit-gate', { sha: B }), true);
  assert.equal(isApprovalValid(s, 'submit-gate', { sha: A }), false);
});

test('content approvals survive line-ending changes but not edits', () => {
  const s = recordApproval(base, { gate: 'post-comment', content: 'Thanks!\r\n', mode: 'tty', now: 't' });
  assert.equal(isApprovalValid(s, 'post-comment', { content: 'Thanks!\n' }), true);
  assert.equal(isApprovalValid(s, 'post-comment', { content: 'Thanks!!\n' }), false);
});

test('revokeGate voids the gate', () => {
  const s = revokeGate(recordApproval(base, { gate: 'submit-gate', sha: A, mode: 'host-ask', now: 't' }), 'submit-gate', { now: 't2' });
  assert.equal(isApprovalValid(s, 'submit-gate', { sha: A }), false);
  assert.equal(approvedSha(s, 'submit-gate'), null);
});

test('unknown gates and modes are rejected', () => {
  assert.throws(() => recordApproval(base, { gate: 'merge', sha: A, mode: 'host-ask', now: 't' }), /unknown gate/);
  assert.throws(() => recordApproval(base, { gate: 'submit-gate', sha: A, mode: 'auto', now: 't' }), /unknown approval mode/);
  assert.deepEqual(GATES, ['checkpoint-1', 'submit-gate', 'post-issue', 'post-comment']);
});

test('a submit-gate approval can name the run branch, and only a riverwright/ branch', () => {
  const s = recordApproval(base, { gate: 'submit-gate', sha: A, mode: 'tty', now: 't', branch: 'riverwright/3509-codex' });
  assert.equal(approvedBranch(s, 'submit-gate'), 'riverwright/3509-codex');
  assert.equal(approvedBranch(recordApproval(base, { gate: 'submit-gate', sha: A, mode: 'tty', now: 't', branch: 'refs/heads/riverwright/1-x' }), 'submit-gate'), 'riverwright/1-x');
  for (const bad of ['main', 'riverwright/../main', 'riverwright/a b', 'riverwright/', 'riverwright/x.lock', 'refs/heads/main']) {
    assert.throws(() => recordApproval(base, { gate: 'submit-gate', sha: A, mode: 'tty', now: 't', branch: bad }), /branch/, bad);
  }
});

test('unlock is an approval mode, only for the public gates', () => {
  assert.deepEqual(APPROVAL_MODES, ['host-ask', 'tty', 'unlock']);
  const s = recordApproval(base, { gate: 'submit-gate', binding: { kind: 'sha', value: A }, mode: 'unlock', now: 't', branch: 'riverwright/1-x' });
  assert.deepEqual(s.approvals[0].binding, { kind: 'sha', value: A });
  assert.equal(s.approvals[0].mode, 'unlock');
  assert.throws(() => recordApproval(base, { gate: 'checkpoint-1', binding: { kind: 'sha', value: A }, mode: 'unlock', now: 't' }), /unlock/);
  assert.throws(() => recordApproval(base, { gate: 'submit-gate', sha: A, mode: 'nope', now: 't' }), /host-ask, tty or unlock/);
});

test('checkBinding accepts only a full SHA or a sha256 content hash, and copies just kind and value', () => {
  const content = `sha256:${'c'.repeat(64)}`;
  assert.deepEqual(checkBinding({ kind: 'sha', value: A, extra: 1 }), { kind: 'sha', value: A });
  assert.deepEqual(checkBinding({ kind: 'content', value: content }), { kind: 'content', value: content });
  for (const bad of [undefined, null, {}, { kind: 'sha', value: 'abc' }, { kind: 'sha', value: A.toUpperCase() }, { kind: 'content', value: 'hello' }, { kind: 'other', value: A }]) {
    assert.throws(() => checkBinding(bad), (e) => e.code === 'BAD_BINDING', JSON.stringify(bad));
  }
});

test('recordApproval takes either a checked binding or a sha or content, never both', () => {
  assert.throws(() => recordApproval(base, { gate: 'submit-gate', binding: { kind: 'sha', value: A }, sha: A, mode: 'tty', now: 't' }), /binding/);
  assert.throws(() => recordApproval(base, { gate: 'submit-gate', binding: { kind: 'sha', value: 'abc' }, mode: 'tty', now: 't' }), (e) => e.code === 'BAD_BINDING');
});
