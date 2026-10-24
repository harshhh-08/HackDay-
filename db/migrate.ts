import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { runMigrations } from 'bullmq';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtextextended('bugout-migrations', 0))");
  await client.query(await readFile(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8'));
  await runMigrations(client);
  console.log('Application and BullMQ migrations applied.');
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtextextended('bugout-migrations', 0))").catch(() => {});
  client.release(); await pool.end();
}
