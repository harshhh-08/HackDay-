# Changelog

## Verification follow-up — 2026-10-25

- Kept the no-install constraint; reused existing native PostgreSQL and spike
  packages for 11 passing application transaction/outbox/recovery scenarios.
- Added real loopback Python HTTP checks; total Node/Python tests now 10/39.
- Fixed replay after deletion, delayed submissions after purge, force-cleanup
  escalation after graceful-stop timeout, readiness truthfulness, and finalizing
  cancellation metadata. Bounded cleanup acknowledgement avoids infinite waits.
- Strengthened internal JSON validation and disabled Podman proxy inheritance.
- Extract documented targets already present in narrative/logs; added a seven-case
  benchmark with 7/7 correct decisions and zero unsupported source claims.
- Added recipient-run API acceptance and real Podman diagnostic suites. Runtime
  preflight was blocked (0 probes); TypeScript/Express/Podman remain unverified.

## 0.1.0-dev — source generation, 2026-10-25

- Generated Express/TypeScript lifecycle, approval/cancellation, report/artifact
  and deletion API with Zod validation and local maintainer authorization.
- Added PostgreSQL migrations, idempotency/outbox, BullMQ/PostgreSQL phase jobs,
  finite waits, reconciliation and retention code.
- Added model-off Python triage, source references, deterministic verdict rules
  and JSON/Markdown report assembly.
- Added fixture-only Podman runner source, signed plan policy, execution journal,
  bounded artifacts and cleanup/restart handling.
- Authored checkout failure/control fixture and explicit-approval CLI.
- Added tests, source checks, recipient setup, OpenAPI generator, unexecuted
  integration smoke script and source-only WhatsApp ZIP packaging.
- No dependencies installed/services started in this pass. Actual application,
  migration and Podman integration remain unverified.

## Initial discovery — 2026-10-25

- Audited the empty workspace and target Mac; recorded the product/task roadmap.
- Selected BullMQ 6.4.2/PostgreSQL after a separate real feasibility experiment.
- Added MIT license and initial third-party/architecture decision records.
