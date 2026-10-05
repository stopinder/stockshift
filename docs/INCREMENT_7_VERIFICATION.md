# Increment 7 verification

Baseline: `344d098541c3025d2c57ea4d25dfa5f54a63c3ad`, main, clean before implementation.
Checkout: `C:/Users/Rob/WebstormProjects/stockshift`.
No hosted Supabase project/credentials, linking, remote migrations or Git push.

## Implementation

Pinned `pdfplumber==0.11.10` implements the existing validated `DocumentExtractor`
protocol. It reads embedded text and deterministic table cells, preserves raw page,
row, table, column and bounding-box provenance, and never infers business mappings,
joins page-break fragments, runs OCR or assigns confidence scores. PDF cells pass
through the shared CSV/XLSX normalizer and deterministic reconciliation engine.
Exact prices remain decimal strings; blanks remain null and identifiers preserve
embedded leading zeros. Original evidence retains the extracted value after correction.
Text-aligned structures and multiline identifiers/prices remain review items.

Migration `20261005191747_digital_pdf_corrections.sql` adds `extraction_runs` and
append-only `correction_revisions`, tenant/source-aware foreign keys, RLS, immutable
evidence guards, PDF MIME/extension gates and `extract_pdf` jobs. The same queue's
lease token, heartbeat, attempts, retry schedule, expiration recovery and dead-letter
semantics apply. Browser users cannot claim, complete or directly mutate extraction
state. Privileged RPCs validate tenant/source/job identity and fencing. Completion
retains its lease token, is idempotent and rejects conflicting payloads. Revision
saves record actor/time and reject optimistic-lock conflicts. Comparison runs bind
specific confirmed revision IDs, so later edits cannot change queued/persisted results.

Extraction runs in an isolated, credential-free Python subprocess with a 60-second
wall deadline, bounded bytes/output, measured page progress and termination on lost
lease. Timeouts are retryable through the existing bounded policy; corrupt/encrypted
input fails safely. Incomplete/scanned/unsupported selected pages become durable
OCR-required without confirming or publishing a partial comparison.

Browser PDF upload uses private Storage and authoritative server syntax inspection.
The local worker persists extraction before the browser displays page text, table/
header/field mappings and original/replacement values. Users save durable drafts,
confirm every selected page's structure and continue to the existing results, review
and changed-products CSV export. Refresh/re-entry restores revisions. The browser
never parses PDF bytes or reconciles products. No public PDF URLs are introduced.

## Verification

| Check | Result |
| --- | --- |
| Docker-backed local reset | Five migrations applied from scratch |
| Native foundation SQL/RLS | 32 passed |
| Native durable jobs SQL/RLS | 20 passed |
| Native review/export SQL/RLS | 16 passed |
| Native PDF leases/revisions/security | 15 passed |
| Real Auth/private Storage/Python/exports integration | 34 passed |
| Web JS/TS | 62 passed |
| Shared contract JS/TS | 54 passed |
| Python | 227 passed, including 45 new PDF tests |
| Chromium desktop/tablet/mobile | 30 distinct cases passed across full run and targeted rerun |
| Local database lint | No schema errors |
| npm ci | Passed; zero vulnerabilities |
| Contract generation drift, typechecks, production build | Passed |
| Prettier and Ruff lint/format | Passed |
| Source distribution/wheel build and isolated installed-wheel smoke | Passed |
| CPU worker image build and network-disabled installed parser smoke | Passed |
| git diff --check | Passed |

Native database verification totals **117 passing tests**, against local Docker
Supabase/PostgreSQL. PGlite's 32 supplementary foundation checks also pass, but are
not substituted for or counted as extra native verification. JS/TS totals **116**;
Python totals **227** (55 contracts, 67 CSV, 21 worker, 39 XLSX, 32 PDF parser and
13 PDF worker tests). Installed-wheel/container smoke validates the packaged schema,
two-page PDF, three normalized records, exact decimals, blank costs and leading zeros
without test fixture writers or network access in the runtime.

Native coverage includes concurrent PDF claim exclusivity, expired lease fencing,
heartbeat/progress, retries/exhaustion, duplicate completion, typed explicit mapping,
immutable original/revision data, tenant isolation and cross-tenant reference rejection.
Real HTTP integration verifies corrupt/encrypted upload rejection, private PDF
access, OCR-required state, durable draft/confirmation, actor/time, unchanged evidence,
fixed revision snapshots, exact persisted results/review and trusted CSV export.
CSV/XLSX existing Python, native integration and browser cases are retained.

