# bug.out — setup and remaining-work guide

**For the person receiving `bugout-source.zip` and uploading the project to GitHub.**

Extract the ZIP, open the folder containing `package.json` in VS Code, and run
the commands below from that folder. This guide targets **macOS / Apple Silicon**;
Linux uses the same application commands with native rootless Podman instead of
the macOS VM. Windows setup is not verified.

The code is a development implementation. The installation and full-stack steps
below still need to succeed on your machine; writing this guide did not run them.
If a check fails, fix the reported issue and rerun that check before proceeding.

## What is already checked, and what remains?

Already passed: **10 Node tests, 39 Python tests, 11 real PostgreSQL/BullMQ
scenarios, and a seven-report deterministic triage benchmark**. Some Python tests
use real local HTTP, but their execution transport is simulated.

Your remaining work is:

1. Install the declared dependencies and review the resulting lockfile/audit.
2. Run the TypeScript typecheck and generate OpenAPI.
3. Configure PostgreSQL and apply the application/queue migrations.
4. Build the pinned fixture image and verify actual Podman restrictions.
5. Run the four services and the real API/fixture acceptance tests.
6. Exercise timeout/recovery cases and rehearse the CLI demo twice.
7. Publish the source, dependency lockfile and accurate verification notes.

The demo uses **model-off deterministic analysis**. It needs no AI API key,
Ollama, Redis, Valkey, or Trigger.dev account. See
[docs/verification.md](docs/verification.md) for the exact current evidence.

---

## 1. Install/check the tools

Required: **Node.js 24**, npm, **Python 3.11+** (3.14 recommended), and Podman.
Use the tools you already have if their versions meet these requirements.

On macOS with [Homebrew](https://brew.sh/), install missing tools:

```sh
brew install node@24 python@3.14 podman
export PATH="$(brew --prefix node@24)/bin:$(brew --prefix python@3.14)/libexec/bin:$PATH"

node --version
npm --version
python3 --version
podman --version
```

Ensure new terminals also use Node 24 and the intended Python interpreter. If
needed, add the PATH setting to your shell profile. On Linux, install the same
version requirements and configure rootless Podman through your distribution.

**Done when:** `node --version` reports `v24.x`, Python is at least 3.11, and
`podman --version` works. A working Podman CLI alone does not prove its VM works.

## 2. Install project dependencies and create local configuration

The source ZIP has no root dependency lockfile yet. For this first installation:

```sh
npm install --ignore-scripts
npm ls --depth=0
npm run configure
mkdir -p .local/verification
set -o pipefail
```

`configure` creates a private `.env` with generated tokens and a database password.
It refuses to overwrite an existing `.env`. If one already exists, keep/review it
instead of rerunning configuration. Do not regenerate credentials for an existing
database volume without an intentional credential migration.

Keep these values for the local demo:

```dotenv
API_HOST=127.0.0.1
API_PORT=8787
BUGOUT_API_URL=http://127.0.0.1:8787
MODEL_PROVIDER=disabled
RUNNER_ENABLED=false
WAIT_SECONDS=86400
TOTAL_SECONDS=172800
RETENTION_DAYS=7
```

Leave the generated secret values intact. Set `RUNNER_IMAGE` later, after building
the image. The Python services use the standard library; do not install Pytest
on the host to run the bug fixture. Its dependency belongs inside the image.

**Done when:** `npm ls --depth=0` reports no unmet dependencies, a root
`package-lock.json` exists, and `.env` contains generated values rather than
`GENERATE_ME`. Review and commit the lockfile later; subsequent clean installs
should use `npm ci --ignore-scripts`.

## 3. Complete the code and contract checks

```sh
set -o pipefail
npm run typecheck 2>&1 | tee .local/verification/typecheck.log
npm run openapi 2>&1 | tee .local/verification/openapi.log
npm run check
npm run check:python
npm test
npm run test:python
npm run benchmark:triage
npm audit 2>&1 | tee .local/verification/npm-audit.log
```

**Done when:** typechecking exits successfully, `docs/openapi.json` is generated,
source/unit/HTTP checks pass, and the benchmark reports all seven cases correct
with zero unsupported facts. Review audit findings and resolved dependency
licenses; update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) as needed.

TypeScript and OpenAPI generation were previously blocked by missing packages,
so they may reveal work to fix. Do not treat syntax checks as a substitute for
typechecking. If npm cannot resolve a pinned package, verify the registry/version
and make an intentional pin change; do not replace every dependency with `latest`.

## 4. Start a rootless Podman environment

### macOS

First inspect existing machines and connections:

```sh
podman machine list
podman system connection list
```

For a new dedicated machine named `bugout`:

