# ADR-0001 — BullMQ with PostgreSQL

- **Status:** Accepted for P0; production reliability/runner gates remain open.
- **Date:** 2026-10-25 local / source checks 2026-10-24 UTC.
- **Owner:** D, reviewed with integration lead A before contract freeze.
- **Choice:** **BullMQ 6.4.2, PostgreSQL backend, pg 8.23.1**. One orchestrator;
  no Redis/Valkey, BullMQ Pro, Trigger runtime, or hosted control plane is required
  by this selected path.

## Context and current versions

The target has 16 GiB unified RAM and must also accommodate VS Code, a runner VM,
and optionally a local model. PostgreSQL is already required as the authoritative
business store. The workspace had no previous orchestration choice or code.

Registry queries returned BullMQ **6.4.2** and `@trigger.dev/sdk` **4.8.1**.
Trigger's v4.8.1 deployment files were inspected. BullMQ's current PostgreSQL
backend is included in the MIT package, with optional peer dependency `pg`.
This changes the older assumption that BullMQ necessarily requires Redis.

The published npm package was installed and tested; its lockfile records exact
versions, resolved tarballs, and integrity hashes. BullMQ's npm `gitHead` is
`f42514c3d716dc81c2bbc65b883c9dc545fcb56d`; that source manifest says 6.4.1 while
the installed published package says 6.4.2. The upstream release script updates
version during publication. Package behavior was verified from the installed
6.4.2 artifact, rather than treating the source manifest as the published version.

## Comparison

**D** = primary-source documentation/source inspection; **E** = local experiment;
**P** = proposed application mechanism; **U** = unverified locally.

| Criterion | Trigger.dev 4.8.1 self-hosted | BullMQ 6.4.2 / PostgreSQL |
| --- | --- | --- |
| License | **D:** repository/server Apache-2.0; SDK has its own MIT LICENSE. This is an explicit package distinction. Full bundled service/image license audit is incomplete. | **D/E:** installed BullMQ and pg LICENSE files are MIT; PostgreSQL uses PostgreSQL License. Dependency lock metadata includes MIT, ISC, Apache-2.0, 0BSD. No Pro dependency. |
| Self-hosting | **D:** full deployment is published. Checked compose has webapp, PostgreSQL, Redis, Electric, ClickHouse, registry, MinIO, s2/init, supervisor, Docker socket proxy. Some services are configurable; minimum stripped topology **U**. Checkpoints, warm starts and autoscaling are cloud-only. | **E:** one native PostgreSQL service plus Node worker/client; no hosted services or additional datastore. Dedicated BullMQ schema and explicit migrations. |
| Durable waits | **D:** token waits with expiry exist, but self-hosted checkpoints are unavailable; docs link slot release to checkpointing. Resource-free long wait/resume cannot be assumed. Separate DB phase jobs would still be needed to satisfy our constraint. | **E/P:** save waiting business state and finish the job; enqueue a new phase on a persisted reply/approval. Delayed expiry and startup reconciliation. Reporter wait/restart tested; approval API remains planned. |
| Retries | **D:** task errors retry under configured bounds/backoff; AbortTaskRunError skips retry. External side effects still need idempotency. | **E:** attempts=2 gave exactly two starts; UnrecoverableError did not retry timeout/cancel. Test pass/fail will be returned evidence, not a thrown queue error. |
| Cancellation | **U:** killing/cancelling a task cannot establish that a separate bug.out runner stopped. Persist request and explicitly stop/query runner. | **D/E:** AbortSignal is cooperative; cancelJob targets the owning Worker. IPC timer cleanup tested. **P:** DB cancellation intent, runner cancel RPC, independent runner deadline, cleanup acknowledgement, reconciliation. Container cleanup **U**. |
| Concurrency/rate limits | **D:** task, named and keyed limits documented; self-hosted wait/slot behavior needs validation. | **D:** global queue cap documented; configured to one in probe. **P:** unique active-run constraint and repository lease in DB, global runner cap one initially. Multi-worker contention/rate limits **U**. No paid group feature needed. |
| Persistence/recovery | **D/U:** platform persistence exists; checkpointless restart/resume not exercised. Application DB must still reconcile side effects. | **E:** killed active worker recovered after stale lock; conditional SQL left one business effect. Clean PostgreSQL restart preserved queue and app rows. Forced DB crash, outbox loss windows, runner recovery **U**. |
| Local footprint | **D:** vendor lists webapp 3+ vCPU/6+ GB and worker 4+ vCPU/8+ GB. Not measured consumption. Default compose has 10 long-lived services plus an init container, before task containers. Docker absent. | **E:** native probe uses one DB service, harness and worker. Worker RSS ~68–70 MiB; DB process RSS sum ~110–131 MiB (shared pages counted repeatedly); harness ~71–72 MiB. Short samples, no model/runner/peak-load budget claim. |
| Developer experience | **U:** installation/task timing not measured; Docker/Compose absent. Requires control plane/bootstrap/deployment. | **E:** initial install added 25 packages in 6 s; lockfile reinstall 274 ms; final scenario suite 3411 ms. Existing PG binaries were used; these are not clean-machine provisioning timings. |
| Portability | **P:** business services can stay external, but long-running token/task abstractions introduce SDK coupling. | **P:** queue wrapper only receives IDs/event keys. Business transitions, approvals, reports and runner contract live outside BullMQ. Backend migration does not change evidence schemas. |
| Security | **D:** supervisor's socket proxy is privileged infrastructure; it is not a restricted repository runner. Secrets/configuration audit needed. | **P:** queue jobs carry opaque IDs only; DB credentials scoped to control plane. API/worker never execute repository code. Probe is trusted test code with disposable local trust auth, not the application security configuration. |

