import assert from 'node:assert/strict';
import test from 'node:test';
import { readiness } from '../../packages/workflow/readiness.ts';

const fulfilled = (value: unknown): PromiseSettledResult<unknown> => ({ status: 'fulfilled', value });
const healthy = () => [fulfilled({ rows: [{ version: 1 }] }), fulfilled({ ready: true }), fulfilled({ ready: true })];
test('readiness requires positive replies and an applied migration record', () => {
  assert.equal(readiness(healthy()).ready, true);
  for (const value of [false, 'true', undefined]) {
    const checks = healthy(); checks[1] = fulfilled({ ready: value });
    assert.equal(readiness(checks).ready, false);
  }
  const missing = healthy(); missing[0] = fulfilled({ rows: [] });
  assert.equal(readiness(missing).dependencies.database, false);
});
test('dependency errors fail readiness without exposing their contents', () => {
  const checks = healthy(); checks[2] = { status: 'rejected', reason: new Error('private service error') };
  assert.deepEqual(readiness(checks), { ready: false, dependencies: { database: true, engine: true, runner: false } });
});
