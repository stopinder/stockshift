# StockShift

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

The local browser CSV/XLSX workflow is implemented: authenticated workspace, supplier and
comparison creation, private uploads, background processing, persistent results,
review exclusions and changed-products export. The Python CLI polls durable jobs;
the browser never performs matching or decimal arithmetic. Unsupported review matches
cannot be approved: owners/editors explicitly reject or confirm no-match to exclude
them, with an immutable decision history. Export stays blocked until review is complete.
The existing private CSV MVP is not present. There are no connected hosted backends,
billing, PDF parsers, fuzzy matching or OCR models yet.
See [the complete local browser workflow](docs/LOCAL_CSV_WORKFLOW.md) for startup,
sample files, import settings, review rules and browser verification.
See [the local CSV engine guide](services/worker/README.md) for the callable API,
numeric/review rules, fixture example, and limitations.
See [the local Supabase guide](supabase/README.md) for migration/security checks,
server upload lifecycle, local-only safety rules and real local stack checks.

## Workspace and ownership

- `apps/web`: Vue 3 + Vite + TypeScript + Tailwind authenticated CSV/XLSX workflow, built for Vercel.
- `packages/contracts`: canonical v1 JSON Schemas, generated TypeScript types and runtime validation.
- `services/worker`: installable local CSV/XLSX job worker, offline contract validation and `DocumentExtractor` protocol.
- `tests/fixtures/contracts`: synthetic boundary fixtures shared by both language test suites.
- `apps/web/server` and `api`: local-only authenticated upload intent/finalization, Python XLSX inspection and trusted CSV export.
- `supabase`: local configuration, thirteen-table schema and native PostgreSQL RLS/job/review/security tests.
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
uv run --locked stockshift-worker
uv run --locked python -c "from stockshift_worker.extraction.base import DocumentExtractor"
uv build --no-sources
```

The default CLI prints readiness and exits. Use `stockshift-worker --once` or
`--poll` with local-only configuration to process durable jobs; see the worker guide.
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
The web shell is deployed; the upload endpoint and CSV worker remain restricted
to the local Supabase API. This increment performs no hosted operations.

With Docker available, from the repository root:

```sh
docker build -t stockshift-worker:local services/worker
docker run --rm stockshift-worker:local
```

The CPU image installs locked runtime dependencies, includes packaged schemas and runs
as a non-root user. Its default entrypoint exits after a credential-free smoke message.
The local worker runs on the host; the container smoke check does not connect to Supabase.

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
accessed without separate approval. There is no persistent review UI yet.
