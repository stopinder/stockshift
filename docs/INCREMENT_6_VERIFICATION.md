# Increment 6 verification

Baseline: `333faf59a4c1ab4b9ff5dae276d0a50964aada4a`, main, clean before implementation.
Checkout: `C:/Users/Rob/WebstormProjects/stockshift`.
No hosted Supabase project, hosted credentials, linking, remote migration or Git push.

## Implementation

Direct bounded OOXML parsing uses Python zipfile, `defusedxml==0.7.1` and Decimal.
Stored numeric tokens bypass binary floats; strings and simple numeric zero-mask
identifiers preserve recoverable leading zeros. `openpyxl==3.1.5` is a development-only
fixture writer. CSV and XLSX call the same normalized record builder, reconciliation
engine, fenced job lifecycle, publication, review and changed-products CSV export.

Explicit import settings extend the existing snapshotted JSON model with `format`,
`worksheet`, `header_row` and optional currency/pack/UOM columns. Mapped blanks remain
null. Mapped fields need no invented file-wide defaults. Text numeric conventions
remain explicit; numeric XML values retain their stored precision. Invalid textual/
negative prices and missing required values go to review, never zero. Formulas,
dates, error/boolean cells and ambiguous numeric identifiers stop processing without
partial publication and retain safe structured failure messages.

Server upload finalization calls the installed local Python module over private stdin.
Authenticated worksheet discovery downloads only authorized ready same-tenant sources,
checks SHA/bytes and returns names, visibility, headers and at most five sample rows.
The browser does not parse the workbook. Worksheet/header/column selection, preview,
draft re-entry and the existing result/review/export screen work together. Provenance
includes source file, sheet, physical row, column/header and original raw value;
worksheet identity participates in deterministic record/evidence IDs. CSV IDs and
physical line locators remain unchanged.

Migration `20261005184752_xlsx_ingestion.sql` broadens verified source extension/MIME
constraints, the private bucket allowlist and tenant-validated enqueue/load gates.
No new table or browser mutation grants; all thirteen tables, RLS, tenant foreign
keys, leases and completion idempotency remain in effect. Existing CSV RPC names
remain stable for compatibility.

## Verification

| Check | Result |
| --- | --- |
| Fresh Docker-backed local reset | All four migrations applied |
| Foundation native SQL/RLS | 32 passed |
| Durable job native SQL/RLS | 20 passed |
| Review/export native SQL/RLS | 16 passed |
| Real Auth/Storage/Python/export/XLSX integration | 25 passed |
| Web JS/TS | 57 passed |
| Shared contracts JS/TS | 54 passed |
| Python contracts/CSV/worker/XLSX | 182 passed (39 XLSX) |
| Chromium: seven cases at three widths | 21 passed |
| Local database lint | No schema errors |
| Clean npm ci | Passed, zero vulnerabilities |
| Contract generation drift, typechecks, production build | Passed |
| Prettier, Ruff lint/format, patch whitespace | Passed |
| Source/wheel build and isolated installed-wheel imports/CLI | Passed |
| Locked CPU worker image build and packaged parser smoke | Passed |

Native verification uses local Docker Supabase/PostgreSQL, never PGlite as a substitute.
The 32 supplementary embedded baseline checks also passed and duplicate the native
foundation coverage; they are not counted as extra native tests. Integration covers
mixed formats, real private uploads/finalization, metadata tenant denial, explicit
mapping gates, decimal precision/identifiers/provenance, audited exclusion/export,
idempotent publication, formula failures without partial results, and corrupt/OLE
container rejection.

Browser coverage includes the original five CSV cases plus successful XLSX flow and
corrupt-upload retry/empty-sheet/formula error flow at desktop 1440×1000, tablet
820×1100 and mobile 390×844. Successful flows verify upload, explicit sheet/header/
column choice, preview, persisted queue/results, source evidence, two review decisions,
export and reload/re-entry. Screenshots are ignored under `.tools/*-xlsx-*.png`.
Responsive checks assert no page-level horizontal overflow. Preview/table panels
scroll deliberately. Explicit accessible labels were added to worksheet/mapping
selectors; mapped default controls are disabled to clarify which values are used.

## Limits

Ordinary unencrypted XLSX only; no formula calculation/cached-formula acceptance,
macros/templates/external links, merged layouts or hidden-sheet import. UTF-8 CSV
behavior and CSV export are unchanged. Numeric identifiers already damaged by Excel
cannot be reconstructed; store them as text. Supported limits and mapping assumptions
are documented in `LOCAL_CSV_WORKFLOW.md#xlsx-workbooks`. Preview and finalization
require the installed local Python environment; no hosted worker/API deployment.
Review remains explicit exclusion only. No PDF/OCR, fuzzy matching, margins, billing,
XLSX export or customer-specific export mappings were added.

## Complete changed-file inventory

- `README.md`
- `apps/web/api/workbook.ts`
- `apps/web/e2e/workflow.spec.ts`
- `apps/web/server/uploads.ts`
- `apps/web/server/workbook.ts`
- `apps/web/src/components/ComparisonDetail.vue`
- `apps/web/src/components/CsvSettings.vue`
- `apps/web/src/components/XlsxSettings.vue`
- `apps/web/src/styles/main.css`
- `apps/web/src/workflow.ts`
- `apps/web/tests/workbook-endpoint.test.ts`
- `apps/web/tests/workflow.test.ts`
- `apps/web/vite.config.ts`
- `docs/ARCHITECTURE_ASSESSMENT.md`
- `docs/INCREMENT_6_VERIFICATION.md`
- `docs/LOCAL_CSV_WORKFLOW.md`
- `package.json`
- `services/worker/README.md`
- `services/worker/pyproject.toml`
- `services/worker/src/stockshift_worker/domain/csv_engine.py`
- `services/worker/src/stockshift_worker/domain/xlsx.py`
- `services/worker/src/stockshift_worker/entrypoints/workbook.py`
- `services/worker/src/stockshift_worker/jobs/runner.py`
- `services/worker/tests/test_xlsx.py`
- `services/worker/tests/workbook_fixture.py`
- `services/worker/uv.lock`
- `supabase/README.md`
- `supabase/migrations/20261005184752_xlsx_ingestion.sql`
- `supabase/tests/upload.local.ts`
