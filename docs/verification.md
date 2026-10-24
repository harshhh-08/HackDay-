# Verification — current results and remaining gates

Updated 2026-10-25 local. The user explicitly retained **no installations**.
No packages, runtime or images were installed. Existing PostgreSQL binaries and
already-installed pg/BullMQ packages from the earlier spike were reused read-only
for a disposable database test. Python tests opened real loopback HTTP servers
on ephemeral ports. All test services/data were cleaned up.

## Passed

| Check | Actual result | Scope |
| --- | --- | --- |
| Node unit tests | **10 passed** | Transition/approval/hash policy, finite cleanup wait, redaction, readiness. |
| Python tests | **39 passed** | Engine/verdict/reports, real local HTTP/auth/validation, SQLite/artifacts, simulated execution/recovery/cancellation. |
| PostgreSQL/application/outbox | **11 scenarios passed** | Actual migration, transactions, concurrency, report atomicity, real BullMQ handoff and immediate DB shutdown/recovery. |
| Triage benchmark | **7/7 decisions correct; 3/3 questions target blockers; 20 source-supported facts, 0 unsupported** | Seven authored fixture report variants; model disabled. |
| Source parsing | **22 JS/TS files, 23 Python files, 5 embedded diagnostic programs** | Syntax only; no TypeScript semantic/type check. |

The [database result](evidence/database-2026-10-24.json) began at
`2026-10-24T21:43:47.613Z` and completed in 1018 ms. The cluster used a private
temporary Unix socket, no TCP listener, and no existing developer DB. Six
concurrent identical submissions produced one business effect/outbox event.
A successful enqueue followed by a lost acknowledgement was replayed without
creating a second job. Committed reports and queue metadata survived
`pg_ctl -m immediate` shutdown/restart.

The [triage benchmark](evidence/triage-2026-10-25.json) verifies that documented
targets already in narrative/logs are extracted with source locations. Ambiguous
or prefix-only targets are not guessed. This is not a model benchmark.

Python HTTP tests use the production handler/application functions over actual
loopback sockets. The engine is real deterministic code; runner execution is
explicitly simulated. No checkout test or Podman container executed here.

## Repaired defects

- Regression tests first reproduced deletion/replay failures: approved runs and
  delayed first submissions could revive deleted investigations. Durable UUID-only
  retirement records now reject both; they are bounded and survive data deletion.
- A mocked graceful-stop timeout previously aborted force cleanup. Cleanup now
  escalates and checks absence even when graceful stop fails. This proves the
  command path, not actual Podman behavior.
- Readiness requires an applied migration record and explicit `ready: true`,
  rather than treating every successful HTTP response as ready.
- Finalizing cancellation records consistent cleanup metadata. Never-started
  cancelled intents are not treated as running work. A 40-second acknowledgement
  budget records failed/**unconfirmed** cleanup if the runner never finishes;
  it never invents successful termination.
- Internal HTTP validation rejects wrong media types, duplicate lengths,
  non-finite JSON and malformed analysis fields predictably.
- Sanitized intake is revalidated because redaction can enlarge fields. The
  Express route check is supplied in the unrun acceptance suite.
- Podman's documented automatic host proxy forwarding is explicitly disabled.

## Commands actually run

```sh
node scripts/check.mjs
node --test tests/node/*.test.ts
python3 scripts/check_python.py
python3 -m unittest discover -s tests/python -v
node scripts/test-database.mjs
python3 scripts/benchmark_triage.py
python3 -m services.runner.verify
```

The agent set `PYTHONDONTWRITEBYTECODE=1` and directed temporary files to its
approved parent with `TMPDIR`/`BUGOUT_TEST_TMPDIR`. The DB test reused pg 8.23.1
and BullMQ 6.4.2 from `spikes/orchestration/node_modules`; it installs/copies/links
nothing. A new recipient needs existing matching packages and PostgreSQL tools.

The actual runtime-verifier attempt was **blocked**, exit 2:

```json
{"status":"blocked","reason":"Podman and an immutable local image are required","executed_probes":0}
```

Five embedded probe programs were parsed, not executed. The earlier queue spike
is separately recorded in [milestone-0.md](milestone-0.md).

## Still blocked / unverified

| Gate | Blocker and reproduction |
| --- | --- |
| TypeScript typecheck | `tsc` and root dependencies absent. After setup: `npm run typecheck`. |
| Generated OpenAPI | Root Zod absent. After setup: `npm run openapi`; generator syntax checked only. |
| Express/full phase workflow | Express/Zod absent. Start services, then `npm run test:acceptance -- --control-plane-only` (no fixture execution; skips runner-dependent deletion). |
| Actual fixture/CLI demo | No Podman/image. After setup: `npm run test:integration` and `npm run test:acceptance`; both explicitly approve the registered fixture. |
| Runtime isolation/resources/cleanup | `npm run verify:runner`; 0 probes executed here. Future probes cover cgroups, no network, UID/caps, mounts, process exhaustion, scratch ENOSPC, OOM, output, timeout and cancellation. |
| Live reporter expiry | Restart API with `WAIT_SECONDS=5`; run acceptance with `--expect-fast-waits`. Not run here. |
| Deployed worker/runner/VM failure windows | DB recovery and simulated runner recovery passed; full deployed workflow recovery remains unverified. |
| Root lockfile/audit and image inventory | Installation/build deferred; earlier spike audit is not an application audit. |
| Clean recipient setup and two live rehearsals | Require dependency/runtime setup. |

Model qualification is deferred, not required for the deterministic model-off
demo. Future runtime probe assertions and fixture expectations must not be
presented as observed live reproduction results until those executions occur.
