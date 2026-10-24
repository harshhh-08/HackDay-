# Bounded implementation tickets

**Original roadmap.** A subsequent user instruction authorized generating source
without installing dependencies. Many ticket code paths now exist; their complete
acceptance gates are not automatically satisfied. See `docs/verification.md` for
current checks. Real service/isolation scenarios here remain integration work.

Status: proposed work allocation after inspecting an empty workspace. Stop after
each ticket, report actual checks/diff/blockers, and obtain the next task boundary.
No feature ticket below is complete merely because it is specified here.

## Owners and integration rules

- **A / proposed integration lead:** `apps/api/`, `packages/contracts/`,
  `packages/workflow/`, `db/`, shared docs/configuration and release readiness.
- **B:** `services/worker/` triage/provider/report modules; excludes C's adapter
  and verdict modules. B does not independently change wire schemas.
- **C:** `services/runner/`, `services/worker/adapters/pytest/`,
  `services/worker/verdict/`, fixture/runner tests.
- **D:** `services/orchestrator/`, `apps/cli/`, `spikes/orchestration/`.

Human assignments remain to be confirmed. After Git setup, use separate short
branches named for the ticket. A owns shared contract changes and integrates
frequently. Freeze wire contracts before B/C/D parallel feature implementation.
Shared root manifests/lockfiles/migrations are integration-lead edits, not
concurrent workstream edits. Human review is required for security-sensitive
runner, approval, credential and migration changes.

### Verification command notation

Only the spike commands exist today. All other commands below are **proposed
test targets to introduce in that ticket**, not commands already available or
tests already run. `npm` targets run from the future workspace root unless a
directory is specified; Python commands run from the named service directory.
Each ticket must add its actual command to README and CI when implemented.

## Milestone 0

### M0-DISCOVERY — Inspect and break down the blueprint

- **Owner:** A. **Status:** complete for this change.
- **Files:** README, docs/architecture, api, security, demo, tasks, milestone-0,
  decision records, notices, license and ignore rules.
- **Dependencies:** supplied blueprint and real filesystem/tool inspection.
- **Acceptance:** distinguish actual/proposed functionality; inventory versions
  and blockers; one demo scenario; tickets with owners/interfaces/checks.
- **Verification:** directory inspection, `git status --short --branch`, tool
  version/readiness probes, source research, document-link/claim review.

### M0-ORCHESTRATION — Compare candidates and prove one minimal path

- **Owner:** D. **Status:** bounded feasibility complete; production gates open.
- **Files:** `spikes/orchestration/`, ADR-0001, saved experiment record.
- **Dependencies:** PostgreSQL binaries; no running developer DB needed.
- **Acceptance:** one selection; dated license/deployment matrix; actual task,
  DB persistence, wait/resume, retry/timeout, worker recovery and resource samples;
  explicitly scoped cancellation limitation and untested Trigger runtime.
- **Verification actually available:** in `spikes/orchestration/`, `npm ci
  --ignore-scripts --no-audit --no-fund`, `npm run check`, `SPIKE_TMPDIR=<existing
  temporary parent> npm test`, `npm audit --omit=dev`.

### M0-RUNTIME — Establish runner feasibility on the actual Mac

- **Owner:** C. **Status:** blocked by unavailable runtime; next task.
- **Files:** ADR-0004, `docs/runner-feasibility.md`, bounded runtime probe under
  `spikes/runner/` if useful. No production API changes.
- **Dependencies:** install/configure Podman and its VM as the explicit task;
  preserve unrelated runtimes/VMs. Record exact versions and image digests.
- **Acceptance:** a trusted tiny workload demonstrates network denial, no host
  credentials/socket/home mounts, unprivileged/capability restrictions, read-only
  root, writable-space/CPU/memory/PID/output limits, timeout/cancel/kill cleanup.
  Each unsupported control is a blocker, not a pass. Record VM and idle/active
  resource measurements alongside orchestration results.
- **Verification to implement:** `npm run test:runner-feasibility`; record actual
  `podman version`, `podman machine inspect`, workload inspection/stats and
  post-termination container checks. Do not run both orchestrator stacks.

### M0-FIXTURE — Author and validate the single demo fixture

- **Owner:** C, A confirms scenario. **Status:** pending.
- **Files:** `fixtures/checkout/`, its documented test target/config/dependency
  pins, `docs/demo.md`, fixture test artifacts.
