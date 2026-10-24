# ADR-0004 — Podman runner feasibility gate

- Date: 2026-10-25 local.
- Status: Proposed; blocked pending runtime availability and actual tests.

Update: runner service/image/policy/recovery code and simulated tests were generated
without installing Podman. This does not close the actual runtime feasibility gate.

Retain the blueprint's Podman-backed, separate restricted runner as the candidate.
Podman and Docker were unavailable on PATH; no VM/image/resource/security test
was run. No alternative execution path is silently substituted.

C owns M0-RUNTIME: install/configure a local runtime as an explicit bounded task,
record ARM64 VM/runtime versions, pin images and verify resource enforcement,
network denial, mount restrictions, unprivileged execution, filesystem limits,
timeout/cancel/kill and cleanup. Record VM resources alongside the orchestration
measurements. Reject unsupported restrictions rather than calling them enforced.

Only the runner service holds runtime access. API/Python/orchestrator services
must never execute repository code, including installation hooks. A failed
feasibility gate requires a revised ADR with equivalent isolation or a clear
blocked demo. A subprocess on the API host is not an acceptable fallback.
