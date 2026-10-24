# API — generated local-fixture implementation

Routes: `apps/api/main.ts`; request/boundary schemas:
`packages/contracts/schemas.ts`. Express endpoint integration has not been run;
the underlying DB transaction services and Python HTTP boundaries have separate
passing checks. After
dependency installation, `npm run openapi` generates `docs/openapi.json` from Zod.
The generator is supplied but has not been executed in this no-install pass.

Base: `http://127.0.0.1:8787`. Every `/v1/` route requires
`Authorization: Bearer <BUGOUT_TOKEN>`, mapped server-side to `local-maintainer`.
There is no public or multi-user mode. POST writes require `Idempotency-Key`
(8–128 letters, digits, `.`, `_`, `-`). Same sanitized payload/key replays the
saved result; changed content conflicts. Unknown fields are rejected; total
JSON body limit is 64 KiB. Common secrets are redacted before persistence.

| Route | Success | Behavior/body |
| --- | --- | --- |
| `POST /v1/investigations` | 202 | Required `title`, `description`; return ID/status URL after DB/outbox commit. |
| `GET /v1/investigations/{id}` | 200 | Separate job/outcome/delivery status, rounds, plan/hash, approvals, runs, transitions, deadlines and cancellation. |
| `POST /v1/investigations/{id}/replies` | 202 | `round_id`, `answers: [{question_id, answer}]`; answer each current question once. |
| `POST /v1/investigations/{id}/approve` | 202 | `plan_hash`, `decision: approved | rejected`; exact current plan required. |
| `POST /v1/investigations/{id}/cancel` | 202 | Optional `reason`; acknowledges request, not completed termination. |
| `GET /v1/investigations/{id}/report` | 200 | Saved JSON; use `Accept: text/markdown` for Markdown. 409 until saved. |
| `GET /v1/investigations/{id}/artifacts/{artifact}` | 200 | Authorized bounded sanitized `text/plain`. |
| `DELETE /v1/investigations/{id}` | 204 | Terminal investigation and artifacts; runner must acknowledge safe purge. |
| `GET /health` | 200 | Public process liveness only. |
| `GET /ready` | 200/503 | Public dependency-ready booleans; no credentials exposed. |

Optional intake: `expected_behavior`, `actual_behavior`, `logs`, `environment`,
`repository_id` (only `checkout`), `repository_revision`, `test_target`,
`repeat_count` (1–3, default 1). Commands are never accepted as executable shell.
Only the two documented fixture targets can become approved plans.

Create example:

```json
{"title":"Checkout total is wrong","description":"Checkout sometimes gives the wrong total."}
```

Reply example, replacing the round UUID with the real current one:

```json
{"round_id":"11111111-1111-4111-8111-111111111111","answers":[{"question_id":"test_target","answer":"tests/test_checkout.py::test_percentage_discount"}]}
```

Approve using the exact status `plan_hash` and `decision: approved`. It binds the
snapshot/commit metadata, image, argv, signal, budgets, network and repeat count.
API clients must show these fields for maintainer confirmation as the CLI does.

Errors have `{ "error": { "code", "message", "correlation_id" } }` and
`X-Correlation-Id`. Stable families include `VALIDATION_ERROR` (400),
`UNAUTHORIZED` (401), `NOT_FOUND` (404), `IDEMPOTENCY_CONFLICT`, `PLAN_CHANGED`,
`ROUND_EXPIRED`, `NOT_AWAITING_APPROVAL`, `NOT_AWAITING_REPLY`, `NOT_CANCELLABLE`,
`NOT_TERMINAL`, `REPORT_NOT_READY` (409), `BODY_TOO_LARGE` (413), and service errors.
Errors never echo raw submitted content.

Reporter timeout finalizes a blocked report. Runner communication exhaustion can
fail with cleanup `unconfirmed`, which never means termination was observed.
Delivery is always `not_requested` in this version.

Internal services use separate bearer tokens. The engine exposes `/analyze` and
`/report`; the runner exposes snapshot, idempotent run submit/query/cancel,
artifacts and purge. Runner approval is HMAC-bound to investigation/run/plan hash.
Shared constants live in `packages/contracts/constants.json`; cross-language hash
and redaction vectors are tested. Model-drafted arbitrary scripts are unsupported.