- **Dependencies:** M0-RUNTIME; Git/revision registration before a live demo.
- **Acceptance:** the [specified discount example](demo.md) fails with the exact
  signal; passing control works; reproducible ARM64 Python/Pytest image with
  verified licenses/digest; no randomness; exact command and actual outputs
  recorded. Pin Python/Pytest after compatibility tests, not from host guesses.
- **Verification to implement:** `npm run test:fixture` invokes only the restricted
  test harness; assert selected node ID, exit, failure marker and passing control.
  If no initial Git commit is available, keep the revision/demo gate open rather
  than inventing a SHA. Repository initialization may be split out of M1-FOUNDATION
  as an explicit prerequisite; committing still requires user instruction.

## Milestone 1 — Foundation and shared interfaces

### M1-FOUNDATION — Versioned workspace and check tooling

- **Owner:** A. **Files:** Git initialization/branch, root manifests/lockfiles,
  TypeScript/Python tool configs, `.env.example`, CI, README/notices.
- **Depends on:** discovery; chosen orchestration. Mechanical Git setup can
  precede fixture revision registration without starting feature implementation.
- **Acceptance:** preserve spike; initialize repository/branch without an implicit
  commit; pin chosen toolchains; validate config; sanitized correlation logging;
  document actual setup/check commands. No speculative empty service scaffolds.
- **Verify:** introduce `npm run lint`, `npm run typecheck`, `npm test`, `npm run
  build`; locked Python sync/check commands; inspect Git diff/generated files.

### M1-CONTRACT — Freeze API, state, evidence and runner wire contracts

- **Owner:** A with B/C/D review. **Files:** `packages/contracts/`,
  `packages/workflow/` transition definitions, `docs/openapi.json`, API docs.
- **Depends on:** M1-FOUNDATION, demo/runner feasibility findings.
- **Acceptance:** Zod + generated JSON Schema/OpenAPI; explicit transitions,
  provenance, questions, cancellation metadata, exact plan/approval hash format,
  run classifications, reports, errors, budgets and versioning. Cross-language
  examples validate identically. No alternate enums in Python or UI.
- **Verify:** introduce `npm run test:contracts` including malformed/oversized
  requests, foreign evidence references, transition guards and hash-change cases;
  `npm run check:openapi`; lint/typecheck/build.

### M1-HEALTH — Configured process health/readiness boundary

- **Owner:** A. **Files:** `apps/api/` bootstrap/config/health tests.
- **Depends on:** M1-CONTRACT.
- **Acceptance:** `/health` only process health; `/ready` tests configured required
  dependencies, model-off needs no model, missing runner blocks execution mode;
  invalid/non-local unsafe config fails closed; loopback/token boundary recorded.
- **Verify:** introduce `npm run test:api-health` with dependency-off configurations.

## Milestone 2 — Durable API lifecycle

### M2-STORE — Migrations, transactions and idempotency

- **Owner:** A. **Files:** `db/migrations/`, application repositories/services.
- **Depends on:** M1-CONTRACT.
- **Acceptance:** investigations/transitions/questions/approvals/runs/reports and
  outbox tables with foreign keys, indexes, bounded metadata, unique logical
  keys and conditional transitions; separate queue schema/permissions; migration
  replay behavior documented. No optional delivery table until needed.
- **Verify:** introduce `npm run test:db` against disposable PostgreSQL: concurrent
  duplicate keys, changed payload conflict, invalid transition, restart retention.

### M2-API — Intake, status, reply, approval, cancellation, report access

- **Owner:** A. **Files:** `apps/api/`, application services and API integration tests.
- **Depends on:** M2-STORE, M1-HEALTH, B's M3-SANITIZE contract.
- **Acceptance:** all specified routes, consistent safe errors, owner authorization,
  capped/redacted intake, persistence before 202, idempotent writes, exact approval
  identity/hash, visible cancellation stages, authorized reports/artifacts. Stub
  work execution explicitly in tests, never present it as a live run.
- **Verify:** introduce `npm run test:api` for auth, oversized/malformed payload,
  concurrent replies/approvals, stale rounds/hash changes, report-not-ready.

## Milestone 3 — Evidence-aware triage

### M3-SANITIZE — Extraction and redaction with provenance

- **Owner:** B. **Files:** Python triage modules, fixtures, shared redaction boundary.
- **Depends on:** M1-CONTRACT. Agree with A how the API invokes sanitization before
  raw persistence; avoid independently diverging secret policies in two languages.
