# Milestone 0 — discovery record

**Historical initial audit.** Source was subsequently generated at the user's
request without new installations; README and `docs/verification.md` describe
current status. Initial findings/experiment results below are preserved.

Session date: **2026-10-25 local**. Command clock at first inspection:
**2026-10-24T20:41:36Z**. Research and experiments below were performed during
this session; UTC/local dates refer to the same session.

## Initial working tree

- `/Users/amityadav/Bug.out` was empty, including hidden entries.
- `git status --short --branch` failed: not a Git repository. There is no current
  branch, commit, existing work, deterministic fixture, or existing test suite.
- No applicable `AGENTS.md` was found in the workspace or its ancestors.
- No prior agent implementation was assumed. No Git commit was created.

## Prerequisites actually checked

| Check | Observed result |
| --- | --- |
| `uname -m` | `arm64` |
| `sw_vers` | macOS 27.0, build 26A428 |
| `sysctl -n hw.memsize` | 17179869184 bytes (16 GiB) |
| `git --version` | 2.54.0 (Apple Git-157) |
| `node --version`, `npm --version` | 24.18.0, 11.16.0 |
| `python3 --version`, `uv --version` | 3.14.7, 0.11.28 |
| `psql --version`, `postgres --version` | PostgreSQL 16.15 (Homebrew) |
| `command -v initdb pg_ctl` | Both available under `/opt/homebrew/bin` |
| `brew --version`, `brew services list` | 6.0.22; `postgresql@16` status `none` |
| `pg_isready` | `/tmp:5432 - no response` (exit 2) |
| Podman, Docker, redis-server, valkey-server, Ollama PATH probes | Unavailable on `PATH`; no claim about all possible installations |
| `vm_stat` | Host memory counters collected; not an application resource benchmark |

The attempted `pg_isready && psql ...` sequence stopped at `pg_isready`; the
`psql` server-version query **did not execute**. PostgreSQL was subsequently
started only as a fresh temporary probe cluster. No existing database was used.

## Research and experiments actually run

- `npm view bullmq version license engines dist.integrity repository --json`
  and equivalent `@trigger.dev/sdk` query: latest returned versions were **6.4.2**
  and **4.8.1**, respectively. Exact-version dependency/source metadata was also
  queried, and `pg` resolved to **8.23.1**.
- Primary license files, Trigger self-hosting deployment files, and relevant
  workflow docs were fetched. Source links are in
  [ADR-0001](decisions/0001-orchestration.md).
- Installed probe dependencies with
  `npm install --ignore-scripts --no-audit --no-fund`.
- Ran `npm run check` and `SPIKE_TMPDIR=<approved temporary parent> npm test`:
  initial probe passed at `2026-10-24T20:44:45.869Z` (3565 ms).
- Strengthened the no-retry assertions for timeout/cancellation and made database
  restart cleanup handles explicit. Reinstalled from the lockfile using
  `npm ci --ignore-scripts --no-audit --no-fund`, then reran both checks.
  Final verified run began **2026-10-24T20:45:25.491Z**, passed in **3411 ms**.
- `npm audit --omit=dev`: **0 vulnerabilities reported** by the registry at check
  time. This is not a guarantee of dependency security.
- After the initial run, `pg_isready -h 127.0.0.1 -p 55439` returned no response.
  Its chained `pg_ctl status` command was not executed because readiness exited 2.
- After the final run, the same explicit-port readiness check again returned no
  response; a filesystem search found no remaining owned `bugout-spike-*`
  temporary directories. The saved evidence JSON passed `python3 -m json.tool`.
- Reviewed new source with `git diff --no-index /dev/null <file>` because no Git
  baseline exists. Local documentation links were reviewed against the files
  present. No product lint/typecheck/build suite exists to run at this boundary.

The [saved experiment record](evidence/orchestration-2026-10-24.json) contains
the final run's checks and measured resource samples. The direct installed
BullMQ and pg license files were read; both are MIT. No Trigger stack was run,
no container isolation was tested, and no product acceptance tests exist yet.

## Milestone exit gate

| Item | Status |
| --- | --- |
| Inspect real repository and machine | Complete |
| Define one demo and its expected signal | Proposed contract saved in [demo.md](demo.md) |
| Revalidate existing fixture | Not applicable: none existed |
| Create and execute deterministic fixture | Pending; requires restricted runner prerequisites |
| Compare orchestration; select one with evidence | BullMQ/PostgreSQL selected, bounded probe passed; limitations recorded |
| Freeze shared API/runner contract | Pending M1-CONTRACT; no production schema exists |
| Podman feasibility on this Mac | Blocked: executable/runtime unavailable |

**Milestone 0 is not fully complete.** This change stops at discovery,
orchestration feasibility, and task planning. Next: **M0-RUNTIME** and
**M0-FIXTURE**, followed by repository/contract foundation. Human team-member
assignment and demo acceptance are still to be confirmed; workstream letters
are proposed ownership roles, not claims that people have accepted tickets.
