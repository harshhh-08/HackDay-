# ADR-0002 — MIT application license

- Date: 2026-10-25 local.
- Status: Accepted; [LICENSE](../../LICENSE) applies to project-authored material.

Choose MIT for straightforward reuse/contribution by open-source maintainers and
a small team. Apache-2.0 was considered for its explicit patent grant; MIT is
smaller and compatible with the currently adopted permissive dependencies.
The choice does not relicense upstream components or model weights.

The initial direct package dependencies, BullMQ 6.4.2 and pg 8.23.1, were
checked against their installed MIT license files. PostgreSQL is an external
development prerequisite with its own permissive license. Record versions,
sources and notices in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
Keep required upstream licenses/notices when distributing dependencies or images.

The generation pass also declares Express, Zod and development/image dependencies;
their versions and verification scope are in the updated notices. The runner
image definition exists but no image was built/distributed. No model is selected;
an open-source runtime does not make model weights open source.
