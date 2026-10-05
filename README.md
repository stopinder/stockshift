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

The production foundation and local deterministic Python CSV engine are implemented.
The existing private CSV MVP is not present. The web app remains a setup page and
the Python CLI remains a no-op queue scaffold. The local engine parses explicitly
configured CSV files, validates v1 products/evidence, reconciles exact SKUs, and
exports approved changed products. There are no web uploads/comparisons, connected
services, database migrations, billing, XLSX/PDF parsers, or OCR models yet.
See [the local CSV engine guide](services/worker/README.md) for the callable API,
numeric/review rules, fixture example, and limitations.

## Workspace and ownership

- `apps/web`: Vue 3 + Vite + TypeScript + Tailwind shell, built for Vercel.
- `packages/contracts`: canonical v1 JSON Schemas, generated TypeScript types and runtime validation.
- `services/worker`: installable Python worker scaffold, offline contract validation and `DocumentExtractor` protocol.
- `tests/fixtures/contracts`: synthetic boundary fixtures shared by both language test suites.
- `.github/workflows/ci.yml`: locked installs, schema drift, typechecks, tests, builds and CPU image smoke check.

Python will own parsing, normalization, matching, decimal calculations and export generation.
The browser will display results; Vercel will authorize and orchestrate work. See
[the architecture assessment](docs/ARCHITECTURE_ASSESSMENT.md) and
[contract maintenance instructions](packages/contracts/README.md).

## Local setup

Use Node `22.21.0` (see `.nvmrc`), npm `10.9.4`, Python `3.11.3` and uv `0.12.23`.
Dependencies are pinned in manifests and both lockfiles. No credentials, database,
GPU or environment variables are required. `.env.example` lists reserved future names;
never put a server key in a `VITE_` variable.

From the repository root:

```sh
npm ci
npm run check
npm run dev
```

The shell runs at `http://127.0.0.1:5173`. Production preview:

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

The CLI prints its scaffold status and exits; it does not start a queue consumer.
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
No API endpoint or live deployment exists in this commit. A preview deployment will
verify platform routing/workspace behavior when deployment is authorized later.

With Docker available, from the repository root:

```sh
docker build -t stockshift-worker:local services/worker
docker run --rm stockshift-worker:local
```

The CPU image installs locked runtime dependencies, includes packaged schemas and runs
as a non-root user. It has no processing provider or network connection in its entrypoint.
The current Docker command exits after the no-op smoke message; it is not a running service.

## Current implementation increment

`feat: add deterministic CSV reconciliation engine`

The local Python engine and domain tests are implemented. The shared 100-outcome
CSV corpus covers 50 unchanged, 15 increases, 10 decreases, 10 new, 8 absent,
5 description-only changes and 2 review outcomes. Run `uv run --locked pytest`
from `services/worker` to check both contract parity and domain behavior.
The web shell continues to describe its own pending upload/comparison workflow.

The next increment in the architecture sequence is tenant/schema/private-storage
foundations with isolation tests, followed by durable job execution. It has not
been started. No cloud provisioning or deployment is part of this CSV commit.
