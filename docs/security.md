# Security boundaries and implementation status

**Application/runner source now exists. Policy and simulated-runner tests pass;
actual Podman isolation/resource/cleanup behavior is unverified.** Podman/Docker
were unavailable on PATH and no dependencies were installed in this pass.
Syntax checks, command flags and simulated tests do not establish isolation.

## Initial supported boundary

The supported code path is a local maintainer operating one registered Python
fixture, identified by content hash and an actual Git SHA when available.
Arbitrary public execution, remote/private repository import, and
non-local deployment are unsupported. Reporter text, repository content, logs,
attachments and model output are untrusted data even in this local mode.

### Control plane

- Validate sizes and schemas, redact common secrets before persistence/model use,
  and default to retaining only sanitized input plus redaction locations/types.
  Redaction is best-effort and cannot guarantee detection of all secrets.
- Do not log request bodies, tokens or raw output by default. Source references
  must identify sanitized fields/artifacts without retaining removed secret values.
- Generate a local maintainer token and derive actor identity server-side;
  authorize status, report, reply, approval, cancellation and artifact access.
  Loopback binding is not a substitute for authorization.
- Model proposals cannot authorize commands, override source facts, set outcomes,
  or alter policy. Validate schema/provenance and treat injected instructions as
  data; model-off fallback must not fabricate a response.
- API and orchestrator have no repository-execution capability or workload
  runtime socket. Static inspection must not import repository modules/plugins.

### Runner to validate before fixture execution

- Separate service with a scoped authenticated interface and immutable snapshot
  identity. Enforce exact approved plan/hash; reapproval after any change.
- No network by default; prebuilt pinned fixture image with dependencies.
  Dependency fetching/install hooks, if later enabled, execute only in isolation
  under an explicit approved source policy.
- No host home, credentials, SSH/cloud/API tokens, unrelated mounts or runtime
  socket inside the workload. Resolve paths/symlinks against approved roots and
  reject traversal or archive extraction escape.
- Unprivileged workload, dropped capabilities, no privilege escalation, read-only
  root where feasible; bounded writable scratch, CPU, memory, process count,
  duration and output. Prove each control on the actual macOS VM/runtime.
- Save runtime/container ID independently of orchestration attempts. On cancel
  or timeout, stop, escalate to kill, inspect for termination, and record the
  cleanup result. A failed cleanup blocks terminal-success claims and new runs.
- Runner independently enforces deadlines, survives controller disconnection,
  and reconciles its own labeled containers after restart. Worker cancellation
  alone cannot guarantee workload termination.

On macOS, workloads share the Linux VM kernel; VM mounts and runtime configuration
also affect the host boundary. Containers are not a complete security guarantee.
If required disk/resource/network restrictions cannot be verified, execution is
blocked rather than falling back to an API-host subprocess.

### Artifacts and retention

Use server-generated opaque references and workspace-scoped storage, with byte
caps, truncation metadata and authorization. Escape Markdown/terminal displays
of untrusted content; never interpret an output link/path as an instruction.
Retention defaults to seven days, attempted while the orchestrator is running.
Explicit deletion requires a terminal investigation and runner purge acknowledgement;
failed/unconfirmed cleanup is retained. No repository-content cache exists yet.
Ledger/artifact and Python HTTP tests passed using simulated execution; full API
retention/deletion and Podman integration remain unverified. See
[architecture](architecture.md) for budgets and [SETUP.md](../SETUP.md) for use.

The runner retains opaque cancelled-run UUIDs and retired investigation UUIDs.
These prevent delayed submissions and old signed requests from reviving cancelled
or deleted work. Each table is capped at 10,000, retains no report/log content,
and fails closed on capacity exhaustion. Do not reset the journal while requests
or containers might remain active. Packaging excludes this journal entirely.

Podman [forwards host/server proxy variables by default](https://github.com/containers/podman/blob/main/docs/source/markdown/options/http-proxy.md).
The runner now passes `--http-proxy=false`; real-runtime diagnostics also check
for inherited credential/proxy variables and unexpected bind mounts. Those
diagnostics remain unexecuted until Podman and a pinned image are available.

Cleanup escalates after a graceful-stop timeout. If cancellation/total-expiry
cleanup is still unacknowledged after 40 seconds, the workflow records `failed`
with `cleanup_status=unconfirmed`; it does not claim that termination occurred.

## Probe-specific behavior

`spikes/orchestration/` uses synthetic records and a newly initialized PostgreSQL
cluster bound to loopback, with trust authentication for disposable testing on
this single-user development machine. It inherits the developer process
environment and runs trusted code; it is **not** a sandbox. Never use it to run
bug-report commands or reproduction scripts. No real secrets are needed.

Normal and caught-error cleanup removes only the generated temporary directory.
Host/harness SIGKILL may leave that cluster running; manual recovery is documented
in the [probe README](../spikes/orchestration/README.md). Actual runner crash/kill
cleanup is a separate acceptance gate.
