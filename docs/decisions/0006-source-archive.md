# ADR-0006 — Source archive and no-install generation

- Date: 2026-10-25 local.
- Status: Accepted, following the user's request to generate code for a friend,
  share via WhatsApp, and let the friend publish to GitHub without installing here.

Generate the deterministic local-fixture implementation and recipient setup
instructions. Do not require local Git, install dependencies/runtimes, start
services, or call unrun integrations successful. Use already available Node/Python
for pure logic and syntax checks. Package source only into a ZIP.

An archive cannot supply a genuine commit SHA. Record an observed SHA-256 over
the exact fixture manifest and `commit_sha: null` when no clean revision exists.
Record an actual commit when a clean checkout supplies one. Snapshot identity and
pinned image remain bound to approval. This explicitly qualifies the original
commit-only demo requirement; an archive digest is never labeled a Git commit.

Scope is the authored registered fixture, model-off analysis, exact approved
adapter command and honest evidence. No generalized arbitrary-script execution
or live security validation is implied by source generation.

The recipient installs dependencies and reviews the root lockfile, builds/pins
the image, runs migrations, tests integration and validates runtime controls.
The ZIP excludes dependencies, Git metadata, local data/secrets and caches.
