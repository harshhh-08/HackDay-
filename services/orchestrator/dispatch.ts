import type { Pool } from 'pg';
import { transaction } from '../../packages/workflow/store.ts';

type PhaseQueue = {
  add(name: string, data: { investigation_id: string }, options: {
    jobId: string; attempts: number; backoff: { type: string; delay: number };
    removeOnComplete: { count: number }; removeOnFail: { count: number };
  }): Promise<unknown>;
};

// A successful enqueue followed by a lost DB acknowledgement is retried with
// the SAME durable outbox UUID. Business effects must still tolerate redelivery.
export async function dispatchPending(pool: Pool, queue: PhaseQueue): Promise<void> {
  await transaction(pool, async client => {
    const rows = await client.query('SELECT * FROM bugout.outbox WHERE dispatched_at IS NULL ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED');
    for (const row of rows.rows) {
      await queue.add('investigate', { investigation_id: row.investigation_id }, {
        jobId: row.id, attempts: 3, backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 1000 }, removeOnFail: { count: 1000 },
      });
      await client.query('UPDATE bugout.outbox SET dispatched_at=now() WHERE id=$1', [row.id]);
    }
  });
}
