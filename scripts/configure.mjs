import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const password = randomBytes(32).toString('hex');
const configured = template.split('\n').map(line => {
  if (line.startsWith('POSTGRES_PASSWORD=')) return `POSTGRES_PASSWORD=${password}`;
  if (line.startsWith('DATABASE_URL=')) return `DATABASE_URL=postgresql://bugout:${password}@127.0.0.1:5432/bugout`;
  return line.includes('=GENERATE_ME') ? line.replace('GENERATE_ME', randomBytes(32).toString('hex')) : line;
}).join('\n');
await writeFile(new URL('../.env', import.meta.url), configured, { flag: 'wx', mode: 0o600 });
console.log('Created private .env. Existing files are never overwritten. No services or dependencies were installed.');