The default Trigger compose's floating `redis:7`/other tags do not establish exact
component licenses or image contents. MinIO, Electric, s2, ClickHouse, proxy,
registry, SDK dependencies and image notices would all require version-pinned
review before adoption. We make no blanket full-stack license claim for Trigger.

## Prototype gate and measurements

BullMQ was viable with already installed tools and was tested in
[`spikes/orchestration`](../../spikes/orchestration/README.md). The
[saved result](../evidence/orchestration-2026-10-24.json) records seven groups of
assertions: task/persistence/wait/resume/deduplication; delayed expiry; bounded
retry; cooperative timeout; cooperative cancellation; worker SIGKILL recovery;
clean database restart. It also records actual process samples.

Trigger was eliminated at the local feasibility screen: Docker/Compose were
absent, the published combined resource requirements leave little room on this
16 GiB target, and self-hosting excludes the checkpoint mechanism needed for
its advertised resource-releasing waits. No Trigger experiment was run and no
measured memory, cancellation, or recovery result is attributed to it. Its docs
do not prove it cannot run in a smaller configuration; validating such a custom
deployment is outside this timeboxed P0 comparison. No competing stack was left
running or installed.

To reproduce a Trigger comparison on a suitable host: check out tag v4.8.1,
follow the linked self-host Docker guide with loopback bindings and generated
secrets, pin all images, and run the same scenario list above. Specifically
measure a pending token's process RSS and concurrency occupancy, kill its worker,
resume the token, and check PostgreSQL state. Then tear down only that experiment's
compose project and volumes. These are **unexecuted reproduction instructions**,
not a claim that a runnable Trigger harness exists here.

## Weighted assessment

Scores are decision judgments from the evidence above, **not benchmark results**.
Scale 1 (poor/unsupported evidence) to 5 (strong fit). Unknowns reduce a score;
hard requirements and remaining acceptance tests take precedence over totals.

| Criterion | Weight | Trigger | BullMQ/PG |
| --- | ---: | ---: | ---: |
| Open-source/self-hosting fit | 20 | 3 | 5 |
| Resource-releasing waits | 15 | 1 | 4 |
| Bounded retries | 10 | 4 | 5 |
| Cancellation/cleanup | 10 | 2 | 2 |
| Recovery | 15 | 2 | 4 |
| Local footprint | 20 | 1 | 5 |
| Implementation effort | 10 | 2 | 4 |
| **Weighted total / 100** | **100** | **41** | **86** |

## Consequences and migration boundary

1. Use small phase jobs. Persist wait deadlines and business state in PostgreSQL;
   never keep a worker Promise alive while awaiting a human.
2. Keep application schema separate from `bullmq`. Use a transactional application
   outbox; sharing a server does **not** make `queue.add()` part of an application
   transaction. A dispatcher retries using stable event keys and a reconciler
   repairs stale/missing work. Probe code does not yet implement these.
3. At-least-once delivery is expected. Save execution intent/run ID before calling
   the runner; runner submission must be idempotent by run ID and approved hash.
   Never start a new run just because a queue attempt was replayed.
4. Queue cancellation is not workload termination. Store runner container ID and
   cleanup state; verify termination before declaring completed cancellation.
5. The PG backend is less battle-tested than Redis according to its own docs.
   Pin versions, test migrations/restarts/contention before P0 release, and retain
   an adapter boundary for replacement if verified defects block the workflow.
6. Do not remove required PostgreSQL durability settings to chase throughput.
   Use separate migration/runtime credentials and explicit pool/connection budgets.

## Sources checked this session

- [BullMQ PG backend at inspected source commit](https://github.com/taskforcesh/bullmq/blob/f42514c3d716dc81c2bbc65b883c9dc545fcb56d/docs/gitbook/guide/postgresql.md)
- [BullMQ MIT license at source commit](https://github.com/taskforcesh/bullmq/blob/f42514c3d716dc81c2bbc65b883c9dc545fcb56d/LICENSE)
- [BullMQ retries](https://docs.bullmq.io/guide/retrying-failing-jobs), [cancellation](https://docs.bullmq.io/guide/workers/cancelling-jobs), [global concurrency](https://docs.bullmq.io/guide/queues/global-concurrency)
- [PostgreSQL license](https://www.postgresql.org/about/licence/)
- [Trigger v4.8.1 repository license](https://github.com/triggerdotdev/trigger.dev/blob/v4.8.1/LICENSE), [SDK MIT license](https://github.com/triggerdotdev/trigger.dev/blob/v4.8.1/packages/trigger-sdk/LICENSE)
- [Trigger self-hosting comparison](https://trigger.dev/docs/self-hosting/overview), [Docker requirements/setup](https://trigger.dev/docs/self-hosting/docker)
- [Trigger v4.8.1 webapp compose](https://github.com/triggerdotdev/trigger.dev/blob/v4.8.1/hosting/docker/webapp/docker-compose.yml), [worker compose](https://github.com/triggerdotdev/trigger.dev/blob/v4.8.1/hosting/docker/worker/docker-compose.yml)
- [Trigger wait tokens](https://trigger.dev/docs/wait-for-token), [retries](https://trigger.dev/docs/errors-retrying), [concurrency and checkpoint semantics](https://trigger.dev/docs/queue-concurrency)

Live documentation may change. Source-tag/commit links and the probe lockfile
anchor the comparison; recheck sources before upgrades.
