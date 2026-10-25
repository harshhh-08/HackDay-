# bug.out

**Bugs in. Answers out.**

**Presentation:** [Canva Slide Deck / PPT](https://www.canva.com/design/DAHY-DVr8Dg/7R3uNcBBtWherj9VesIkCQ/edit?ui=e30)

A local-first, API-first debugging investigation engine. It asks for missing
information, requires approval of an exact experiment, delegates execution to a
restricted runner, and builds evidence-based JSON and Markdown reports.

## Status

**Generated development implementation; not an end-to-end verified MVP.**
The source includes the deterministic local-fixture flow. Unit tests, Python HTTP
boundaries and real PostgreSQL transaction/outbox checks pass. Express routes,
TypeScript typechecking, the full phase workflow and Podman execution still need
validation after dependency/runtime setup.

No additional dependencies were installed. The latest checks reused existing
PostgreSQL/queue tools in a disposable cluster and temporary loopback HTTP servers;
those test services were stopped and their data removed.

| Component | Source | Verification |
| --- | --- | --- |
| Express/TypeScript API + Zod | Intake/status/replies/approval/cancel/report/artifact/delete | Syntax/supporting services checked; Express endpoints and typecheck blocked |
| PostgreSQL + BullMQ | Migrations, transactional outbox, phase jobs, waits, reconciliation | 11 real DB/outbox/recovery scenarios passed; full phase workflow pending |
| Python engine | Redaction, extraction, questions, deterministic verdict and reports | Unit and real loopback HTTP checks passed; 7-case deterministic benchmark passed |
| Separate Podman runner | Signed plans, fixed fixture, bounded capture, journal, cleanup/recovery | HTTP/policy/simulated-runtime tests passed; actual runtime verifier blocked |
| CLI | Complete API client flow, explicit hash confirmation | Source checked; complete flow not run |
| Checkout fixture | Intentional discount defect and passing control | Not executed on the host or in a container |
| AI provider | Model-off only | No model/API/runtime dependency |

## Share with your friend

Send **`dist/bugout-source.zip`** as a WhatsApp document. It contains source,
tests, configuration examples, docs and the MIT license. It excludes dependencies,
`.env`, `.git`, local databases/artifacts, caches and generated archives.

Your friend can extract it, follow [SETUP.md](SETUP.md), and upload the source to
their GitHub repository. Git is not required to unpack or configure this project.
An archive records an actual fixture SHA-256 and `commit_sha: null`; a clean Git
checkout records its real commit when available.

Rebuild the ZIP without installing dependencies:

```sh
python3 scripts/package_source.py
```

## Dependency-free checks

Requires Node.js **24** and Python **3.11+** on macOS/Linux (tested with Node
24.18.0 and Python 3.14.7). From the project root:

```sh
node scripts/check.mjs
python3 scripts/check_python.py
node --test tests/node/*.test.ts
python3 -m unittest discover -s tests/python -v
python3 scripts/benchmark_triage.py
```

**10 Node tests and 39 Python tests passed.** Python tests briefly bind ephemeral
loopback HTTP ports; they execute no containers or checkout code. Simulated runner
results are synthetic. The triage benchmark scored 7/7 with no unsupported facts.

With already available native PostgreSQL tools and matching pg/BullMQ packages,
`npm run test:database` creates and removes a private-socket test cluster; its
11 real scenarios passed here. It never uses an existing `DATABASE_URL`.

After full setup, run `npm run typecheck`, `npm run openapi`,
`npm run verify:runner` and `npm run test:acceptance`. The last two perform actual
isolated diagnostic/fixture execution when prerequisites exist. They remain
blocked/unverified here; see [the verification scope](docs/verification.md).

## Layout

```text
apps/api/                 Express API
apps/cli/                 API-client CLI
packages/contracts/       Constants, Zod schemas, approval hashing
packages/workflow/        Config, persistence, transitions, redaction
db/                       Application and BullMQ migration entrypoint
services/orchestrator/    Outbox dispatcher, phase worker, reconciliation
services/worker/          Deterministic Python engine
services/runner/          Podman controller, execution ledger and image harness
fixtures/checkout/        Authored deterministic bug and passing control
tests/                    Unit/policy/simulated-runtime tests
scripts/                  Configure, checks, OpenAPI, smoke test and ZIP export
spikes/orchestration/      Earlier isolated feasibility experiment
```

## Scope and limitations

- Only the registered fixture and two documented targets execute. Arbitrary
  scripts, remote/private repository imports, public execution, auto-fixes,
  dashboards and other languages are unsupported.
- Execution defaults to disabled. Missing runtime, unpinned/mismatched image,
  invalid approval or unresolved cleanup prevents new execution. No host fallback.
- Containers share the Linux VM kernel. Actual macOS network/resource/cleanup
  tests remain a release gate; command flags are not proof of isolation.
- Model-off is implemented; no model weights/runtime or hosted service is required.
- Root dependencies are pinned directly but installation/lockfile generation was
  deliberately deferred. The recipient must review the resulting lockfile and
  image dependency inventory before release.

## Documentation and licenses

[Recipient setup and remaining-work guide](SETUP.md) · [API](docs/api.md) · [Architecture](docs/architecture.md)
· [Security](docs/security.md) · [Verification](docs/verification.md)
· [Decisions](docs/decisions/README.md) · [Changelog](CHANGELOG.md) · [Presentation Slides](https://www.canva.com/design/DAHY-DVr8Dg/7R3uNcBBtWherj9VesIkCQ/edit?ui=e30)

Application code: [MIT](LICENSE). Declared core packages: Express 5.3.0, Zod 4.6.7,
BullMQ 6.4.2 and pg 8.23.1 (MIT). PostgreSQL uses the PostgreSQL License. The image
definition uses Python 3.14 (PSF) and Pytest 9.0.3 (MIT). No model weights or service
binaries are shipped. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
