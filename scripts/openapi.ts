import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { Approval, Cancellation, Intake, Reply, Evidence, Analysis } from '../packages/contracts/schemas.ts';

const json = (schema: z.ZodType) => ({ 'application/json': { schema: z.toJSONSchema(schema, { io: 'input' }) } });
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const key = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9._-]{8,128}$' } };
function operation(summary: string, schema?: z.ZodType, status = '200', parameters: unknown[] = [id]) {
  return { summary, parameters: schema ? [...parameters, key] : parameters,
    ...(schema ? { requestBody: { required: true, content: json(schema) } } : {}),
    responses: { [status]: { description: 'Operation result; see docs/api.md for response fields' },
      '400': { description: 'Invalid schema or JSON' }, '401': { description: 'Maintainer authentication required' },
      '404': { description: 'Not found' }, '409': { description: 'State, hash or idempotency conflict' },
      '413': { description: 'Body exceeds 64 KiB' }, '503': { description: 'Required dependency unavailable' } },
  };
}
const document = {
  openapi: '3.1.0', info: { title: 'bug.out local fixture API', version: '0.1.0-dev' },
  servers: [{ url: 'http://127.0.0.1:8787' }], security: [{ maintainer: [] }],
  components: { securitySchemes: { maintainer: { type: 'http', scheme: 'bearer' } },
    schemas: { Evidence: z.toJSONSchema(Evidence), Analysis: z.toJSONSchema(Analysis) } },
  paths: {
    '/v1/investigations': { post: operation('Create a sanitized investigation asynchronously', Intake, '202', []) },
    '/v1/investigations/{id}': { get: operation('Status, questions, plan, approvals and evidence'), delete: operation('Delete terminal investigation and artifacts', undefined, '204') },
    '/v1/investigations/{id}/replies': { post: operation('Answer the current question round', Reply, '202') },
    '/v1/investigations/{id}/approve': { post: operation('Approve or reject the exact current plan hash', Approval, '202') },
    '/v1/investigations/{id}/cancel': { post: operation('Request cancellation and tracked cleanup', Cancellation, '202') },
    '/v1/investigations/{id}/report': { get: { ...operation('Retrieve a persisted report'), responses: { '200': { description: 'Saved JSON or Markdown report', content: { 'application/json': { schema: { type: 'object' } }, 'text/markdown': { schema: { type: 'string' } } } }, '409': { description: 'Report not ready' }, '401': { description: 'Unauthorized' } } } },
    '/v1/investigations/{id}/artifacts/{artifact}': { get: operation('Retrieve an authorized bounded text artifact', undefined, '200', [id, { name: 'artifact', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }]) },
    '/health': { get: { ...operation('Process liveness only', undefined, '200', []), security: [] } },
    '/ready': { get: { ...operation('Mode-specific dependency readiness', undefined, '200', []), security: [] } },
  },
};
await writeFile(new URL('../docs/openapi.json', import.meta.url), `${JSON.stringify(document, null, 2)}\n`);
console.log('Generated docs/openapi.json from the installed Zod contracts.');