Browser verification covers 10 scenarios at each of three viewport sizes: 21
CSV/XLSX cases and nine PDF cases. The full final run passed 27 cases; its three
CSV error-state assertions used stale test copy. After restoring the existing CSV
assertion, a targeted rerun passed all six CSV error-state and PDF pipeline cases
(three PDF cases overlap the full run). All 30 distinct cases therefore passed.
The PDF pipeline rerun also verifies the final sticky source-column and mobile
scroll-hint usability changes. Upload, measured progress, mapping, correction,
refresh/re-entry, review, export, OCR-required and error states pass at all widths.

Early verification exposed missing completed lease-token publication and empty
progress-RPC HTTP response handling; both were fixed without weakening constraints.
Baseline PDF-rejection assertions were updated for the newly supported file type.
The committed-concurrency fixture was ordered after transactional fixture checks.
Browser verification corrected an ambiguous page-preview selector and improved
checkbox alignment, keyboard access to the correction table and PDF-specific mapping
errors. Final checks use those fixes.

## Supported limits

Digital embedded-text, unencrypted PDFs with reliable table geometry; explicit page,
table/header selection and mapping are mandatory. Up to 10 MiB per PDF, 50 selected
pages, 5,000 extracted rows, 2,000 rows/32 columns per table, 10,000 characters per
cell and 16 MB extraction output. Header names must be unique, nonblank and identical
across selected pages. Exact repeated headers can be skipped explicitly; row fragments
are never joined across pages. Text-aligned uncertainty remains review/exclusion,
not automatic approval. The current review flow does not approve uncertain matches.

Source preview shows immutable embedded text, page numbers and field references;
cell bounding geometry is stored for future visual review. No rendered PDF preview
or OCR is added. Preview text is capped at 50,000 characters per page; original private
bytes remain unchanged. The local installed worker environment is required for upload
inspection and polling. There is no hosted worker deployment, OCR/PaddleOCR-VL, fuzzy
matching, margin calculation, customer export mappings or billing in this increment.

## Files changed

- `.github/workflows/ci.yml`
- `README.md`
- `apps/web/api/pdf.ts`
- `apps/web/e2e/workflow.spec.ts`
- `apps/web/server/pdf.ts`
- `apps/web/server/uploads.ts`
- `apps/web/src/components/ComparisonDetail.vue`
- `apps/web/src/components/CsvSettings.vue`
- `apps/web/src/components/PdfSettings.vue`
- `apps/web/src/workflow.ts`
- `apps/web/tests/pdf-endpoint.test.ts`
- `apps/web/tests/uploads.test.ts`
- `apps/web/tests/workflow.test.ts`
- `apps/web/vite.config.ts`
- `docs/ARCHITECTURE_ASSESSMENT.md`
- `docs/INCREMENT_7_VERIFICATION.md`
- `docs/LOCAL_CSV_WORKFLOW.md`
- `package.json`
- `scripts/verify-supabase-local.mjs`
- `services/worker/Dockerfile`
- `services/worker/README.md`
- `services/worker/pyproject.toml`
- `services/worker/src/stockshift_worker/entrypoints/cli.py`
- `services/worker/src/stockshift_worker/entrypoints/pdf.py`
- `services/worker/src/stockshift_worker/extraction/digital_pdf.py`
- `services/worker/src/stockshift_worker/jobs/gateway.py`
- `services/worker/src/stockshift_worker/jobs/pdf.py`
- `services/worker/src/stockshift_worker/jobs/runner.py`
- `services/worker/tests/pdf_fixture.py`
- `services/worker/tests/pdf_package_smoke.py`
- `services/worker/tests/test_job_runner.py`
- `services/worker/tests/test_pdf.py`
- `services/worker/tests/test_pdf_jobs.py`
- `services/worker/uv.lock`
- `supabase/README.md`
- `supabase/migrations/20261005191747_digital_pdf_corrections.sql`
- `supabase/tests/pdf.local.mjs`
- `supabase/tests/security.test.mjs`
- `supabase/tests/upload.local.ts`
