# StockShift

Increment 8 adds opt-in PaddleOCR-VL page routing behind the worker's existing
extractor boundary. Digital pages keep direct parsing; OCR rows require source
verification and durable correction before comparison. See
[the local OCR workflow](docs/PADDLEOCR_WORKFLOW.md) for configuration, limits,
private caching, synthetic tests and the unverified real-model boundary.

StockShift is a supplier catalogue reconciliation product.

## Product target

**PDF/XLSX/CSV → robust extraction → product reconciliation → margin impact → human review → customer-specific import file.**

The application should accept current/internal catalogues and new supplier files, normalize product data, reconcile exact and likely matches, calculate price and margin impact, route uncertain records to human review, and export approved changes in a customer-specific CSV/XLSX format.

## Planned production stack

- Vue 3 + Vite + TypeScript
- Tailwind CSS
- Supabase: Postgres, Auth, Storage
- Vercel: frontend and API orchestration
- Python extraction worker/service
- PaddleOCR-VL for scanned/complex PDF extraction
- Stripe for billing

## Product principles

- Deterministic logic for prices, margins, quantities and exact identifiers.
- AI only where it adds value: difficult extraction and fuzzy product matching.
- No silent uncertain matches.
- Preserve source provenance for extracted values.
- CSV/XLSX bypass OCR and use direct parsers.
- Difficult PDFs/scans route through PaddleOCR-VL.
- Customer-specific export profiles are a first-class feature.

## Current status

The local browser CSV/XLSX/digital PDF workflow is implemented: authenticated workspace, supplier and
comparison creation, private uploads, background processing, persistent results,
review exclusions and changed-products export. The Python CLI polls durable jobs;
the browser never performs matching or decimal arithmetic. Unsupported review matches
cannot be approved: owners/editors explicitly reject or confirm no-match to exclude
them, with an immutable decision history. Export stays blocked until review is complete.
The existing private CSV MVP is not present. Hosted Supabase and a compatible hosted
CPU worker remain unconfigured; billing and fuzzy matching are not implemented.
The private OCR serving endpoint is separate and remains paused. Digital PDFs use
direct text/table parsing, immutable evidence and durable correction revisions.
See [the complete local browser workflow](docs/LOCAL_CSV_WORKFLOW.md) for startup,
sample files, import settings, review rules and browser verification.
See [the local CSV engine guide](services/worker/README.md) for the callable API,
numeric/review rules, fixture example, and limitations.
See [the local Supabase guide](supabase/README.md) for migration/security checks,
server upload lifecycle, local-only safety rules and real local stack checks.

## Workspace and ownership

- `apps/web`: Vue 3 + Vite + TypeScript + Tailwind authenticated CSV/XLSX/PDF workflow, built for Vercel.
- `packages/contracts`: canonical v1 JSON Schemas, generated TypeScript types and runtime validation.
- `services/worker`: installable local CSV/XLSX/PDF job worker, offline contract validation and `DocumentExtractor` protocol.
- `tests/fixtures/contracts`: synthetic boundary fixtures shared by both language test suites.
- `apps/web/server` and `api`: authenticated private upload/finalization and trusted CSV export; hosted CPU PDF inspection/extraction are default-off; XLSX inspection remains local.
- `supabase`: local configuration, fifteen-table schema and native PostgreSQL RLS/job/review/security tests.
- `.github/workflows/ci.yml`: locked installs, schema drift, typechecks, JS/database/Python tests, builds and CPU image smoke check.

Python owns parsing, normalization, matching and decimal calculations. The server
serializes approved persisted values as CSV; the browser displays results. See
[the architecture assessment](docs/ARCHITECTURE_ASSESSMENT.md) and
[contract maintenance instructions](packages/contracts/README.md).

## Local setup

Use Node `22.21.0` (see `.nvmrc`), npm `10.9.4`, Python `3.11.3` and uv `0.12.23`.
Dependencies are pinned in manifests and both lockfiles. Unit tests need no
credentials, database service or GPU. The connected app and native integration tests
need Docker and a freshly reset local Supabase stack. Local web/worker launchers
obtain only that stack's generated keys. `.env.example` lists names;
never put a server key in a `VITE_` variable.

From the repository root:

```sh
npm ci
npm run check
npm run supabase:local -- start
npm run seed:local
npm run dev:local
# In a separate terminal, after installing the worker:
npm run worker:local
```

The application runs at `http://127.0.0.1:5173`. Plain `npm run dev` and a production
preview without local public configuration show the connection-required state. Production preview:

```sh
npm run build
npm run preview --workspace @stockshift/web
```

For Python, from `services/worker`:

```sh
uv sync --locked
uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked pytest
uv run --locked stockshift-worker --check
uv run --locked python -c "from stockshift_worker.extraction.base import DocumentExtractor"
uv build --no-sources
```

