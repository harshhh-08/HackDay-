export function config() {
  function secret(name: string): string {
    const value = process.env[name] ?? '';
    if (value.length < 32 || value.includes('GENERATE_ME')) throw new Error(`${name} must be a generated secret of at least 32 characters`);
    return value;
  }
  function localUrl(name: string): string {
    const value = process.env[name] ?? '';
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error(`${name} must use loopback HTTP`);
    return value.replace(/\/$/, '');
  }
  function integer(name: string, fallback: number, minimum: number, maximum: number): number {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
    return value;
  }
  if (process.env.MODEL_PROVIDER !== 'disabled') throw new Error('Only MODEL_PROVIDER=disabled is implemented');
  if (process.env.API_HOST !== '127.0.0.1') throw new Error('Only loopback API binding is supported');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return {
    host: '127.0.0.1', port: integer('API_PORT', 8787, 1024, 65535), database: process.env.DATABASE_URL,
    token: secret('BUGOUT_TOKEN'), engineUrl: localUrl('ENGINE_URL'), engineToken: secret('ENGINE_TOKEN'),
    runnerUrl: localUrl('RUNNER_URL'), runnerToken: secret('RUNNER_TOKEN'), signingKey: secret('APPROVAL_SIGNING_KEY'),
    waitSeconds: integer('WAIT_SECONDS', 86400, 5, 86400), totalSeconds: integer('TOTAL_SECONDS', 172800, 30, 172800),
    retentionDays: integer('RETENTION_DAYS', 7, 1, 30),
  };
}
export type Config = ReturnType<typeof config>;
