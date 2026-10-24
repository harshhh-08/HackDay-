// Trusted control-plane probe only. This worker never executes repository code.
import { Worker, createPostgresBackend, UnrecoverableError } from 'bullmq';
import { Pool } from 'pg';

const connection = JSON.parse(process.env.SPIKE_CONNECTION);
const pool = new Pool(connection);
const worker = new Worker('bugout-spike', async (job, _token, signal) => {
  const { id } = job.data;
  switch (job.name) {
    case 'analyze':
      await pool.query("UPDATE spike_investigations SET state = 'awaiting_reporter' WHERE id = $1 AND state = 'queued'", [id]);
      return;
    case 'resume':
      await pool.query("UPDATE spike_investigations SET state = 'completed', effects = effects + 1 WHERE id = $1 AND state = 'reply_received'", [id]);
      return;
    case 'expire':
      await pool.query("UPDATE spike_investigations SET state = 'incomplete' WHERE id = $1 AND state = 'awaiting_reporter'", [id]);
      return;
    case 'retry': {
      const { rows } = await pool.query('UPDATE spike_investigations SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [id]);
      if (rows[0].attempts === 1) throw new Error('Intentional transient probe failure');
      return;
    }
    case 'cancel':
    case 'timeout': {
      await pool.query('UPDATE spike_investigations SET attempts = attempts + 1 WHERE id = $1', [id]);
      // The resource being cleaned up is a timer, NOT a process/container.
      const stop = job.name === 'timeout' ? AbortSignal.timeout(150) : signal;
      await new Promise(resolve => {
        const timer = setInterval(() => {}, 100);
        const cleanup = () => { clearInterval(timer); resolve(); };
        stop.addEventListener('abort', cleanup, { once: true });
        if (stop.aborted) cleanup();
        process.send?.({ type: 'started', id });
      });
      await pool.query('UPDATE spike_investigations SET cleanup = true, state = $2 WHERE id = $1', [id, job.name]);
      throw new UnrecoverableError(`Intentional ${job.name}; timer cleanup acknowledged`);
    }
    case 'crash': {
      const { rows } = await pool.query('UPDATE spike_investigations SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts', [id]);
      if (rows[0].attempts === 1) {
        process.send?.({ type: 'started', id });
        await new Promise(() => {});
      }
      await pool.query('UPDATE spike_investigations SET effects = 1 WHERE id = $1 AND effects = 0', [id]);
      return;
    }
    default:
      throw new UnrecoverableError('Unknown probe operation');
  }
}, {
  connection,
  concurrency: 1,
  lockDuration: 1000,
  stalledInterval: 1000,
  maxStalledCount: 1,
}, createPostgresBackend);

worker.on('error', error => process.send?.({ type: 'error', message: error.message }));
process.on('message', message => {
  if (message.type === 'cancel') worker.cancelJob(message.id);
});
process.once('SIGTERM', async () => {
  worker.cancelAllJobs();
  await worker.close();
  await pool.end();
  process.disconnect();
});
await worker.waitUntilReady();
process.send?.({ type: 'ready' });
