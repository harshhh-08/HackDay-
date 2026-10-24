# Third-party notices

Inventory updated during 2026-10-25 local / 2026-10-24 UTC. Project-authored
material is [MIT](LICENSE). Distinguish installed spike dependencies from declared
application/image dependencies; no new packages were installed during generation.

## Declared application and build dependencies

| Component | Version | License evidence / status |
| --- | --- | --- |
| Express | 5.3.0 | npm metadata: MIT; not installed in root |
| Zod | 4.6.7 | npm metadata: MIT; not installed in root |
| BullMQ | 6.4.2 | MIT; installed license verified in earlier spike |
| pg | 8.23.1 | MIT; installed license verified in earlier spike |
| TypeScript | 7.0.2 | npm metadata: Apache-2.0; compiler not installed/run |
| @types/express | 5.0.6 | DefinitelyTyped MIT; declared only |
| @types/node | 24.19.2 | npm metadata: MIT; declared only |
| @types/pg | 8.23.1 | DefinitelyTyped MIT; declared only |
| Pytest | 9.0.3 | [PyPI version metadata](https://pypi.org/pypi/pytest/9.0.3/json): MIT, Python >=3.10 including 3.14 classifier; image not built |
| Python base image | 3.14-slim, digest resolved by recipient | Python PSF plus base OS licenses; image inventory pending |
| PostgreSQL image/service | 16.15 | PostgreSQL License plus image OS notices; image not pulled |

Pytest 9.0.2 was considered but its PyPI metadata reported CVE-2025-71176 fixed
in 9.0.3. The image definition pins 9.0.3; retrieved metadata listed no
vulnerabilities for it. This is metadata evidence, not an image security audit.

CI references GitHub's checkout/setup-node/setup-python actions; no action source
is vendored. Before distributing bundles/images, audit installed transitive
dependencies and retain upstream license/NOTICE files. The root lockfile and
container dependency lock are not yet generated. No model weights, fonts,
credentials or container binaries are included in the ZIP.

## Direct dependencies of the experimental probe

| Component | Exact version | License | Verification/source |
| --- | --- | --- | --- |
| BullMQ | 6.4.2 | MIT | Installed `node_modules/bullmq/LICENSE`; [source](https://github.com/taskforcesh/bullmq/blob/f42514c3d716dc81c2bbc65b883c9dc545fcb56d/LICENSE) |
| node-postgres (`pg`) | 8.23.1 | MIT | Installed `node_modules/pg/LICENSE`; [upstream](https://github.com/brianc/node-postgres/blob/master/LICENSE) |
| PostgreSQL (external development service) | 16.15 Homebrew | PostgreSQL License | [Official license](https://www.postgresql.org/about/licence/); not redistributed here |

The [probe lockfile](spikes/orchestration/package-lock.json) pins package artifacts
and integrity hashes. Transitive/optional package license metadata includes MIT,
ISC, Apache-2.0, and 0BSD. That metadata is not a complete source-file or container
license audit. Preserve upstream package licenses/notices if distributing their
contents; revisit this inventory whenever dependencies change. `node_modules`
and service binaries are not project source artifacts.

Node.js 24.18.0/npm 11.16.0 and PostgreSQL tools were preinstalled development
tools. Python/uv were inspected but not used for application execution. No
container image, model runtime, model weights, fonts, or UI assets are shipped.
Trigger.dev was evaluated but not adopted or installed.

## MIT notices for adopted direct npm packages

**BullMQ:** Copyright (c) 2018 BullForce Labs AB and contributors.

**node-postgres:** Copyright (c) 2010 - 2021 Brian Carlson.

The following MIT terms accompany each of these copyright notices:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
