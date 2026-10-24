// Disposable local experiment. No API, model, fixture, or restricted runner.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Queue, createPostgresBackend, runMigrations } from 'bullmq';
import { Pool } from 'pg';

assert(process.env.SPIKE_TMPDIR, 'Set SPIKE_TMPDIR to an existing disposable-work parent directory');
const startedAt = new Date().toISOString();
const started = performance.now();
const root = await mkdtemp(join(process.env.SPIKE_TMPDIR, 'bugout-spike-'));
const data = join(root, 'data');
const port = 55439;
const connection = { host: '127.0.0.1', port, user: 'bugout_spike', database: 'bugout_spike', max: 3 };
let clusterRunning = false;
let worker;
let pool;
let queue;
const checks = [];
const workerErrors = [];
const messages = [];
const samples = [];
const command = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 30_000 });

async function until(predicate, label, timeout = 15_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}
function startDatabase() {
  command('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o',
    `-h 127.0.0.1 -p ${port} -c unix_socket_directories='' -c shared_buffers=32MB -c max_connections=30`, '-w', 'start']);
  clusterRunning = true;
}
async function startWorker() {
  messages.length = 0;
  worker = fork(new URL('./worker.mjs', import.meta.url), [], {
    env: { ...process.env, SPIKE_CONNECTION: JSON.stringify(connection) },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  worker.on('message', message => {
    messages.push(message);
    if (message.type === 'error') workerErrors.push(message.message);
  });
  await until(() => messages.some(m => m.type === 'ready'), 'worker ready');
}
async function stopWorker(signal = 'SIGTERM') {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  const exited = once(worker, 'exit');
  const force = setTimeout(() => worker.kill('SIGKILL'), 5000);
  worker.kill(signal);
  try { await exited; } finally { clearTimeout(force); }
}
async function row(id) {
  return (await pool.query('SELECT * FROM spike_investigations WHERE id = $1', [id])).rows[0];
}
async function seed(id) {
  await pool.query("INSERT INTO spike_investigations (id, state) VALUES ($1, 'queued')", [id]);
}
async function finished(job, expected = 'completed') {
  await until(async () => await job.getState() === expected, `${job.id} ${expected}`);
}
async function sample(label) {
  const postmaster = Number((await readFile(join(data, 'postmaster.pid'), 'utf8')).split('\n')[0]);
  const children = command('pgrep', ['-P', String(postmaster)]).trim().split(/\s+/);
  const pids = [process.pid, worker.pid, postmaster, ...children];
  samples.push({ label, ps: command('ps', ['-o', 'pid=,ppid=,rss=,%cpu=', '-p', pids.join(',')]).trim() });
}

try {
  command('initdb', ['-D', data, '-U', 'bugout_spike', '--auth-local=trust', '--auth-host=trust', '--no-locale', '-E', 'UTF8']);
  startDatabase();
  command('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'bugout_spike', 'bugout_spike']);
  pool = new Pool(connection);
  const client = await pool.connect();
  try { await runMigrations(client); } finally { client.release(); }
  await pool.query(`CREATE TABLE spike_investigations (
    id text PRIMARY KEY, state text NOT NULL, attempts integer NOT NULL DEFAULT 0,
    effects integer NOT NULL DEFAULT 0, cleanup boolean NOT NULL DEFAULT false
  )`);
  queue = new Queue('bugout-spike', { connection }, createPostgresBackend);
  await queue.setGlobalConcurrency(1);
  await startWorker();
  await sample('idle');

  await seed('reply');
  await finished(await queue.add('analyze', { id: 'reply' }, { jobId: 'analyze-reply' }));
  assert.equal((await row('reply')).state, 'awaiting_reporter');
  assert.equal(await queue.getActiveCount(), 0);
  await stopWorker();
  assert.equal((await row('reply')).state, 'awaiting_reporter');
  await pool.query("UPDATE spike_investigations SET state = 'reply_received' WHERE id = 'reply'");
  const reply = await queue.add('resume', { id: 'reply' }, { jobId: 'resume-reply' });
  await queue.add('resume', { id: 'reply' }, { jobId: 'resume-reply' });
  await startWorker();
  await finished(reply);
  assert.equal((await row('reply')).effects, 1);
  // A distinct duplicate event also has no second business effect.
  await finished(await queue.add('resume', { id: 'reply' }, { jobId: 'duplicate-reply' }));
  assert.equal((await row('reply')).effects, 1);
  checks.push('task, application persistence, released wait, restart/resume, duplicate effect guard');

  await seed('expiry');
  await finished(await queue.add('analyze', { id: 'expiry' }));
  await stopWorker();
  const expiry = await queue.add('expire', { id: 'expiry' }, { delay: 200 });
  await sleep(300);
  await startWorker();
  await finished(expiry);
  assert.equal((await row('expiry')).state, 'incomplete');
  await finished(await queue.add('expire', { id: 'reply' }));
  assert.equal((await row('reply')).state, 'completed');
  checks.push('expired wait survives worker downtime; stale expiry cannot overwrite completion');

  await seed('retry');
  await finished(await queue.add('retry', { id: 'retry' }, { attempts: 2, backoff: { type: 'fixed', delay: 100 } }));
  assert.equal((await row('retry')).attempts, 2);
  checks.push('bounded transient retry: exactly two attempts');

  await seed('timeout');
  await finished(await queue.add('timeout', { id: 'timeout' }, { attempts: 2 }), 'failed');
  assert.equal((await row('timeout')).cleanup, true);
  assert.equal((await row('timeout')).attempts, 1);
  checks.push('150ms cooperative timeout with timer cleanup; permanent failure is not retried');

  await seed('cancel');
  const cancel = await queue.add('cancel', { id: 'cancel' }, { jobId: 'cancel', attempts: 2 });
  await until(() => messages.some(m => m.type === 'started' && m.id === 'cancel'), 'cancellable timer active');
  await sample('active-cancellation-probe');
  worker.send({ type: 'cancel', id: cancel.id });
  await finished(cancel, 'failed');
  assert.equal((await row('cancel')).cleanup, true);
  assert.equal((await row('cancel')).attempts, 1);
  checks.push('IPC request to owning worker cancels timer; cleanup recorded (no container tested)');

  await seed('crash');
  const crash = await queue.add('crash', { id: 'crash' }, { jobId: 'crash' });
  await until(() => messages.some(m => m.type === 'started' && m.id === 'crash'), 'crash task active');
  await stopWorker('SIGKILL');
  await startWorker();
  await finished(crash);
  assert.equal((await row('crash')).attempts, 2);
  assert.equal((await row('crash')).effects, 1);
  checks.push('SIGKILL/stalled-task recovery: two attempts, one guarded application effect');

  await stopWorker();
  await queue.close();
  queue = undefined;
  await pool.end();
  pool = undefined;
  command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  clusterRunning = false;
  startDatabase();
  pool = new Pool(connection);
  queue = new Queue('bugout-spike', { connection }, createPostgresBackend);
  assert.equal((await row('reply')).effects, 1);
  assert.equal((await row('crash')).effects, 1);
  assert.equal(await (await queue.getJob('crash')).getState(), 'completed');
  assert.deepEqual(workerErrors, []);
  checks.push('clean PostgreSQL restart preserves application and completed queue records');
  console.log(JSON.stringify({
    started_at: startedAt, duration_ms: Math.round(performance.now() - started),
    node: process.version, postgres: command('postgres', ['--version']).trim(),
    bullmq: '6.4.2', pg: '8.23.1', checks, samples,
    measurement_note: 'ps RSS is KiB, CPU is a point sample; PostgreSQL RSS includes shared pages. Not peak load or VM footprint.',
    limitations: ['No real runner/container', 'No transactional outbox', 'No API/approval integration', 'No forced database crash or host reboot'],
  }, null, 2));
} catch (error) {
  console.error(error);
  if (clusterRunning) console.error(await readFile(join(root, 'postgres.log'), 'utf8'));
  process.exitCode = 1;
} finally {
  await stopWorker();
  await queue?.close();
  await pool?.end();
  if (clusterRunning) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  await rm(root, { recursive: true, force: true });
}
