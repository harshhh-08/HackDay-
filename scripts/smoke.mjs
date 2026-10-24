// REAL integration test for the recipient to run after setup. It uses the
// maintainer token to approve only the registered fixture. No services are started.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const base = process.env.BUGOUT_API_URL;
const token = process.env.BUGOUT_TOKEN;
if (!base || !token || new URL(base).hostname !== '127.0.0.1') throw new Error('Configure local .env first');
async function api(path, body, key = randomUUID(), expected = 200, accept = 'application/json') {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key, accept },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, expected, `${path} returned unexpected status`);
  return accept === 'text/markdown' ? response.text() : response.json();
}
async function wait(id, state) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const current = await api(`/v1/investigations/${id}`);
    if (current.job_status === state) return current;
    assert.notEqual(current.job_status, 'failed', 'Investigation failed; inspect its safe status response');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${state}`);
}
await api('/ready');
const intake = { title: 'Checkout total is wrong', description: 'Checkout sometimes gives the wrong total.' };
const key = randomUUID();
const created = await api('/v1/investigations', intake, key, 202);
assert.deepEqual(await api('/v1/investigations', intake, key, 202), created);
const id = created.investigation_id;
let status = await wait(id, 'awaiting_reporter');
assert.equal(status.runs.length, 0);
const round = status.rounds.find(r => r.status === 'open');
const reply = { round_id: round.id, answers: [{ question_id: 'test_target', answer: 'tests/test_checkout.py::test_percentage_discount' }] };
const replyKey = randomUUID();
const answered = await api(`/v1/investigations/${id}/replies`, reply, replyKey, 202);
assert.deepEqual(await api(`/v1/investigations/${id}/replies`, reply, replyKey, 202), answered);
status = await wait(id, 'awaiting_approval');
assert.equal(status.runs.length, 0);
await api(`/v1/investigations/${id}/approve`, { plan_hash: '0'.repeat(64), decision: 'approved' }, randomUUID(), 409);
await api(`/v1/investigations/${id}/approve`, { plan_hash: status.plan_hash, decision: 'approved' }, randomUUID(), 202);
status = await wait(id, 'completed');
assert.equal(status.test_outcome, 'reproduced');
assert.equal(status.runs.length, 1);
assert.equal(status.runs[0].evidence.cleanup, 'completed');
const report = await api(`/v1/investigations/${id}/report`);
assert.equal(report.verdict.counts.matching_fail, 1);
assert.equal(report.verdict.input_run_ids.length, 1);
assert.ok((await api(`/v1/investigations/${id}/report`, undefined, undefined, 200, 'text/markdown')).includes(id));
console.log(JSON.stringify({ integration: 'passed', investigation_id: id, run_ids: report.verdict.input_run_ids }));
