# Architecture decisions

Accepted describes the intended implementation direction, not feature completion.
Any material contract change needs an updated ADR and agreement with its owner.

| ADR | Status |
| --- | --- |
| [0001 — Orchestration](0001-orchestration.md) | Accepted: BullMQ/PostgreSQL, limited local proof |
| [0002 — Project license](0002-license.md) | Accepted: MIT |
| [0003 — Model mode](0003-model.md) | Accepted: model-off first; specific model selection deferred |
| [0004 — Restricted runner](0004-runner.md) | Proposed: Podman; runtime verification blocked |
| [0005 — P0 interface](0005-ui.md) | Accepted: CLI first |
| [0006 — Source ZIP mode](0006-source-archive.md) | Accepted: no-install generation, content-hash identity |

Payload, time, retention, and resource budgets in [architecture.md](../architecture.md)
are proposed conservative defaults. M1-CONTRACT must freeze and validate them
before parallel production implementation.
