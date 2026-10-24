import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AppError, canTransition, hash, type Status } from '../contracts/domain.ts';
import type { IntakeData } from '../contracts/schemas.ts';
import type { Plan } from '../contracts/domain.ts';

export type Investigation = {
  id: string; actor: string; intake: IntakeData; redactions: unknown[];
  analysis: Record<string, unknown>; plan: Plan | null; plan_hash: string | null;
  status: Status; outcome: string | null; delivery_status: string; version: number;
  current_round: number; failure_count: number; incomplete_reason: string | null;
  cancel_requested_at: Date | null; cleanup_status: string; wait_expires_at: Date | null;
  deadline_at: Date; created_at: Date; updated_at: Date; completed_at: Date | null;
};
export const UNRESOLVED_RUN = "evidence IS NULL AND runner_status <> 'cancelled_before_start'";
export async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function locked(client: PoolClient, id: string): Promise<Investigation> {
  const result = await client.query('SELECT * FROM bugout.investigations WHERE id=$1 FOR UPDATE', [id]);
  if (!result.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Investigation not found.');
  return result.rows[0];
}
export async function transition(client: PoolClient, inv: Investigation, next: Status, reason: string, actor = 'system'): Promise<void> {
  if (!canTransition(inv.status, next)) throw new AppError(409, 'INVALID_TRANSITION', 'Operation is not valid in the current state.');
  await client.query('INSERT INTO bugout.state_transitions (investigation_id,previous_status,new_status,actor,reason) VALUES ($1,$2,$3,$4,$5)', [inv.id, inv.status, next, actor, reason]);
  const result = await client.query(`UPDATE bugout.investigations SET status=$2,version=version+1,updated_at=now(),
    completed_at=CASE WHEN $2 IN ('completed','cancelled','failed') THEN now() ELSE NULL END WHERE id=$1 RETURNING *`, [inv.id, next]);
  Object.assign(inv, result.rows[0]);
}
export async function wake(client: PoolClient, id: string): Promise<void> {
  await client.query('INSERT INTO bugout.outbox (id,investigation_id) VALUES ($1,$2)', [randomUUID(), id]);
}
export async function idempotent<T>(client: PoolClient, actor: string, operation: string, key: string, payload: unknown, fn: () => Promise<{ id: string; response: T }>): Promise<T> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${actor}/${operation}/${key}`]);
  const previous = await client.query('SELECT * FROM bugout.idempotency WHERE actor=$1 AND operation=$2 AND key=$3', [actor, operation, key]);
  const digest = hash(payload);
  if (previous.rows[0]) {
    if (previous.rows[0].request_hash !== digest) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This key was already used with a different payload.');
    return previous.rows[0].response as T;
  }
  const result = await fn();
  await client.query('INSERT INTO bugout.idempotency (actor,operation,key,request_hash,investigation_id,response) VALUES ($1,$2,$3,$4,$5,$6)', [actor, operation, key, digest, result.id, JSON.stringify(result.response)]);
  return result.response;
}
export async function related(pool: Pool | PoolClient, id: string) {
  const rounds = await pool.query('SELECT * FROM bugout.follow_up_rounds WHERE investigation_id=$1 ORDER BY round_number', [id]);
  const approvals = await pool.query('SELECT * FROM bugout.approvals WHERE investigation_id=$1 ORDER BY created_at', [id]);
  const runs = await pool.query('SELECT * FROM bugout.execution_runs WHERE investigation_id=$1 ORDER BY repeat_index', [id]);
  return { rounds: rounds.rows, approvals: approvals.rows, runs: runs.rows };
}

// Caller holds the investigation row lock. A cancellation arriving during
// report assembly still needs a consistent cleanup acknowledgement in the report.
export async function acknowledgeFinalizingCancellation(client: PoolClient, inv: Investigation): Promise<boolean> {
  if (inv.status !== 'finalizing' || !inv.cancel_requested_at || inv.cleanup_status !== 'requested') return false;
  const active = await client.query(`SELECT 1 FROM bugout.execution_runs WHERE investigation_id=$1 AND ${UNRESOLVED_RUN}`, [inv.id]);
  if (active.rowCount) return false;
  await client.query("UPDATE bugout.investigations SET cleanup_status='completed',updated_at=now() WHERE id=$1", [inv.id]);
  inv.cleanup_status = 'completed';
  return true;
}
