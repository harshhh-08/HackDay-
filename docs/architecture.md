# Architecture — generated P0 development code

Status: generated source with passing logic/policy tests, real Python HTTP tests,
and PostgreSQL migration/transaction/outbox/recovery checks. Express/full workflow
and Podman execution remain unverified. Shared
constants and Zod schemas are in `packages/contracts/`; `npm run openapi`
generates the API document after installation. The user requested code generation
and ZIP sharing without further installations or requiring a Git repository.

## Components and flow

```text
CLI -> Express API -> PostgreSQL application state + outbox
                          |
                    outbox dispatcher -> BullMQ (PostgreSQL schema)
                                              |
                                    orchestration phase worker
                                      |                 |
                               Python engine      restricted runner API
                                      |                 |
                                optional model    Podman fixture container
                                      |                 |
                               validated facts    evidence + bounded artifacts
                                      \                 /
                                       verdict + reports
                                              |
                                        PostgreSQL -> CLI
```

- API: validation, authorization, redaction before persistence, state/reply/
  approval/cancellation requests, report and authorized artifact retrieval.
- `packages/contracts/`: sole owner of wire schemas; export versioned JSON Schema
  for Python validation. Do not maintain divergent hand-written TS/Python enums.
- `packages/workflow/`: orchestration-independent transition/application services.
- `services/orchestrator/`: BullMQ adapter, dispatcher, scheduled reconciliation.
  Jobs contain IDs/version/event keys, not raw reports, secrets, or code.
- `services/worker/`: Python extraction, questions, disabled provider boundary,
  deterministic verdict and report assembly. Never imports or
  executes repository modules while inspecting metadata.
- `services/runner/`: sole owner of workload execution, fixture snapshots,
  Pytest/JUnit parsing, runtime socket, termination and artifact capture. No DB/API/model credentials
  enter the workload. The orchestration worker calls this service over a bounded,
  authenticated interface; it never starts repository subprocesses.
- PostgreSQL: authoritative application rows, transitions, outbox, approvals,
  run intents/evidence/report metadata. BullMQ's tables are execution metadata in
  a separate schema. Separate migration/runtime roles are planned.
- Local artifact store: bounded files behind opaque authorized references, not
  arbitrary paths or public file URLs. No object-store service is needed for P0.

Repository identity is one registered local fixture. The runner hashes its exact
manifest and checks the image label. A clean checkout records its real Git SHA;
an archive or dirty checkout records `commit_sha: null` and its actual content
digest (ADR-0006). No remote repository import or retrieval cache is implemented.

## Draft lifecycle invariants

Product job statuses remain `queued`, `analyzing`, `awaiting_reporter`,
`awaiting_approval`, `running`, `finalizing`, `completed`, `cancelled`, `failed`.
Outcomes remain `reproduced`, `intermittent`, `not_reproduced`, `blocked`,
`inconclusive`; outcome is unset before determination. Delivery state is separate
and `not_requested` for P0. The probe's private state labels are not product states.

Transitions to encode and test at contract freeze:

- `queued -> analyzing`.
- `analyzing -> awaiting_reporter | awaiting_approval | finalizing`.
- `awaiting_reporter -> analyzing` after a valid current-round reply, or
  `finalizing` on expiry/round exhaustion.
- `awaiting_approval -> running` only after the exact current plan has an
  authorized approval and a durable run reservation; `finalizing` on rejection
  or expiry. Persist approval/outbox before the worker attempts execution.
- `running -> finalizing` after execution/termination evidence has been saved.
- `finalizing -> completed` only once both report formats are durable.
- Nonterminal states may fail or be cancelled under explicit guards. A requested
  cancellation is metadata while cleanup is pending, not proof of termination.
  Terminal states do not resume; late replies/events are rejected or inert.

An expired reporter wait ends with a saved incomplete/blocked report and
`completed`, not a new `incomplete` job enum. Fatal system failures use `failed`
with safe error data. Cancellation cleanup failure must be visible separately.

Each material fact carries `reported`, `extracted`, `observed`, `hypothesis`, or
`missing` provenance. Observations require a run/artifact/source reference.
Hypotheses never enter deterministic verdict inputs. Collection/setup failures
do not reproduce a runtime defect; one failed run cannot establish intermittency.

## Reliability and execution contract direction

- Commit application updates, transition audit, idempotency result, and outbox
  record atomically. Dispatch later; retries use a stable event key. No business
  transaction depends on success of a queue call.
- Human waits persist an absolute expiry and end the phase job. Reply/approval
  and expiry contend on versioned conditional updates. Reconcile due waits after
  downtime; delayed queue events are wakeups, not the only copy of deadlines.
- Reserve `run_id`, repeat index, repository SHA/snapshot hash, approved plan
  hash, adapter, argv, image digest, budgets and expected failure signal before
  calling the runner. Submission by the same run ID/hash returns the same run;
  a different hash conflicts. Do not promise exactly-once external execution.
- Store the runner's handle durably. If a worker dies after submit or completion,
  query that handle and persist existing evidence; do not launch another test.
- Runner records bounded artifacts before reporting completion. Evidence saving,
  versioned verdict computation and report finalization are separately resumable.
- Approval binds canonical versioned plan bytes, exact script bytes (if any),
  argv/options, SHA/snapshot, image/environment policy, signal and budgets.
  Any change invalidates approval. All demo execution will require confirmation,
  including deterministic adapter-generated commands.
- Keep migration/queue SDK imports out of business rules. A dispatcher/reconciler
  may be replaced without rewriting reports, approvals or runner contracts.

## Proposed conservative limits

These are implemented/configured defaults, not measured capacity or verified
runtime enforcement. Pure tests cover policy and command construction. Actual
Podman/network/resource behavior remains a release gate.

| Scope | Proposed default |
| --- | --- |
| HTTP JSON body | 64 KiB total; no attachments in initial intake |
| Title / description / inline logs | 200 characters / 16 KiB UTF-8 / 32 KiB UTF-8; total body limit also applies |
| Questions | At most 3 per round, 2 rounds |
| Human waits / total lifetime | 24 h each, 48 h overall; earliest expiry wins; test/demo overrides explicit |
| Experiments / repeats | 1 approved experiment, default 1 and maximum 3 executions |
| Transient orchestration retry | Maximum 3 attempts; bounded backoff; never retry a test merely because it failed |
| Execution / termination grace | 30 s wall clock, then 5 s grace and forced termination check |
| Workload resources | 1 CPU, 512 MiB memory, 64 processes, 128 MiB writable scratch; independent Podman timeout 35 s |
| Captured output | 64 KiB each stdout/stderr per run; record truncation explicitly |
| Artifact total | 2 MiB per investigation; quota failure is explicit |
| Runner concurrency | 1 globally for the local fixture; DB active-run guard per investigation/repository |
| Retention | 7 days for reports/artifacts/derived data; explicit local deletion by investigation ID; no raw secret-bearing input retained |

Local approver identity will derive from a generated maintainer bearer token,
mapped server-side to `local-maintainer`, never from a submitted actor name.
API binds loopback and checks authorization for every investigation/artifact.
Exposed/non-local deployment remains unsupported pending proper identity design.

The image definition uses Python 3.14 and Pytest 9.0.3; setup resolves and records
immutable image digests. No image build was run here. Only model-off analysis is
implemented. The runner uses a private SQLite execution/artifact journal while
PostgreSQL owns business state. Uncertain runner recovery cleans up and records
infrastructure failure rather than automatically rerunning repository code.
