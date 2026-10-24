// Real application SQL/transaction/outbox checks. Never connects to DATABASE_URL,
// starts repository workloads, or installs packages. Requires existing PG binaries.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeFinalizingCancellation, idempotent, locked, related, transaction, transition, UNRESOLVED_RUN, wake } from '../packages/workflow/store.ts';
import { dispatchPending } from '../services/orchestrator/dispatch.ts';

function installedDependencies() {
  for (const [location, path] of [['root', '../package.json'], ['existing-spike', '../spikes/orchestration/package.json']]) {
    const require = createRequire(new URL(path, import.meta.url));
    try {
      const pgVersion = require('pg/package.json').version;
      const bullVersion = require('bullmq/package.json').version;
      assert.equal(pgVersion, '8.23.1', 'Unexpected pg version');
      assert.equal(bullVersion, '6.4.2', 'Unexpected BullMQ version');
      return { ...require('pg'), ...require('bullmq'), location, pgVersion, bullVersion };
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Blocked: pg 8.23.1 and BullMQ 6.4.2 must already be installed. No installation was attempted.');
}
const dependencies = installedDependencies();
const { Pool, Queue, createPostgresBackend, runMigrations } = dependencies;
const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', timeout: 30000 });
for (const tool of ['initdb', 'pg_ctl', 'postgres']) command(tool, ['--version']);
const root = await mkdtemp(join(process.env.BUGOUT_TEST_TMPDIR ?? tmpdir(), 'bd-'));
const data = join(root, 'data');
let running = false;
let pool;
let queue;
const checks = [];
const began = new Date().toISOString();
const clock = performance.now();
// Private mode-0700 directory, Unix socket only: no TCP listener or existing DB.
const connection = { host: root, port: 5432, user: 'bugout_test', database: 'postgres', max: 8, connectionTimeoutMillis: 3000, statement_timeout: 10000 };
function start() {
  command('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o',
    `-h '' -k '${root}' -p 5432 -c shared_buffers=32MB -c max_connections=30`, '-w', 'start']);
  running = true;
}
async function fixture(client, id = randomUUID()) {
  await client.query(`INSERT INTO bugout.investigations (id,actor,intake,status,deadline_at)
    VALUES ($1,'integration-test',$2,'queued',now()+interval '1 hour')`, [id, JSON.stringify({ title: 'Synthetic DB fixture', description: 'Not a repository execution' })]);
  return id;
}
async function check(name, test) { await test(); checks.push(name); }

try {
  assert.match(root, /^[A-Za-z0-9_./-]+$/, 'Use a temporary directory without whitespace or shell metacharacters');
  assert.ok(join(root, '.s.PGSQL.5432').length < 104, 'Use a shorter temporary parent for the Unix socket');
  command('initdb', ['-D', data, '-U', 'bugout_test', '--auth=trust', '--no-locale', '-E', 'UTF8']);
  start();
  pool = new Pool(connection);
  const migration = await readFile(new URL('../db/migrations/001_initial.sql', import.meta.url), 'utf8');
  await check('application migration applies and is idempotent', async () => {
    await pool.query(migration);
    await pool.query(migration);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bugout.schema_migrations')).rows[0].count, 1);
  });
  const client = await pool.connect();
  try { await runMigrations(client); } finally { client.release(); }
  queue = new Queue('bugout-db-integration', { connection: { ...connection, max: 3 } }, createPostgresBackend);

  await check('business record and outbox roll back atomically', async () => {
    const id = randomUUID();
    await assert.rejects(transaction(pool, async client => { await fixture(client, id); await wake(client, id); throw new Error('Injected rollback'); }), /Injected rollback/);
    assert.equal((await pool.query('SELECT 1 FROM bugout.investigations WHERE id=$1', [id])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM bugout.outbox WHERE investigation_id=$1', [id])).rowCount, 0);
  });

  let duplicateId;
  await check('six concurrent duplicate requests produce one business record/outbox event', async () => {
    let effects = 0;
    const submit = () => transaction(pool, client => idempotent(client, 'integration-test', 'create', 'same-key', { title: 'same' }, async () => {
      effects++;
      const id = await fixture(client); await wake(client, id);
      return { id, response: { investigation_id: id } };
    }));
    const results = await Promise.all(Array.from({ length: 6 }, submit));
    assert.equal(effects, 1);
    for (const result of results) assert.deepEqual(result, results[0]);
    duplicateId = results[0].investigation_id;
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bugout.outbox WHERE investigation_id=$1', [duplicateId])).rows[0].count, 1);
    await assert.rejects(transaction(pool, client => idempotent(client, 'integration-test', 'create', 'same-key', { title: 'changed' }, async () => { throw new Error('Must not execute'); })), error => error.code === 'IDEMPOTENCY_CONFLICT');
  });

  await check('invalid transition rejected and successful transition audited once', async () => {
    await assert.rejects(transaction(pool, async client => transition(client, await locked(client, duplicateId), 'running', 'Invalid shortcut')), error => error.code === 'INVALID_TRANSITION');
    await transaction(pool, async client => transition(client, await locked(client, duplicateId), 'analyzing', 'Integration transition'));
    const row = (await pool.query('SELECT status,version FROM bugout.investigations WHERE id=$1', [duplicateId])).rows[0];
    assert.deepEqual(row, { status: 'analyzing', version: 1 });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM bugout.state_transitions WHERE investigation_id=$1', [duplicateId])).rows[0].count, 1);
  });

  await check('foreign keys, outcome enum and repeat ceiling enforced by PostgreSQL', async () => {
    await assert.rejects(pool.query('INSERT INTO bugout.execution_runs (id,investigation_id,repeat_index,plan_hash) VALUES ($1,$2,1,$3)', [randomUUID(), randomUUID(), 'a'.repeat(64)]), error => error.code === '23503');
    await assert.rejects(pool.query("UPDATE bugout.investigations SET outcome='invented' WHERE id=$1", [duplicateId]), error => error.code === '23514');
    await assert.rejects(pool.query('INSERT INTO bugout.execution_runs (id,investigation_id,repeat_index,plan_hash) VALUES ($1,$2,4,$3)', [randomUUID(), duplicateId, 'a'.repeat(64)]), error => error.code === '23514');
  });

  await check('concurrent run reservations cannot create two unfinished runs', async () => {
    const inv = await transaction(pool, client => fixture(client));
    const results = await Promise.allSettled([1, 2].map(index => pool.query('INSERT INTO bugout.execution_runs (id,investigation_id,repeat_index,plan_hash) VALUES ($1,$2,$3,$4)', [randomUUID(), inv, index, 'a'.repeat(64)])));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, '23505');
  });

  await check('finalizing cancellation acknowledges only resolved or never-started runs', async () => {
    const inv = await transaction(pool, client => fixture(client));
    await pool.query("UPDATE bugout.investigations SET status='finalizing',cancel_requested_at=now(),cleanup_status='requested' WHERE id=$1", [inv]);
    const run = randomUUID();
    await pool.query('INSERT INTO bugout.execution_runs (id,investigation_id,repeat_index,plan_hash) VALUES ($1,$2,1,$3)', [run, inv, 'a'.repeat(64)]);
    assert.equal(await transaction(pool, async client => acknowledgeFinalizingCancellation(client, await locked(client, inv))), false);
    await pool.query("UPDATE bugout.execution_runs SET runner_status='cancelled_before_start' WHERE id=$1", [run]);
    assert.equal((await pool.query(`SELECT 1 FROM bugout.execution_runs WHERE investigation_id=$1 AND ${UNRESOLVED_RUN}`, [inv])).rowCount, 0);
    assert.equal(await transaction(pool, async client => acknowledgeFinalizingCancellation(client, await locked(client, inv))), true);
    assert.equal((await pool.query('SELECT cleanup_status FROM bugout.investigations WHERE id=$1', [inv])).rows[0].cleanup_status, 'completed');
  });

  let reportId;
  await check('both report formats and terminal transition commit or roll back together', async () => {
    reportId = await transaction(pool, client => fixture(client));
    await transaction(pool, async client => {
      const inv = await locked(client, reportId);
      await transition(client, inv, 'analyzing', 'Test setup');
      await transition(client, inv, 'finalizing', 'Test setup');
    });
    async function finalize(fail) {
      return transaction(pool, async client => {
        const inv = await locked(client, reportId);
        await client.query('INSERT INTO bugout.reports (investigation_id,json_report,markdown,rule_version) VALUES ($1,$2,$3,$4)', [reportId, JSON.stringify({ kind: 'synthetic-database-test' }), '# Synthetic database test', 'test-rule']);
        await transition(client, inv, 'completed', 'Saved synthetic report');
        if (fail) throw new Error('Injected finalization failure');
      });
    }
    await assert.rejects(finalize(true), /Injected finalization failure/);
    assert.equal((await pool.query('SELECT 1 FROM bugout.reports WHERE investigation_id=$1', [reportId])).rowCount, 0);
    assert.equal((await pool.query('SELECT status FROM bugout.investigations WHERE id=$1', [reportId])).rows[0].status, 'finalizing');
    await finalize(false);
    const saved = (await pool.query('SELECT * FROM bugout.reports WHERE investigation_id=$1', [reportId])).rows[0];
    assert.equal(saved.json_report.kind, 'synthetic-database-test');
    assert.equal(saved.markdown, '# Synthetic database test');
  });

  let eventId;
  await check('actual BullMQ enqueue survives lost acknowledgement without duplicate job', async () => {
    // All these rows are synthetic test fixtures in this freshly owned cluster.
    await pool.query('DELETE FROM bugout.outbox');
    await transaction(pool, client => wake(client, duplicateId));
    eventId = (await pool.query('SELECT id FROM bugout.outbox')).rows[0].id;
    await assert.rejects(dispatchPending(pool, { add: async (...args) => {
      await queue.add(...args);
      throw new Error('Injected lost enqueue acknowledgement');
    } }), /Injected lost enqueue acknowledgement/);
    assert.equal((await pool.query('SELECT dispatched_at FROM bugout.outbox WHERE id=$1', [eventId])).rows[0].dispatched_at, null);
    assert.ok(await queue.getJob(eventId));
    await dispatchPending(pool, queue);
    assert.equal(await queue.getWaitingCount(), 1);
    assert.ok((await pool.query('SELECT dispatched_at FROM bugout.outbox WHERE id=$1', [eventId])).rows[0].dispatched_at);
  });

  await check('application reports and queue metadata survive immediate DB shutdown/recovery', async () => {
    await queue.close(); queue = undefined;
    await pool.end(); pool = undefined;
    command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); running = false;
    start(); pool = new Pool(connection);
    queue = new Queue('bugout-db-integration', { connection: { ...connection, max: 3 } }, createPostgresBackend);
    assert.equal((await pool.query('SELECT status FROM bugout.investigations WHERE id=$1', [reportId])).rows[0].status, 'completed');
    assert.equal((await pool.query('SELECT 1 FROM bugout.reports WHERE investigation_id=$1', [reportId])).rowCount, 1);
    assert.equal(await (await queue.getJob(eventId)).getState(), 'waiting');
  });

  await check('terminal deletion cascades application evidence metadata', async () => {
    await pool.query('DELETE FROM bugout.investigations WHERE id=$1', [reportId]);
    assert.equal((await pool.query('SELECT 1 FROM bugout.reports WHERE investigation_id=$1', [reportId])).rowCount, 0);
    const details = await related(pool, reportId);
    assert.deepEqual(details, { rounds: [], approvals: [], runs: [] });
    assert.equal((await pool.query('SELECT 1 FROM bugout.state_transitions WHERE investigation_id=$1', [reportId])).rowCount, 0);
  });
} finally {
  await queue?.close();
  await pool?.end();
  if (running) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  await rm(root, { recursive: true, force: true });
}
assert.equal(await stat(root).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false);
console.log(JSON.stringify({
  started_at: began, duration_ms: Math.round(performance.now() - clock), status: 'passed',
  scope: 'real application PostgreSQL/transaction/outbox integration; no Express/Zod or repository execution',
  versions: { node: process.version, postgres: command('postgres', ['--version']).trim(), pg: dependencies.pgVersion, bullmq: dependencies.bullVersion },
  dependencies_from: dependencies.location, checks, cleanup: 'temporary cluster stopped and removed',
}, null, 2));
