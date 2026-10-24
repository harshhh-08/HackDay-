import { AppError } from '../contracts/domain.ts';
export async function service(url: string, token: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000),
    redirect: 'error',
  });
  if (!response.ok) throw new AppError(response.status, 'SERVICE_UNAVAILABLE', `Required service returned ${response.status}.`);
  // Internal service replies are still capped and validated by their caller.
  if (!response.body) throw new Error('Empty service response');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 1048576) throw new Error('Service response limit exceeded');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