- **Acceptance:** bounded parsing of explicit errors/versions/locations/commands;
  source references; no invented missing values; key/token/password/private-key
  redaction; metadata stores locations/types, never removed values.
- **Verify:** from `services/worker/`, introduce `uv run pytest tests/triage`;
  capture provider inputs/logs to prove synthetic secrets never reach them.

### M3-QUESTIONS — Model-off questions/replies/finite waits

- **Owner:** B, A integrates persistence. **Files:** gap logic/provider interface,
  follow-up application service, benchmark fixtures and report-incomplete path.
- **Depends on:** M3-SANITIZE, M2-STORE, M1-CONTRACT.
- **Acceptance:** targeted question for the demo, no questions for known fields;
  bounded rounds, same investigation on reply, expiry produces finite incomplete
  report; strict provider-response/source validation; fallback on provider outage.
- **Verify:** introduce `uv run pytest tests/questions tests/providers` with
  invented versions/commands/root causes and injected instructions; benchmark
  genuine blocker detection, question relevance and unsupported-claim count.

### M3-MODEL — Optional local model qualification

- **Owner:** B. **Files:** provider adapter, model ADR and benchmark record.
- **Depends on:** M3-QUESTIONS; does not block model-off P0.
- **Acceptance:** exact model/runtime/quantization/license, local RSS/latency/context
  and structured-output reliability measured. Candidate failure preserves fallback.
- **Verify:** introduce `uv run python -m benchmarks.model`; record model-off and
  actual provider results separately. Never use hosted AI as a hidden prerequisite.

## Milestone 4 — Restricted execution and evidence

### M4-RUNNER — Durable restricted runner service and artifacts

- **Owner:** C. **Files:** `services/runner/`, runner integration/security tests.
- **Depends on:** M0-RUNTIME, M0-FIXTURE, M1-CONTRACT.
- **Acceptance:** scoped authenticated submit/query/cancel interface, immutable
  snapshots, exact hash binding, same-run-id submission deduplication, durable
  runtime handles, independent timeout/cleanup, restart reconciliation, bounded
  artifacts and retention/delete support. No API/orchestrator repository execution.
- **Verify:** introduce `npm run test:runner` for network/mount/path/symlink escapes,
  CPU/memory/PID/disk/output caps, timeout, cancellation and runner crash; inspect
  actual runtime state after each. Mark unsupported enforcement as a blocker.

### M4-PYTEST — Adapter and execution classification

- **Owner:** C. **Files:** Pytest adapter/parser, known evidence fixtures.
- **Depends on:** M4-RUNNER, shared contracts.
- **Acceptance:** recorded revision, argv, image/environment, timestamps/duration,
  exit, selected test summary and artifacts for every attempt. Separate test
  pass/failure, collection, dependency/setup/build, timeout, cancel, infrastructure
  failure and unsupported framework. Never trust a log marker alone.
- **Verify:** introduce `uv run pytest tests/adapters` plus `npm run test:pytest-runner`
  for actual pinned pass/fail, collection error and unavailable dependency cases.

## Milestone 5 — Approval, deterministic verdict and reports

### M5-PLAN — Exact bounded plan and approval gate

- **Owner:** B drafts; A owns approval application service; C validates runner input.
- **Files:** plan/provider/policy modules and approval tests in owned directories.
- **Depends on:** M3-QUESTIONS, M4-PYTEST, M2-API.
- **Acceptance:** only sourced commands/environment/inputs; explicit expected
  signal/budgets; visible script/argv/hash; no execution before authorization;
  altered plan invalidates approval; reject destructive/path-traversal proposals.
- **Verify:** introduce `npm run test:approval` and `uv run pytest tests/planning`;
  race approval/rejection/cancel and test old hash against revised plan.

### M5-VERDICT — Versioned deterministic outcome rules

- **Owner:** C. **Files:** `services/worker/verdict/` and rule tests.
- **Depends on:** M4-PYTEST, frozen expected-signal contract.
- **Acceptance:** five outcomes; relevant observed signal, pass/fail repeat counts,
  setup/build distinction, truncation/ambiguous evidence handling, rule version
  and input run IDs. No model opinion as verdict input; no flaky label from one fail.
- **Verify:** introduce `uv run pytest tests/verdict`; table-driven known outcomes
  including all-pass, mixed, all-matching-fail, unrelated fail, no attempt and
  missing evidence. Synthetic inputs explicitly labeled in tests.

