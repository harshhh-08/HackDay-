import assert from 'node:assert/strict';
import test from 'node:test';
import vectors from '../fixtures/redaction.json' with { type: 'json' };
import { approvalSignature, buildPlan, canonical, canTransition, cleanupWaitExpired, cleanDisplay, constants, equalSecret, hash } from '../../packages/contracts/domain.ts';
import { redact } from '../../packages/workflow/redact.ts';

const snapshot = { repository_id: 'checkout' as const, commit_sha: null, snapshot_sha256: 'a'.repeat(64), image: `sha256:${'b'.repeat(64)}` };

test('workflow cannot execute directly from intake or resume a terminal state', () => {
  assert.equal(canTransition('queued', 'running'), false);
  assert.equal(canTransition('awaiting_reporter', 'running'), false);
  assert.equal(canTransition('completed', 'analyzing'), false);
  assert.equal(canTransition('awaiting_approval', 'running'), true);
  assert.equal(canTransition('awaiting_reporter', 'finalizing'), true);
});
test('cleanup acknowledgement has a finite deadline independent of worker restarts', () => {
  const start = new Date('2026-10-25T00:00:00Z');
  const total = new Date('2026-10-26T00:00:00Z');
  assert.equal(cleanupWaitExpired(start, total, start.getTime() + 39999), false);
  assert.equal(cleanupWaitExpired(start, total, start.getTime() + 40000), true);
  assert.equal(cleanupWaitExpired(null, total, total.getTime() + 40000), true);
  assert.equal(cleanupWaitExpired(null, total, start.getTime()), false);
});
test('canonical hashing has a cross-language Unicode test vector', () => {
  assert.equal(canonical({ z: 'café', a: [1, true, null] }), '{"a":[1,true,null],"z":"café"}');
  assert.equal(hash({ z: 'café', a: [1, true, null] }), 'fafdedd93d19c910cbdda0aa3f0f91ee2f287edbd78d712e4fa39d41db0763c6');
  assert.throws(() => canonical({ missing: undefined }));
  assert.throws(() => canonical(Number.NaN));
  assert.throws(() => canonical(1.5));
});
test('approval identity changes with command, revision, image and budgets', () => {
  const plan = buildPlan(snapshot, constants.targets[0], 1);
  for (const mutate of [
    (p: any) => { p.argv.push('--unsafe'); },
    (p: any) => { p.repository.snapshot_sha256 = 'c'.repeat(64); },
    (p: any) => { p.repository.image = `sha256:${'c'.repeat(64)}`; },
    (p: any) => { p.limits.seconds++; },
    (p: any) => { p.repeats++; },
  ]) {
    const changed = structuredClone(plan); mutate(changed); assert.notEqual(hash(plan), hash(changed));
  }
});
test('a signed approval is bound to investigation, run and plan', () => {
  const key = 'test-only-key-never-use-in-production';
  const signature = approvalSignature(key, 'i1', 'r1', 'hash1');
  assert.notEqual(signature, approvalSignature(key, 'i1', 'r2', 'hash1'));
  assert.notEqual(signature, approvalSignature(key, 'i2', 'r1', 'hash1'));
  assert.notEqual(signature, approvalSignature(key, 'i1', 'r1', 'hash2'));
  assert.equal(equalSecret(signature, signature), true);
  assert.equal(equalSecret(signature, ''), false);
});
test('arbitrary commands and excessive repeats cannot become a fixture plan', () => {
  for (const target of ['../../etc/passwd', 'pytest; rm -rf /', 'tests/test_other.py']) assert.throws(() => buildPlan(snapshot, target, 1));
  for (const repeats of [0, 4, 1.5]) assert.throws(() => buildPlan(snapshot, constants.targets[0], repeats));
});
test('secret redaction follows shared vectors without logging secret values', () => {
  for (const [index, vector] of vectors.entries()) assert.ok(redact(vector.input).value === vector.output, `redaction vector ${index} failed`);
  const input = { nested: [{ logs: vectors[0].input }] };
  const result = redact(input);
  assert.ok(result.value.nested[0].logs === '[REDACTED]', 'nested secret was not redacted');
  assert.deepEqual(result.redactions, [{ field: 'nested.0.logs', kind: 'credential', count: 1 }]);
});
test('untrusted CLI output cannot emit terminal escape/control characters', () => {
  assert.equal(cleanDisplay('\x1b[2Jreport\x00\nnext'), '[2Jreport\nnext');
});
