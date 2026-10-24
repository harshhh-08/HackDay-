import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { Approval, Cancellation, Id, Intake, Reply } from '../../packages/contracts/schemas.ts';
import { AppError, equalSecret, hash, terminal } from '../../packages/contracts/domain.ts';
import { config } from '../../packages/workflow/config.ts';
import { database } from '../../packages/workflow/database.ts';
import { idempotent, locked, related, transaction, transition, wake } from '../../packages/workflow/store.ts';
import { readiness } from '../../packages/workflow/readiness.ts';
import { redact } from '../../packages/workflow/redact.ts';
import { service } from '../../packages/workflow/http.ts';

const settings = config(); const pool = database(settings.database);
const app = express(); app.disable('x-powered-by');
app.use((_req, res, next) => { res.locals.correlationId = randomUUID(); res.setHeader('X-Correlation-Id', res.locals.correlationId); res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'api' }));
app.get('/ready', async (_req, res) => {
  const checks = await Promise.allSettled([
    pool.query('SELECT version FROM bugout.schema_migrations WHERE version=1'),
    service(settings.engineUrl, settings.engineToken, '/ready'),
    service(settings.runnerUrl, settings.runnerToken, '/ready'),
  ]);
  const result = readiness(checks);
  res.status(result.ready ? 200 : 503).json(result);
});
app.use((req, _res, next) => {
  if (!equalSecret(req.get('authorization') ?? '', `Bearer ${settings.token}`)) return next(new AppError(401, 'UNAUTHORIZED', 'A valid maintainer token is required.'));
  next();
});
app.use(express.json({ limit: 65536, strict: true }));
const actor = 'local-maintainer';
function key(req: Request): string {
  const value = req.get('idempotency-key') ?? '';
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(value)) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Supply an Idempotency-Key of 8–128 letters, digits, dots, underscores or hyphens.');
  return value;
}