```sh
podman machine init --rootful=false --cpus 2 --memory 3072 --disk-size 12 bugout
podman machine start --update-connection=false bugout
podman system connection list
```

Run `init` only once, and skip `start` if that machine is already running. The
3 GiB RAM / 2 CPU / 12 GiB disk allocation is a starting configuration for this
small fixture, not a measured full-product requirement. Preserve other machines.

Choose the generated **rootless** connection shown in the list, normally `bugout`,
not `bugout-root`. Add this line to your local `.env`, using its actual name:

```dotenv
CONTAINER_CONNECTION=bugout
```

This makes the CLI and runner use the same connection without changing another
project's global default. The application's environment loader supports this key.

### Linux

Use native rootless Podman with functioning cgroup-v2 resource controls. Skip the
machine commands and omit `CONTAINER_CONNECTION` unless deliberately using a
remote connection. This guide does not certify a particular Linux distribution.

### Check the selected environment

Load the generated local configuration in the setup terminal:

```sh
set -a
source .env
set +a
podman info --format '{{.Host.Security.Rootless}}'
podman info > .local/verification/podman-info.txt
```

**Done when:** the rootless check prints `true` and Podman can reach the selected
machine. Keep all image builds, database operations and runner processes on this
same connection. Podman option references: [machine init](https://docs.podman.io/en/latest/markdown/podman-machine-init.1.html)
and [connection environment variables](https://docs.podman.io/en/latest/markdown/podman.1.html#environment-variables).

## 5. Create PostgreSQL and apply migrations

Use the declared PostgreSQL version and record the resolved image digest:

```sh
podman pull docker.io/library/postgres:16.15
POSTGRES_IMAGE=$(podman image inspect --format '{{index .RepoDigests 0}}' docker.io/library/postgres:16.15)
podman image inspect "$POSTGRES_IMAGE" > .local/verification/postgres-image.json

podman run -d --name bugout-postgres \
  -p 127.0.0.1:5432:5432 \
  --env POSTGRES_USER=bugout --env POSTGRES_DB=bugout --env POSTGRES_PASSWORD \
  -v bugout-postgres:/var/lib/postgresql/data \
  "$POSTGRES_IMAGE"

podman exec bugout-postgres pg_isready -U bugout -d bugout
```

Repeat the readiness command until it reports accepting connections. For an
already-created project container, use `podman start bugout-postgres` instead of
creating it again. Do not remove an unrelated container or volume to resolve a
name/port conflict. If port 5432 is occupied, choose a free published host port
and update the port in `.env`'s `DATABASE_URL` to match.

```sh
npm run db:migrate 2>&1 | tee .local/verification/migrations.log
```

**Done when:** migration exits successfully and reports application and BullMQ
migrations applied. Both use PostgreSQL; there is no Redis service to start.
The current DB role is for local development, not an exposed production service.

Optional separate regression check: `npm run test:database` requires native
`initdb`, `pg_ctl`, and `postgres` binaries on the host as well as the npm packages.
It creates/removes a private temporary cluster and ignores `DATABASE_URL`.
Having PostgreSQL only inside Podman does not supply those host binaries.

## 6. Build the exact fixture image

```sh
podman pull docker.io/library/python:3.14-slim
PYTHON_BASE=$(podman image inspect --format '{{index .RepoDigests 0}}' docker.io/library/python:3.14-slim)
FIXTURE_SHA256=$(python3 scripts/fixture_hash.py)

podman build \
  --build-arg PYTHON_BASE="$PYTHON_BASE" \
  --build-arg FIXTURE_SHA256="$FIXTURE_SHA256" \
  -f services/runner/Containerfile -t bugout-runner:local .

podman image inspect --format '{{.Id}}' bugout-runner:local
podman image inspect bugout-runner:local > .local/verification/runner-image.json
```

Copy the complete returned immutable image ID into `.env`:

```dotenv
RUNNER_IMAGE=sha256:REPLACE_WITH_THE_REAL_IMAGE_ID
RUNNER_ENABLED=false
```

Do not copy that placeholder literally. The runner rejects mutable tags and
fixture/image mismatches. The image installs Pytest 9.0.3 during the build;
actual test containers have no network. Record the image/dependency inventory
and resolve any license or dependency-locking work before release.

Reload `.env` after editing it. Already-exported environment values override the
file in Node and Python, so use fresh service terminals or reload explicitly.

## 7. Verify the real runner before enabling application execution

```sh
set -a
source .env
set +a
set -o pipefail
npm run verify:runner 2>&1 | tee .local/verification/runner-checks.log
```

This runs seven fixed, trusted diagnostic workloads in the pinned image, even
while application execution is disabled. Tests intentionally exercise process,
memory and disk limits, plus network/mount restrictions, output capture, timeout
and cancellation. The timeout diagnostic uses an accelerated two-second limit.

**Done when:** the command exits 0 and reports `"status": "passed"` with all
seven probes. `blocked`, nonzero exit, or a failed assertion is not success.
Do not remove a restriction or run the fixture on the host to bypass a failure.

After success, set `RUNNER_ENABLED=true` in `.env`. Rebuild after changes to the
fixture, `services/runner/harness.py`, Containerfile or image dependencies, and use
a new investigation so approval binds the new snapshot/image.
See [docs/security.md](docs/security.md) for the local-fixture trust boundary.

## 8. Start the four application processes

Open four fresh terminals at the project root. Run **one command per terminal**:

| Terminal | Command | Service |
| --- | --- | --- |
| 1 | `npm run engine` | Deterministic Python engine, port 8788 |
| 2 | `npm run runner` | Restricted runner, port 8789 |
| 3 | `npm run api` | Express API, port 8787 |
| 4 | `npm run orchestrator` | BullMQ phase worker/outbox dispatcher |

The scripts load `.env`. Keep the terminals open, and verify:

```sh
curl --fail-with-body http://127.0.0.1:8787/health
curl --fail-with-body http://127.0.0.1:8787/ready
```

**Done when:** health succeeds and readiness returns `ready: true` with database,
engine and runner all true. Confirm the orchestrator terminal also says its phase
worker started: `/ready` does not prove that an orchestration worker is consuming
jobs. Readiness also does not replace the runner diagnostics from step 7.

## 9. Run the previously blocked acceptance checks

In a fifth terminal at the root:

```sh
set -o pipefail
npm run test:acceptance -- --control-plane-only 2>&1 | tee .local/verification/control-plane.log
npm run test:integration 2>&1 | tee .local/verification/smoke.log
npm run test:acceptance 2>&1 | tee .local/verification/acceptance.log
```

The first command covers auth, validation, redaction, idempotency, questions,
cancellation and unsupported targets without fixture execution. It can also run
with the runner unavailable, provided API/engine/orchestrator/DB are operational.

The last two commands **automatically approve only the registered fixture** using
the configured maintainer token. Full acceptance checks the matching failure,
three passing control runs, approval replay/hash rejection, artifacts, reports,
rejection and terminal deletion.

**Done when:** each command exits 0 and its final result says passed. A passing
intentional failure means outcome `reproduced`, not that Pytest itself passed.
Save the reported investigation/run IDs with your verification notes.

### Reporter timeout

Stop only the API in terminal 3, then restart it with a short test wait:

```sh
WAIT_SECONDS=5 npm run api
```

From the test terminal:

```sh
npm run test:acceptance -- --control-plane-only --expect-fast-waits
```

**Done when:** the expired round closes and the investigation saves a blocked
report. Then restart the API normally with `npm run api` for the live demo;
new investigations should use the normal wait duration.

## 10. Finish the reliability checks

These are remaining manual/fault-injection tasks; the smoke script does not
automatically perform all of them. Use fresh test investigations and record the
actual phase/IDs before interruption.

| Scenario | What to verify |
| --- | --- |
| Restart while awaiting a reporter | Same investigation and round persist; reply still resumes it. |
| Interrupt an orchestrator during a real run | Restart it; reuse the recorded run ID rather than launch a duplicate. A terminal failure must explain uncertainty. |
| Interrupt/restart the runner during a run | Owned workload is bounded/cleaned up; uncertain execution is not silently rerun. Inspect actual container state, not just API status. |
| Restart `bugout-postgres` | Saved state/reports remain consistent; services recover or explicitly fail within their configured budgets. |
| Cancel an active run | Cleanup completes, or status explicitly becomes failed/unconfirmed within the acknowledgement budget. |
| Stop/restart the dedicated VM | Inspect recovery and cleanup of both DB/runtime state; no permanently hidden/stuck job or duplicated execution. |

For DB restart use `podman restart bugout-postgres`. For worker/runner crash tests,
identify and interrupt only the exact process you launched for this project.
The fixture can finish quickly: if the interruption missed the active run, do not
count it as a mid-run test. A repeatable pause/failure-injection harness may need
to be added for those remaining windows. Do not use blanket process/container kills.

Inspect owned workloads with:

```sh
podman ps -a --filter label=org.bugout.run
```

A `cleanup_status` of `unconfirmed` is not proof that a workload stopped. Keep
its evidence/journal until cleanup is inspected. VM/worker failures must be
reported honestly; they need not produce a successful reproduction.

## 11. Rehearse the human-facing demo twice

```sh
npm run cli -- submit --title "Checkout total is wrong" --description "Checkout sometimes gives the wrong total."
```

Use the returned ID:

```sh
INVESTIGATION_ID="PASTE_THE_RETURNED_UUID"
npm run cli -- watch "$INVESTIGATION_ID"
npm run cli -- answer "$INVESTIGATION_ID" --target tests/test_checkout.py::test_percentage_discount
npm run cli -- watch "$INVESTIGATION_ID"
npm run cli -- approve "$INVESTIGATION_ID"
npm run cli -- watch "$INVESTIGATION_ID"
npm run cli -- report "$INVESTIGATION_ID"
npm run cli -- report "$INVESTIGATION_ID" --markdown
```

Approval displays the exact plan and requires typing its full hash. Verify the
report cites an actual run with command, snapshot/revision, environment, exit code,
timings and artifacts. The intended result is `reproduced` only when the selected
assertion genuinely fails with the expected signal. A ZIP checkout may correctly
report `commit_sha: null` and an actual snapshot SHA-256 instead.

Use a **new investigation** for the second rehearsal. The passing control target
is `tests/test_checkout.py::test_no_discount`; automated acceptance already tests
it. Preserve evidence from successful rehearsals and label any recorded backup
as a recording rather than live execution.

## 12. Publish and hand back verification evidence

- Update [docs/verification.md](docs/verification.md) with commands actually run,
  machine/runtime/package versions, results and unresolved failures.
- Review the generated root `package-lock.json`, `docs/openapi.json`, and dependency/
  image notices. Include the source, license, ignore rules, lockfile and API spec
  in the GitHub repository. Git initialization/upload is done by you, the recipient.
- Keep `.env`, `.local/`, `node_modules/`, caches and generated ZIPs out of Git.
  `.local/verification/` is a private working evidence folder; publish only sanitized
  summaries. The source packager excludes those private/generated paths.
- From a fresh clone, use `npm ci --ignore-scripts`, create local configuration,
  and repeat the setup/demo checks. Do not call clean-checkout setup verified until
  that fresh-clone exercise succeeds.
- Rebuild the WhatsApp source package with `npm run package:source`.

### Completion checklist

- [ ] Typecheck passes and OpenAPI is generated.
- [ ] Root dependencies/lockfile and image versions/licenses are reviewed.
- [ ] Fresh DB migrations and all four services start successfully.
- [ ] Seven actual runner probes pass and cleanup is checked.
- [ ] Control-plane, smoke, full acceptance and reporter-expiry tests pass.
- [ ] Recovery/cancellation failure windows have recorded evidence or explicit blockers.
- [ ] Two complete manual demos produce retrievable evidence-backed reports.
- [ ] Fresh-clone setup succeeds and README/verification claims match results.

## Troubleshooting

| Symptom | Check/action |
| --- | --- |
| Unsupported Node version / unknown TypeScript syntax | Ensure each terminal uses Node 24; inspect `node --version` and PATH. |
| `EEXIST` from `configure` | `.env` already exists. Review it; do not overwrite credentials blindly. |
| Package resolution/typecheck failure | Save the exact error, verify pins/registry, fix the code or intentional version mismatch, then rerun. Syntax-only checks are insufficient. |
| Podman cannot connect / rootless check is false | Inspect machine state and `podman system connection list`; confirm `CONTAINER_CONNECTION` selects the rootless connection. |
| DB authentication fails after changing `.env` | Existing volume keeps its original DB password. Restore/migrate the correct credentials; do not assume a new environment password rewrites the volume. |
| Port/name already in use | Identify the existing service rather than deleting unrelated data. Keep `API_PORT` and `BUGOUT_API_URL` in sync; engine/runner ports come from their URLs. Adjust the sample curl URLs if changing API port. |
| `IMAGE_UNAVAILABLE` / `IMAGE_FIXTURE_MISMATCH` | Use the same Podman connection, rebuild with the current fixture hash, and update the actual immutable image ID. |
| Runner still disabled after editing `.env` | Restart its process in a fresh terminal or reload exports; stale environment values take precedence. |
| `/ready` succeeds but a job stays queued | Check the orchestrator process and its DB/queue errors; readiness does not check its consumption loop. |
| Approval says `PLAN_CHANGED` | Review the current plan; use a new investigation after changing fixture/image/revision. Never reuse an old hash. |
| Runtime probe fails or says blocked | Keep that gate incomplete; inspect version/cgroup/runtime support and recorded failure. Do not weaken the runner or use host execution as a workaround. |
| Deletion is refused / cleanup unconfirmed | Inspect owned containers and runner recovery before retrying. Retired/cancelled UUID records intentionally prevent late execution replay. |

When finished, cancel/resolve active investigations, stop the four application
processes, then `podman stop bugout-postgres`. On macOS, stop the dedicated VM with
`podman machine stop bugout` when it is no longer needed. Keep volumes and the
runner journal unless deliberately performing an inspected data deletion.
