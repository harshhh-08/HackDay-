import { Queue, Worker, createPostgresBackend } from 'bullmq';
import { config } from '../../packages/workflow/config.ts';
import { database } from '../../packages/workflow/database.ts';
import { transaction, wake } from '../../packages/workflow/store.ts';
import { service } from '../../packages/workflow/http.ts';
import { investigate } from './workflow.ts';
import { dispatchPending } from './dispatch.ts';

const settings = config(); const pool = database(settings.database);
const options = { connection: { connectionString: settings.database, max: 3 } };
const queue = new Queue('bugout-phases', options, createPostgresBackend);
await queue.setGlobalConcurrency(1);
const worker = new Worker('bugout-phases', async job => {
  await investigate(pool, settings, job.data.investigation_id);
}, { ...options, concurrency: 1 }, createPostgresBackend);
worker.on('error', () => console.error(JSON.stringify({ event: 'queue_error' })));
worker.on('failed', job => console.error(JSON.stringify({ event: 'phase_failed', job_id: job?.id })));

let stopping = false;
async function reconcile() {
  await transaction(pool, async client => {
    // A lock/version check inside the service makes duplicate wakeups harmless.
    const rows = await client.query(`SELECT id FROM bugout.investigations i WHERE
      status NOT IN ('completed','cancelled','failed') AND (
        status IN ('queued','analyzing','running','finalizing') OR cancel_requested_at IS NOT NULL
        OR wait_expires_at <= now() OR deadline_at <= now()
        OR EXISTS (SELECT 1 FROM bugout.approvals a WHERE a.investigation_id=i.id AND a.decision='approved'))
      AND NOT EXISTS (SELECT 1 FROM bugout.outbox o WHERE o.investigation_id=i.id AND o.dispatched_at IS NULL)
      ORDER BY updated_at LIMIT 50 FOR UPDATE SKIP LOCKED`);
    for (const row of rows.rows) await wake(client, row.id);
    await client.query("DELETE FROM bugout.outbox WHERE dispatched_at < now() - interval '1 day'");
  });
}
async function retain() {
  const rows = await pool.query("SELECT id FROM bugout.investigations WHERE completed_at < now() - ($1 * interval '1 day') AND cleanup_status NOT IN ('failed','unconfirmed') LIMIT 20", [settings.retentionDays]);
  for (const row of rows.rows) {
    await service(settings.runnerUrl, settings.runnerToken, '/purge', { investigation_id: row.id });
    await pool.query('DELETE FROM bugout.investigations WHERE id=$1', [row.id]);
  }
}
console.log('bug.out phase worker started (BullMQ/PostgreSQL, concurrency 1).');
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });
let iteration = 0;
while (!stopping) {
  try { await reconcile(); await dispatchPending(pool, queue); if (++iteration % 300 === 0) await retain(); }
  catch { console.error(JSON.stringify({ event: 'reconciliation_retry' })); }
  await new Promise(resolve => setTimeout(resolve, 2000));
}
await worker.close(); await queue.close(); await pool.end();
