# Orchestration feasibility probe

Experimental control-plane code, owned by workstream D. It is not the product
workflow, a runner, or a production schema. Probe states such as `reply_received`
and `incomplete` are private test labels, not additions to the product enums.

## Reproduce

Prerequisites and commands are in the [root README](../../README.md).
`run.mjs` creates a unique directory below the supplied `SPIKE_TMPDIR`, initializes
a new PostgreSQL cluster, and binds only `127.0.0.1:55439` with no Unix socket.
It never connects to port 5432 or uses an existing cluster. Do not run two probes
at once. A port conflict must fail startup; do not stop an unrelated service.

The test applies BullMQ's own migrations to schema `bullmq` and creates one
synthetic application table. It starts `worker.mjs` as a child process and
asserts:

1. A real queued task changes a saved application record.
2. Awaiting a reply leaves no active job. The worker can stop; the reply updates
   the same row and a new job resumes it after restart.
3. Repeated job IDs and distinct duplicate events each leave one guarded effect.
4. A delayed expiry survives worker downtime; a stale expiry cannot overwrite a
   completed record.
5. A transient failure executes exactly two attempts with a bounded backoff.
6. A 150 ms cooperative timeout clears its timer, persists cleanup, and executes
   only once despite a retry budget of two.
7. An IPC cancellation request reaches the owning worker and clears its timer
   without retrying. This IPC mechanism is not a production cancellation bus.
8. `SIGKILL` during an active task causes stalled-job recovery on a new worker:
   two starts, one guarded database effect.
9. A clean PostgreSQL stop/start preserves application and queue records.

The script prints JSON with actual assertions and process RSS/CPU samples. RSS
is in KiB; summing PostgreSQL processes double-counts shared memory. These are
short-run samples, not peak/RSS-under-load guarantees or a complete product budget.

## Boundaries

- No repository code, model, human approval, real runner, or network workload.
- No production state machine, transactional outbox, reports, reconciliation,
  per-repository lease, or cross-worker cancellation protocol.
- Global queue concurrency is configured to one; multi-worker enforcement and
  repository/investigation limits require later contention tests.
- The database restart is orderly; power loss, forced DB crash, and network
  partition behavior have not been tested.
- Lock/stall intervals of one second accelerate the probe. They are not proposed
  production defaults.
- The orchestrator's application row update and enqueue are separate operations
  here. The production adapter must use a transactional application outbox even
  though both stores use PostgreSQL.
- The `finally` block stops the child/cluster and removes only its freshly
  created temporary directory. An uncatchable interruption of `run.mjs` can leave
  its cluster running. Locate the exact `bugout-spike-*` directory printed in a
  PostgreSQL startup error or inspect the temporary parent; use `pg_ctl -D
  <that-owned-directory>/data -m fast -w stop` before removing it. Never target an
  existing developer database. Full crash-safe cleanup belongs to the runner.

No Trigger.dev infrastructure was installed. See the
[ADR](../../docs/decisions/0001-orchestration.md) for its evaluation and why a
local prototype was not viable in this environment.
