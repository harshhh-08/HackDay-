import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import constants from './constants.json' with { type: 'json' };

export { constants };
export type Status = 'queued' | 'analyzing' | 'awaiting_reporter' | 'awaiting_approval' | 'running' | 'finalizing' | 'completed' | 'cancelled' | 'failed';
export const terminal = new Set<Status>(['completed', 'cancelled', 'failed']);
const edges: Record<Status, readonly Status[]> = {
  queued: ['analyzing', 'finalizing', 'failed'],
  analyzing: ['awaiting_reporter', 'awaiting_approval', 'finalizing', 'failed'],
  awaiting_reporter: ['analyzing', 'finalizing', 'failed'],
  awaiting_approval: ['running', 'finalizing', 'failed'],
  running: ['finalizing', 'failed'],
  finalizing: ['completed', 'cancelled', 'failed'],
  completed: [], cancelled: [], failed: [],
};
export function canTransition(from: Status, to: Status): boolean {
  return edges[from]?.includes(to) ?? false;
}
// Bounded acknowledgement wait, not an assertion that termination happened.
// The workload has 30 s plus its independent runtime grace; allow 10 s extra
// from cancellation/total expiry before recording cleanup as unconfirmed.
export function cleanupWaitExpired(requestedAt: Date | null, deadlineAt: Date, now = Date.now()): boolean {
  return now >= (requestedAt ?? deadlineAt).getTime() + (constants.limits.seconds + 10) * 1000;
}
export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  throw new AppError(400, 'INVALID_CANONICAL_VALUE', 'Only JSON values and safe integers are supported.');
}
export const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function approvalSignature(key: string, investigationId: string, runId: string, planHash: string): string {
  return createHmac('sha256', key).update(`${investigationId}\n${runId}\n${planHash}`).digest('hex');
}
export function cleanDisplay(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
export type Snapshot = { repository_id: 'checkout'; commit_sha: string | null; snapshot_sha256: string; image: string };
export type Plan = {
  schema_version: 1; repository: Snapshot; adapter: 'pytest'; target: string;
  argv: string[]; script: null; hypothesis: string; expected_signal: string;
  limits: typeof constants.limits; repeats: number; network: 'none';
};
export function buildPlan(snapshot: Snapshot, target: string, repeats: number): Plan {
  if (!constants.targets.includes(target)) throw new AppError(422, 'UNSUPPORTED_TARGET', 'Only documented fixture targets are allowed.');
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > constants.limits.repeats) throw new AppError(422, 'REPEAT_LIMIT', 'Repeat limit exceeded.');
  return {
    schema_version: 1, repository: snapshot, adapter: 'pytest', target,
    argv: ['python', '-m', 'pytest', '-q', target, '-p', 'no:cacheprovider', '-o', 'junit_family=xunit1', '--junitxml=/tmp/bugout-results.xml'],
    script: null, hypothesis: 'The selected checkout test may demonstrate the reported total mismatch.',
    expected_signal: constants.failure_marker, limits: { ...constants.limits }, repeats, network: 'none',
  };
}
