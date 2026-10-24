import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { cleanDisplay } from '../../packages/contracts/domain.ts';

const [command, ...args] = process.argv.slice(2);
const base = process.env.BUGOUT_API_URL ?? 'http://127.0.0.1:8787';
const token = process.env.BUGOUT_TOKEN ?? '';
const url = new URL(base);
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Only a loopback API is supported');
function flag(name: string, fallback = ''): string {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}
async function request(path: string, body?: unknown, method?: string, accept = 'application/json'): Promise<any> {
  if (token.length < 32) throw new Error('Configure BUGOUT_TOKEN first');
  const response = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept,
      'idempotency-key': flag('--idempotency-key', randomUUID()) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  if (response.status === 204) return { deleted: true };
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${cleanDisplay(text)}`);
  return accept === 'text/markdown' || accept === 'text/plain' ? text : JSON.parse(text);
}
const print = (value: unknown) => console.log(cleanDisplay(typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
const id = args[0];
const path = `/v1/investigations/${encodeURIComponent(id ?? '')}`;
const help = `bug.out — Bugs in. Answers out.

submit --title TEXT --description TEXT [--target PYTEST_NODE] [--repeats 1..3]
status ID
watch ID                  Show actual state; stop at human input or terminal state
answer ID --target PYTEST_NODE
approve ID                Show exact plan and require typing its full hash
reject ID                 Reject the current plan
cancel ID [--reason TEXT]
report ID [--markdown]
artifact ID --artifact UUID
delete ID --yes           Delete a terminal investigation and its artifacts

Writes accept --idempotency-key KEY (reuse it when retrying the same request).
No repository command is executed by this CLI.`;

try {
  if (!command || command === 'help' || command === '--help') print(help);
  else if (command === 'submit') {
    print(await request('/v1/investigations', {
      title: flag('--title'), description: flag('--description'), repository_id: 'checkout',
      ...(flag('--target') ? { test_target: flag('--target') } : {}), repeat_count: Number(flag('--repeats', '1')),
    }));
  } else {
    if (!id || id.startsWith('--')) throw new Error('An investigation ID is required');
    if (command === 'status') print(await request(path));
    else if (command === 'watch') {
      let last = '';
      while (true) {
        const current = await request(path);
        if (current.job_status !== last) { print({ investigation_id: id, job_status: current.job_status, test_outcome: current.test_outcome }); last = current.job_status; }
        if (['awaiting_reporter', 'awaiting_approval', 'completed', 'failed', 'cancelled'].includes(last)) { print(current); break; }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } else if (command === 'answer') {
      const current = await request(path);
      const round = current.rounds.find((r: { status: string }) => r.status === 'open');
      if (!round) throw new Error('No active question round');
      print(await request(`${path}/replies`, { round_id: round.id, answers: [{ question_id: 'test_target', answer: flag('--target') }] }));
    } else if (command === 'approve' || command === 'reject') {
      const current = await request(path);
      if (current.job_status !== 'awaiting_approval' || !current.plan_hash) throw new Error('No current approval proposal');
      print({ plan: current.plan, plan_hash: current.plan_hash });
      if (command === 'approve') {
        const prompt = createInterface({ input: stdin, output: stdout });
        try {
          const confirmation = await prompt.question('Review the command, revision, image and limits above. Type the FULL plan hash to approve: ');
          if (confirmation.trim() !== current.plan_hash) throw new Error('Approval not confirmed; nothing submitted');
        } finally { prompt.close(); }
      }
      print(await request(`${path}/approve`, { plan_hash: current.plan_hash, decision: command === 'approve' ? 'approved' : 'rejected' }));
    } else if (command === 'cancel') print(await request(`${path}/cancel`, { reason: flag('--reason', 'Requested by maintainer') }));
    else if (command === 'report') print(await request(`${path}/report`, undefined, 'GET', args.includes('--markdown') ? 'text/markdown' : 'application/json'));
    else if (command === 'artifact') print(await request(`${path}/artifacts/${encodeURIComponent(flag('--artifact'))}`, undefined, 'GET', 'text/plain'));
    else if (command === 'delete') {
      if (!args.includes('--yes')) throw new Error('Pass --yes to confirm deletion');
      print(await request(path, undefined, 'DELETE'));
    } else throw new Error(help);
  }
} catch (error) {
  console.error(cleanDisplay(error instanceof Error ? error.message : 'CLI operation failed'));
  process.exitCode = 1;
}
