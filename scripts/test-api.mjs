// Recipient-run acceptance checks. This script never starts or installs services.
// Full mode explicitly approves only the registered fixture; control-plane-only
// mode performs no execution and works with the real runner disabled/unavailable.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.BUGOUT_API_URL;
const token = process.env.BUGOUT_TOKEN;
const controlOnly = process.argv.includes('--control-plane-only');
if (!base || !token || new URL(base).origin !== base || new URL(base).hostname !== '127.0.0.1' || new URL(base).protocol !== 'http:') throw new Error('Configure the loopback API and local token first');
const checks = [];
const createdIds = [];
async function call(path, { body, method, key = randomUUID(), expected = 200, auth = token, accept = 'application/json' } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'error',
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), 'content-type': 'application/json', 'idempotency-key': key, accept },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `Unexpected ${response.status} from ${path}`);
  if (response.status === 204) return null;
  return accept === 'application/json' ? response.json() : response.text();
}
async function wait(id, state) {
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    const status = await call(`/v1/investigations/${id}`);
    if (status.job_status === state) return status;
    assert.ok(!['failed', 'cancelled', 'completed'].includes(status.job_status), `Unexpected terminal state ${status.job_status}, wanted ${state}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${state}`);
}
async function create(extra = {}, key = randomUUID()) {
  const body = { title: 'Acceptance fixture', description: 'Checkout sometimes gives the wrong total.', ...extra };
  const result = await call('/v1/investigations', { body, key, expected: 202 });
  createdIds.push(result.investigation_id);
  return { id: result.investigation_id, body, key, result };
}

await call('/health', { auth: null });
const ready = await call('/ready', { expected: controlOnly ? [200, 503] : 200 });
assert.equal(ready.dependencies.database, true);
assert.equal(ready.dependencies.engine, true);
if (!controlOnly) assert.equal(ready.dependencies.runner, true);
await call('/v1/investigations', { body: {}, auth: null, expected: 401 });
await call('/v1/investigations', { body: { title: 'Missing description' }, expected: 400 });
await call('/v1/investigations', { body: { title: 'Too big', description: 'x'.repeat(70000) }, expected: 413 });
// Individually valid before redaction, oversized after redaction expansion.
await call('/v1/investigations', { body: { title: 'token=a '.repeat(24), description: 'Bounded input' }, expected: 400 });
checks.push('authentication, required fields, body cap and post-redaction bounds');

const incomplete = await create({ logs: 'password=synthetic-private-api-value' });
assert.deepEqual(await call('/v1/investigations', { body: incomplete.body, key: incomplete.key, expected: 202 }), incomplete.result);
await call('/v1/investigations', { body: { ...incomplete.body, title: 'Changed' }, key: incomplete.key, expected: 409 });
const waiting = await wait(incomplete.id, 'awaiting_reporter');
assert.equal(waiting.runs.length, 0);
assert.ok(!JSON.stringify(waiting).includes('synthetic-private-api-value'), 'Synthetic private content leaked');
await call(`/v1/investigations/${incomplete.id}/report`, { expected: 409 });
await call(`/v1/investigations/${incomplete.id}/replies`, { body: { round_id: randomUUID(), answers: [{ question_id: 'test_target', answer: 'invalid' }] }, expected: 409 });
await call(`/v1/investigations/${incomplete.id}/cancel`, { body: { reason: 'Acceptance cancellation before execution' }, expected: 202 });
const cancelled = await wait(incomplete.id, 'cancelled');
assert.equal(cancelled.cancellation.cleanup, 'completed');
assert.equal(cancelled.runs.length, 0);
assert.equal((await call(`/v1/investigations/${incomplete.id}/report`)).verdict.outcome, 'blocked');
checks.push('intake replay/conflict, secret handling, questions, early report, stale round and finite cancellation');

const unsupported = await create({ test_target: 'npm test; rm -rf /' });
const blocked = await wait(unsupported.id, 'completed');
assert.equal(blocked.test_outcome, 'blocked');
assert.equal(blocked.runs.length, 0);
checks.push('unsupported/destructive target blocked without execution');
if (!controlOnly) {
  await call(`/v1/investigations/${unsupported.id}`, { method: 'DELETE', expected: 204 });
  await call(`/v1/investigations/${unsupported.id}`, { expected: 404 });
  checks.push('terminal deletion removes the investigation after runner purge');
}

if (process.argv.includes('--expect-fast-waits')) {
  const expiring = await create();
  const asking = await wait(expiring.id, 'awaiting_reporter');
  assert.ok(Date.parse(asking.wait_expires_at) - Date.now() <= 15000, 'Restart API with WAIT_SECONDS=5 for the expiry test');
  const expired = await wait(expiring.id, 'completed');
  assert.equal(expired.test_outcome, 'blocked');
  assert.equal(expired.rounds[0].status, 'expired');
  checks.push('reporter expiry finalizes a blocked report and closes the round');
}

if (!controlOnly) {
  for (const [target, outcome, repeats] of [
    ['tests/test_checkout.py::test_percentage_discount', 'reproduced', 1],
    ['tests/test_checkout.py::test_no_discount', 'not_reproduced', 3],
  ]) {
    const inv = await create({ test_target: target, repeat_count: repeats });
    const approval = await wait(inv.id, 'awaiting_approval');
    assert.equal(approval.runs.length, 0);
    await call(`/v1/investigations/${inv.id}/approve`, { body: { plan_hash: '0'.repeat(64), decision: 'approved' }, expected: 409 });
    const key = randomUUID(); const body = { plan_hash: approval.plan_hash, decision: 'approved' };
    const approved = await call(`/v1/investigations/${inv.id}/approve`, { body, key, expected: 202 });
    assert.deepEqual(await call(`/v1/investigations/${inv.id}/approve`, { body, key, expected: 202 }), approved);
    const done = await wait(inv.id, 'completed');
    assert.equal(done.test_outcome, outcome);
    assert.equal(done.runs.length, repeats);
    assert.ok(done.runs.every(run => run.evidence.cleanup === 'completed'));
    const report = await call(`/v1/investigations/${inv.id}/report`);
    assert.equal(report.verdict.input_run_ids.length, repeats);
    assert.ok((await call(`/v1/investigations/${inv.id}/report`, { accept: 'text/markdown' })).includes(inv.id));
    const artifact = done.runs[0].evidence.artifacts[0].id;
    await call(`/v1/investigations/${inv.id}/artifacts/${artifact}`, { auth: null, expected: 401 });
    await call(`/v1/investigations/${inv.id}/artifacts/${artifact}`, { accept: 'text/plain' });
    checks.push(`real ${outcome}: approval/hash/replay, ${repeats} run(s), cleanup, artifacts and both reports`);
  }
  const rejected = await create({ test_target: 'tests/test_checkout.py::test_percentage_discount' });
  const plan = await wait(rejected.id, 'awaiting_approval');
  await call(`/v1/investigations/${rejected.id}/approve`, { body: { plan_hash: plan.plan_hash, decision: 'rejected' }, expected: 202 });
  const done = await wait(rejected.id, 'completed');
  assert.equal(done.test_outcome, 'blocked');
  assert.equal(done.runs.length, 0);
  checks.push('rejection saves a blocked report without execution');
}
console.log(JSON.stringify({ status: 'passed', mode: controlOnly ? 'control-plane-only' : 'real-fixture-execution', checks, investigation_ids: createdIds }, null, 2));