The default CLI polls durable jobs until SIGTERM/SIGINT. Use `--check` for a
credential-free import smoke, or `--once` to process at most one eligible job.
Local launchers remain loopback-only; explicit hosted mode permits CSV preview
jobs through the HTTPS gateway. See the worker guide.
uv uses `.python-version` and may obtain that interpreter if it is missing. uv itself
is a development tool, not a worker runtime dependency. If it is not installed,
a repository-local bootstrap on Windows is:

```powershell
python -m venv .tools
.\.tools\Scripts\python.exe -m pip install uv==0.12.23
.\.tools\Scripts\uv.exe sync --locked --project services/worker
```

Use that executable instead of `uv` in subsequent commands, or install the pinned uv
tool through your normal development-tool setup. `.tools` and virtual environments
are ignored and must never be committed.

## Contract maintenance

After editing canonical schemas:

```sh
npm run contracts:generate
npm run contracts:check
npm run check
```

Commit generated TypeScript and Python schema copies with their sources. The worker
wheel includes its schema resources and validates offline when installed outside this
repository. TypeScript and Python run the same acceptance corpus without coercion,
default values or confidence invention. JSON Schema validates shape; the runtime
guards additionally check cross-field progress/completeness counts.

## Deployment scaffold

Vercel project root is `apps/web`; `vercel.json` sets the Vite build output and a SPA
fallback that excludes `/api` and `/api/*`. npm resolves the root workspace and lockfile.
The web app manifest repeats the root Node `>=22.12.0 <23` and npm `>=10 <11`
engines so Vercel selects Node 22.x from its project root. Node 22 uses npm 10 on
Vercel; both manifests declare `npm@10.9.4`. Local development and CI use Node
`22.21.0` from `.nvmrc`; `engine-strict=true` continues to reject incompatible tools.
The deployed web shell currently has no workspace configuration. Explicit hosted
browser/API configuration is prepared locally; local launchers and the durable
Python LocalGateway retain their loopback restrictions. Explicit hosted CSV mode
now uses a separate HTTPS gateway and the default durable polling entrypoint.
The compatible preview Supabase project and worker host remain unprovisioned;
PDF processing remains default-off and hosted XLSX is unavailable. See
[the preview readiness and commit/deployment plan](docs/CHUNK_10_PREVIEW_RELEASE.md).
Preparation performs no hosted data operations or deployment.

With Docker available, from the repository root:

```sh
docker build -t stockshift-worker:local services/worker
docker run --rm --network none stockshift-worker:local stockshift-worker --check
```

The CPU image installs locked runtime dependencies, includes packaged schemas and runs
as a non-root user. Its default entrypoint polls until SIGTERM/SIGINT, draining the current job.
Use `stockshift-worker --check` for a credential-free import smoke. Hosted mode is
CSV only until the separately gated CPU PDF capabilities are approved. The browser acceptance suite can run the default container entrypoint
against Docker-backed local Supabase and verify graceful SIGTERM shutdown.

## CSV implementation

`feat: add deterministic CSV reconciliation engine`

The local Python engine and domain tests are implemented. The shared 100-outcome
CSV corpus covers 50 unchanged, 15 increases, 10 decreases, 10 new, 8 absent,
5 description-only changes and 2 review outcomes. Run `uv run --locked pytest`
from `services/worker` to check both contract parity and domain behavior.
The authenticated browser workflow processes these fixtures through local persisted jobs.

## Current implementation increment

`feat: add XLSX ingestion to reconciliation pipeline`

Direct bounded OOXML parsing preserves stored decimal text, explicit sheet/header/column
mappings and worksheet/row/header/raw-value provenance. Both CSV and XLSX use the
same normalization, deterministic engine, durable jobs, review and CSV export.
See [XLSX assumptions and mapping](docs/LOCAL_CSV_WORKFLOW.md#xlsx-workbooks).

Durable processing foundation:

Jobs snapshot explicit CSV settings and ready comparison inputs. Workers claim
leases, renew them, verify source bytes, reconcile, and atomically publish normalized
results and pending review candidates. Lease expiry permits recovery; stale tokens
cannot publish. Enqueue and completion are idempotent, with bounded retries and
inspectable failed/dead-letter jobs. See [the worker lifecycle guide](services/worker/README.md).

Run `npm run test:local` after installing the Python worker and starting/resetting
local Supabase. It runs native SQL security/job tests plus real Auth/Storage/Python
worker integration. CI uses this Docker-backed path. Hosted projects must not be
accessed without separate approval. Persisted review and provenance remain required before export.

## Increment 7: digital PDF ingestion and correction

`feat: add digital PDF ingestion and correction workflow`

Digitally generated PDFs use pdfplumber behind the existing extraction provider
interface and durable queue. Immutable page/cell evidence, append-only correction
revisions, explicit field mapping/confirmation and confirmed revision snapshots feed
the existing normalization, deterministic comparison, review and CSV export. Scans
and unsupported structures retain an actionable OCR-required state; OCR is not yet
implemented. See [digital PDF workflow and limits](docs/LOCAL_CSV_WORKFLOW.md#digital-pdfs-increment-7).
