import { z } from 'zod';
import { constants } from './domain.ts';

const bounded = (bytes: number) => z.string().refine(s => Buffer.byteLength(s, 'utf8') <= bytes, 'UTF-8 byte limit exceeded');
export const Id = z.uuid();
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const Intake = z.strictObject({
  title: z.string().trim().min(1).max(200), description: bounded(16384).refine(s => s.trim().length > 0),
  expected_behavior: bounded(4096).optional(), actual_behavior: bounded(4096).optional(),
  logs: bounded(32768).optional(), repository_id: z.literal('checkout').default('checkout'),
  repository_revision: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  environment: bounded(2048).optional(), test_target: bounded(512).optional(),
  repeat_count: z.number().int().min(1).max(3).default(1),
});
export const Reply = z.strictObject({
  round_id: Id,
  answers: z.array(z.strictObject({ question_id: z.string().max(64), answer: bounded(2048).refine(s => s.trim().length > 0) })).min(1).max(3),
});
export const Approval = z.strictObject({ plan_hash: Hash, decision: z.enum(['approved', 'rejected']) });
export const Cancellation = z.strictObject({ reason: bounded(512).default('Requested by maintainer') });
export const Question = z.strictObject({ id: z.string().max(64), field: z.string().max(64), question: bounded(1024), why: bounded(512) });
export const Source = z.strictObject({ field: z.string().max(128), line: z.number().int().positive().optional() });
export const Fact = z.strictObject({ field: z.string().max(128), value: bounded(32768), provenance: z.enum(['reported', 'extracted']), source: Source });
export const Analysis = z.strictObject({
  facts: z.array(Fact).max(100), questions: z.array(Question).max(3),
  missing_fields: z.array(z.string().max(64)).max(20),
  test_target: z.string().nullable(), block_reason: z.string().max(1024).nullable(),
  provider: z.literal('disabled'), hypotheses: z.array(z.unknown()).length(0),
});
export const Snapshot = z.strictObject({ repository_id: z.literal('checkout'), commit_sha: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), snapshot_sha256: Hash, image: z.string().regex(/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/) });
export const Artifact = z.strictObject({ id: Id, bytes: z.number().int().min(0).max(65536), sha256: Hash, truncated: z.boolean(), stream: z.enum(['stdout', 'stderr']) });
export const Evidence = z.strictObject({
  schema_version: z.literal(1), run_id: Id, investigation_id: Id, plan_hash: Hash,
  repository: Snapshot, argv: z.array(z.string().max(512)).max(20),
  classification: z.enum(constants.classifications as [string, ...string[]]),
  matched_signal: z.boolean(), selected_test_ran: z.boolean(),
  exit_code: z.number().int().nullable(), started_at: z.iso.datetime().nullable(), ended_at: z.iso.datetime(),
  duration_ms: z.number().int().min(0), cleanup: z.enum(['completed', 'failed']),
  environment: z.record(z.string(), z.string().max(1024)),
  artifacts: z.array(Artifact).max(2), reason: z.string().max(2048),
});
export const RunResult = z.strictObject({
  run_id: Id, state: z.enum(['reserved', 'creating', 'running', 'finishing', 'finished']),
  evidence: Evidence.nullable(),
});
export const ReportResult = z.strictObject({
  outcome: z.enum(constants.outcomes as [string, ...string[]]),
  json: z.record(z.string(), z.unknown()), markdown: bounded(524288),
});
export type IntakeData = z.infer<typeof Intake>;
