// Syntax validation only. TypeScript typechecking is a separate installed-tool check.
import { readFile, readdir } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = new URL('../', import.meta.url);
const excluded = new Set(['node_modules', '.git', '.local', 'dist', 'spikes']);
let count = 0;
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (/\.(?:ts|mjs)$/.test(path)) {
      const source = await readFile(path, 'utf8');
      const javascript = path.endsWith('.ts') ? stripTypeScriptTypes(source, { mode: 'strip' }) : source;
      const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: javascript, stdio: ['pipe', 'inherit', 'inherit'] });
      if (result.status !== 0) process.exit(result.status ?? 1);
      count++;
    }
  }
}
await visit(root.pathname);
console.log(`Syntax checked ${count} JavaScript/TypeScript files. This is not a typecheck.`);