### M5-REPORT — Persisted JSON/Markdown with evidence references

- **Owner:** B, A integrates storage/retrieval. **Files:** report assembly and tests.
- **Depends on:** M5-VERDICT, M5-PLAN, M2-STORE.
- **Acceptance:** all required report sections, sanitized sources, unknowns and
  hypotheses clearly separated, durable both formats before ready event; safe
  rendering and authorized artifact references. Model wording cannot change verdict.
- **Verify:** introduce `uv run pytest tests/reports` and `npm run test:report-storage`
  with failure between evidence/verdict/report writes and misleading summaries.

## Milestone 6 — Integrate the selected orchestration

### M6-WORKFLOW — Outbox, phase jobs and runner submission

- **Owner:** D; A owns business services. **Files:** `services/orchestrator/`.
- **Depends on:** M2-STORE/API and M3/M4/M5 service contracts/implementations.
- **Acceptance:** BullMQ/PG only; IDs in jobs; atomic outbox and retry-safe dispatch;
  finite reporter/approval waits; business error vs test-result distinction;
  replay queries existing run rather than reexecutes; configured concurrency.
- **Verify:** introduce `npm run test:workflow` covering duplicate jobs, wait expiry,
  approve/reject, transient provider/DB/runner failures and bounded retries.

### M6-RECOVERY — Reconciliation and failure windows

- **Owner:** D with C. **Files:** orchestrator reconciliation and resilience tests.
- **Depends on:** M6-WORKFLOW.
- **Acceptance:** repair committed-but-unscheduled requests, expired waits, lost
  worker locks, saved-run/completion gaps, verdict/report interruption; propagate
  durable cancellation and verify cleanup. Repository/global contention cannot
  produce duplicate unsafe execution. Uncertain cleanup remains visible/blocked.
- **Verify:** introduce `npm run test:resilience` with worker/runner SIGKILL, queue
  disconnect, DB restart, duplicate events and two-worker contention. Assert
  database state and actual remaining containers, not just task return values.

## Milestone 7 — Complete the user flow

### M7-CLI — Real API client for the demo

- **Owner:** D. **Files:** `apps/cli/`, CLI tests, documented example commands.
- **Depends on:** M2-API and M6 integration.
- **Acceptance:** submit/status/reply/approve/reject/cancel/report; show exact
  plan/revision/hash/budgets; explicit confirmation; phase not percent; evidence
  visible; blocked/inconclusive/intermittent/not-reproduced distinctions.
- **Verify:** introduce `npm run test:cli` and `npm run demo:local` using actual
  API/runner/DB. No seeded output shown as a live result.

## Milestone 8 — Release gate

### M8-ACCEPTANCE — Verify claims from a clean checkout

- **Owner:** A with all workstreams. **Files:** E2E tests, setup/demo docs,
  notices, benchmark results, changelog/release notes.
- **Depends on:** all P0 tickets; local-model qualification optional.
- **Acceptance:** complete product checklist and blueprint acceptance scenarios;
  malformed/secrets/injection/duplicates/unsupported/expiry/cancel/restart cases;
  actual isolation evidence; verified licenses/images/pins; retention/deletion;
  clean checkout setup and two rehearsals. Notifications remain unsupported; if
  added later, delivery-failure/report-retention tests are mandatory in that ticket.
- **Verify:** introduce `npm run test:e2e`; run all actual lint/typecheck/build/
  Python/security tests and setup from a clean checkout. Record results and
  remaining limitations. A backup recording is a separate explicit presentation
  task after the live flow exists, not generated as part of this milestone audit.

## Integration order and gates

1. Finish M0-RUNTIME/fixture decisions and necessary repository foundation.
2. Freeze M1-CONTRACT with A/B/C/D before parallel feature branches.
3. A builds persistence/API, B builds deterministic triage, C builds runner/parser;
   D can prepare the CLI client and queue adapter against frozen contracts.
4. Integrate plan/approval/verdict/report, then full workflow and resilience.
5. Complete CLI demonstration, clean-checkout acceptance, licensing and rehearsal.

Do not start P1/P2 dashboard/import/publishing/multi-language work while a P0 gate
is open. Current blockers are concrete: missing Podman runtime, no executed
fixture or revision, no frozen production contracts. The BullMQ spike does not
satisfy product runner, approval, report, or full reliability acceptance tests.