app.post('/v1/investigations', async (req, res) => {
  const sanitized = redact(Intake.parse(req.body));
  // Redaction markers can be longer than their input. Recheck persisted limits.
  const intake = Intake.parse(sanitized.value); const redactions = sanitized.redactions;
  const idempotencyKey = key(req);
  const result = await transaction(pool, client => idempotent(client, actor, 'create', idempotencyKey, intake, async () => {
    const id = randomUUID();
    await client.query(`INSERT INTO bugout.investigations (id,actor,intake,redactions,status,deadline_at)
      VALUES ($1,$2,$3,$4,'queued',$5)`, [id, actor, JSON.stringify(intake), JSON.stringify(redactions), new Date(Date.now() + settings.totalSeconds * 1000)]);
    await client.query("INSERT INTO bugout.state_transitions (investigation_id,new_status,actor,reason) VALUES ($1,'queued',$2,'Validated and sanitized intake')", [id, actor]);
    await wake(client, id);
    return { id, response: { investigation_id: id, job_status: 'queued', status_url: `/v1/investigations/${id}` } };
  }));
  res.status(202).json(result);
});
app.get('/v1/investigations/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const result = await pool.query('SELECT * FROM bugout.investigations WHERE id=$1 AND actor=$2', [id, actor]);
  const inv = result.rows[0]; if (!inv) throw new AppError(404, 'NOT_FOUND', 'Investigation not found.');
  const details = await related(pool, id);
  const transitions = await pool.query('SELECT previous_status,new_status,actor,reason,created_at FROM bugout.state_transitions WHERE investigation_id=$1 ORDER BY id', [id]);
  res.json({ investigation_id: id, job_status: inv.status, test_outcome: inv.outcome, delivery_status: inv.delivery_status,
    intake: inv.intake, redactions: inv.redactions, analysis: inv.analysis, plan: inv.plan, plan_hash: inv.plan_hash,
    cancellation: { requested_at: inv.cancel_requested_at, cleanup: inv.cleanup_status },
    incomplete_reason: inv.incomplete_reason, deadline_at: inv.deadline_at, wait_expires_at: inv.wait_expires_at,
    created_at: inv.created_at, updated_at: inv.updated_at, ...details, transitions: transitions.rows });
});
app.post('/v1/investigations/:id/replies', async (req, res) => {
  const id = Id.parse(req.params.id); const payload = redact(Reply.parse(req.body)).value; const requestKey = key(req);
  const response = await transaction(pool, client => idempotent(client, actor, `reply/${id}`, requestKey, payload, async () => {
    const inv = await locked(client, id);
    if (inv.status !== 'awaiting_reporter' || inv.cancel_requested_at) throw new AppError(409, 'NOT_AWAITING_REPLY', 'No active reporter round.');
    const result = await client.query("SELECT * FROM bugout.follow_up_rounds WHERE id=$1 AND investigation_id=$2 AND status='open' FOR UPDATE", [payload.round_id, id]);
    const round = result.rows[0];
    if (!round || round.expires_at <= new Date() || inv.deadline_at <= new Date()) throw new AppError(409, 'ROUND_EXPIRED', 'The current round has expired.');
    const ids = new Set(round.questions.map((q: { id: string }) => q.id));
    if (new Set(payload.answers.map(a => a.question_id)).size !== payload.answers.length || payload.answers.length !== ids.size || payload.answers.some(a => !ids.has(a.question_id))) throw new AppError(400, 'INVALID_ANSWERS', 'Answer every current question exactly once.');
    await client.query("UPDATE bugout.follow_up_rounds SET answers=$2,status='answered',answered_at=now() WHERE id=$1", [round.id, JSON.stringify(payload.answers)]);
    await client.query('UPDATE bugout.investigations SET wait_expires_at=NULL,failure_count=0 WHERE id=$1', [id]);
    await transition(client, inv, 'analyzing', 'Reporter answered current round', actor); await wake(client, id);
    return { id, response: { investigation_id: id, job_status: inv.status } };
  }));
  res.status(202).json(response);
});
app.post('/v1/investigations/:id/approve', async (req, res) => {
  const id = Id.parse(req.params.id); const payload = Approval.parse(req.body); const requestKey = key(req);
  const response = await transaction(pool, client => idempotent(client, actor, `approve/${id}`, requestKey, payload, async () => {
    const inv = await locked(client, id);
    if (!inv.plan || inv.plan_hash !== payload.plan_hash || hash(inv.plan) !== payload.plan_hash) throw new AppError(409, 'PLAN_CHANGED', 'Approval must match the exact current plan.');
    const previous = await client.query('SELECT decision FROM bugout.approvals WHERE investigation_id=$1 AND plan_hash=$2', [id, payload.plan_hash]);
    if (previous.rows[0]) {
      if (previous.rows[0].decision !== payload.decision) throw new AppError(409, 'DECISION_CONFLICT', 'The plan already has a different decision.');
      return { id, response: { investigation_id: id, decision: payload.decision } };
    }
    if (inv.status !== 'awaiting_approval' || inv.cancel_requested_at || !inv.wait_expires_at || inv.wait_expires_at <= new Date() || inv.deadline_at <= new Date()) throw new AppError(409, 'NOT_AWAITING_APPROVAL', 'Approval is unavailable or expired.');
    await client.query('INSERT INTO bugout.approvals (id,investigation_id,plan_hash,decision,actor) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), id, payload.plan_hash, payload.decision, actor]);
    if (payload.decision === 'rejected') {
      await client.query("UPDATE bugout.investigations SET incomplete_reason='Maintainer rejected the plan' WHERE id=$1", [id]);
      await transition(client, inv, 'finalizing', 'Approval rejected', actor);
    }
    await wake(client, id);
    return { id, response: { investigation_id: id, decision: payload.decision } };
  }));
  res.status(202).json(response);
});
app.post('/v1/investigations/:id/cancel', async (req, res) => {
  const id = Id.parse(req.params.id); const payload = redact(Cancellation.parse(req.body ?? {})).value; const requestKey = key(req);
  const response = await transaction(pool, client => idempotent(client, actor, `cancel/${id}`, requestKey, payload, async () => {
    const inv = await locked(client, id);
    if (terminal.has(inv.status)) throw new AppError(409, 'NOT_CANCELLABLE', 'Investigation is already terminal.');
    if (!inv.cancel_requested_at) {
      await client.query("UPDATE bugout.investigations SET cancel_requested_at=now(),cleanup_status='requested',incomplete_reason=$2,updated_at=now() WHERE id=$1", [id, payload.reason]);
      await wake(client, id);
    }
    return { id, response: { investigation_id: id, cancellation: 'requested' } };
  }));
  res.status(202).json(response);
});
app.get('/v1/investigations/:id/report', async (req, res) => {
  const id = Id.parse(req.params.id);
  const result = await pool.query('SELECT r.* FROM bugout.reports r JOIN bugout.investigations i ON i.id=r.investigation_id WHERE i.id=$1 AND i.actor=$2', [id, actor]);
  if (!result.rows[0]) throw new AppError(409, 'REPORT_NOT_READY', 'No saved report is available.');
  const report = result.rows[0];
  if (req.get('accept')?.includes('text/markdown')) res.type('text/markdown').send(report.markdown);
  else res.json(report.json_report);
});
app.get('/v1/investigations/:id/artifacts/:artifact', async (req, res) => {
  const id = Id.parse(req.params.id); const artifactId = Id.parse(req.params.artifact);
  const result = await pool.query('SELECT r.evidence FROM bugout.execution_runs r JOIN bugout.investigations i ON i.id=r.investigation_id WHERE i.id=$1 AND i.actor=$2', [id, actor]);
  if (!result.rows.some(row => row.evidence?.artifacts.some((a: { id: string }) => a.id === artifactId))) throw new AppError(404, 'NOT_FOUND', 'Artifact not found.');
  const artifact = await service(settings.runnerUrl, settings.runnerToken, `/artifacts/${artifactId}`) as { content: string };
  res.type('text/plain').send(artifact.content);
});
app.delete('/v1/investigations/:id', async (req, res) => {
  const id = Id.parse(req.params.id);
  const row = await pool.query('SELECT status FROM bugout.investigations WHERE id=$1 AND actor=$2', [id, actor]);
  if (!row.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Investigation not found.');
  if (!terminal.has(row.rows[0].status)) throw new AppError(409, 'NOT_TERMINAL', 'Cancel and finish cleanup before deleting.');
  await service(settings.runnerUrl, settings.runnerToken, '/purge', { investigation_id: id });
  await pool.query('DELETE FROM bugout.investigations WHERE id=$1 AND actor=$2', [id, actor]);
  res.status(204).end();
});
app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found.')));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const bodyError = error as { type?: string };
  let status = 500; let code = 'INTERNAL_ERROR'; let message = 'The operation could not be completed.';
  if (error instanceof AppError) ({ status, code, message } = error);
  else if (error instanceof ZodError || error instanceof SyntaxError) { status = 400; code = 'VALIDATION_ERROR'; message = 'Request does not match the documented schema.'; }
  else if (bodyError?.type === 'entity.too.large') { status = 413; code = 'BODY_TOO_LARGE'; message = 'Request body exceeds 64 KiB.'; }
  console.error(JSON.stringify({ event: 'request_error', code, correlation_id: res.locals.correlationId }));
  res.status(status).json({ error: { code, message, correlation_id: res.locals.correlationId } });
});
const server = app.listen(settings.port, settings.host, () => console.log(`bug.out API: http://${settings.host}:${settings.port}`));
process.once('SIGTERM', () => server.close(() => { void pool.end(); }));
