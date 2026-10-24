import { Pool } from 'pg';

// Runtime driver construction is separate from the orchestrator-independent
// transaction services so those services can be checked with any existing driver.
export function database(url: string): Pool {
  return new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
}
