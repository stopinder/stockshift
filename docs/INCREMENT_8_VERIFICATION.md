# Increment 8 verification

Checkout: `C:/Users/Rob/WebstormProjects/stockshift`, branch `main`.
Baseline: `16705f7317e1114b1d63bb47f2e8e3b48ff1eacd`, clean and synchronized before work.
No hosted Supabase credentials, project access, linking, migration pushes or Git push.

## Implementation

PaddleOCR-VL's official `/layout-parsing` serving protocol is implemented behind
`RoutedPdfExtractor` / `DocumentExtractor`. The CPU worker runs direct digital
inspection first, renders only unusable pages with pinned PDFium, and combines
validated rectangular table output in original page order. Environment-driven model
and endpoint configuration are worker-owned. The browser explicitly opts in to OCR;
the endpoint and token never reach it. CSV/XLSX and downstream deterministic logic
remain shared. No model weights or live GPU service were provisioned.

Migration `20261005220000_paddleocr_pages.sql` adds RLS-enabled `private.ocr_pages`
with tenant/extraction/source foreign keys, request counts, immutable completed
responses/digests, failures and lease fencing. The new worker-only event RPC reserves
usage before HTTP, publishes cached evidence before continuing, and rejects a fourth
request for a page. Existing jobs supply retries, heartbeats, reclaim and exhaustion.
Comparison results keep the same schema and reference confirmed immutable revisions.

Provider/model/adapter/configuration/request/render hashes, rendered dimensions/DPI,
page/row/table/column, raw OCR text, table-level bounds and available uncalibrated
scores are retained. Unknown confidence is null. Every selected OCR product row
requires source verification, separately from structure confirmation. Corrections
retain raw evidence and save actor/time, verified IDs and replacement fields in
append-only revisions; they survive re-entry and feed exact decimal normalization.
Partial failed pages cannot be confirmed or used as a complete catalogue.

## Verification results

| Check | Result |
| --- | --- |
| Docker-backed local Supabase reset | Six migrations applied from scratch |
| Native foundation SQL/RLS | 32 passed |
| Native job lifecycle SQL/RLS | 20 passed |
| Native review/export SQL/RLS | 16 passed |
| Native digital-PDF SQL/RLS | 15 passed |
| Native OCR cache/usage/security | 11 passed |
| Real local Auth/private Storage/Python/result/export integration | 34 passed |
| Web JS/TS + shared contract tests | 62 + 54 passed |
| Python | 258 passed (31 new OCR tests) |
| Browser desktop/tablet/mobile | 36 distinct cases passed across full run and isolated rerun |
| Local database lint | No schema errors |
| Contract generation drift/typechecks/production build | Passed |
| Prettier and Ruff lint/format | Passed |
| Locked package build/installed-wheel smoke | Passed |
| CPU container build/network-disabled smoke | Passed |
| git diff --check | Passed |

Python totals: 55 contracts, 67 CSV, 21 worker, 39 XLSX, 32 digital PDF,
13 digital PDF worker, 24 OCR adapter/routing, seven isolated HTTP OCR worker tests.
The 20 PDF/OCR worker tests were additionally rerun after bounding cache-retry input.
PGlite's 32 supplementary foundation checks pass but do not substitute for native
PostgreSQL. GPU/model inference is mocked in all automated tests. Native local verification totals
**128 passing tests**; no hosted project is involved.

OCR tests cover scanned and mixed routing, merged digital-table fallback, no OCR
calls for usable digital pages, actual
rendered PNG requests, normalization, page provenance, low/unknown/high uncalibrated
scores, mandatory verification, corrections and raw evidence, cached reuse, malformed
response/merged tables, timeout/rate limit/unavailable service, partial failures,
page limits, endpoint restrictions, lease loss, retry budgets, immutable cache,
tenant ownership/foreign keys and browser access denial. Existing CSV/XLSX/digital
PDF tests remain intact except the discovery assertion now expects the added safe
model-identity response field.

Installed-wheel and CPU-image smoke run real two-page scanned rendering with an
injected deterministic provider. They verify packaged contracts, leading zeros,
exact corrected decimals and retained OCR evidence with container networking disabled.
The separate serving-compatible smoke uses a real loopback HTTP server and isolated
worker protocol; its output is fixture data, not model inference. No real PaddleOCR-VL
accuracy claim is made.

The full browser run passed 35 of 36 cases. The existing tablet XLSX corrupt-upload
error-state assertion timed out at its unchanged five-second wait while other CPU
verification was running. Its isolated rerun passed without changing the test or
product behavior. All 36 distinct cases therefore pass: six new OCR and 30 retained
CSV/XLSX/digital-PDF cases across the three viewports.

Browser QA covers upload, durable digital OCR-required detection, explicit OCR choice,
measured progress, correction/verification, revisions/reload, persisted comparison,
review, exact export and visible 429 retry/re-entry at desktop/tablet/mobile widths.
Early QA corrected queue/re-entry synchronization in the new test and bounded its
asynchronous page-discovery wait. The comparison button now waits for confirmed PDF
settings to restore. Screenshot inspection fixed inherited textbox sizing on OCR
checkboxes and uses a restrained warning colour for source-verification notices.

## Limitations and operator boundary

No real model/GPU inference was run. The serving adapter is integration-tested against
the official response shape; extraction accuracy on real supplier scans is unverified.
An operator must configure and validate the service/model before customer use. The
repository stub only recognizes synthetic fixture render hashes and is not OCR.

Only rectangular tables are accepted. Merged/ragged/unsupported layouts remain
incomplete; no automatic row joining, business mappings, fuzzy matching or SKU repair.
Table bounding boxes are not cell boxes. OCR source verification remains mandatory
at any score. Rendering is deterministic 144 DPI; no automatic orientation correction.
Defaults: 10 MiB PDF, 50 selected pages, 10 OCR pages, 12 MP rendered pages, 2 MB/page
response, 5,000 rows, 16 MB final extraction, 180-second subprocess deadline. Smaller
configured page limits are supported. Cache-retry subprocess input is bounded to
48 MB, accounting for source bytes and persisted responses.

Usage counts reserved attempts, not confirmed billable inference. Completed local
pages deduplicate retries; remote crash-window deduplication depends on the operator's
implementation of the stable `Idempotency-Key`. No exactly-once billing is claimed.
No billing, hosted GPU deployment, margins, customer-specific export mappings or
unrelated procurement features are added. See [full local workflow](PADDLEOCR_WORKFLOW.md).

## Files changed

- `.github/workflows/ci.yml`
- `README.md`
- `apps/web/api/pdf.ts`
- `apps/web/e2e/workflow.spec.ts`
- `apps/web/src/components/ComparisonDetail.vue`
- `apps/web/src/components/PdfSettings.vue`
- `docs/ARCHITECTURE_ASSESSMENT.md`
- `docs/INCREMENT_8_VERIFICATION.md`
- `docs/PADDLEOCR_WORKFLOW.md`
- `package.json`
- `scripts/verify-supabase-local.mjs`
- `services/worker/Dockerfile`
- `services/worker/README.md`
- `services/worker/pyproject.toml`
- `services/worker/src/stockshift_worker/entrypoints/pdf.py`
- `services/worker/src/stockshift_worker/extraction/digital_pdf.py`
- `services/worker/src/stockshift_worker/extraction/paddleocr.py`
- `services/worker/src/stockshift_worker/jobs/gateway.py`
- `services/worker/src/stockshift_worker/jobs/pdf.py`
- `services/worker/src/stockshift_worker/jobs/runner.py`
- `services/worker/tests/ocr_fixture.py`
- `services/worker/tests/ocr_package_smoke.py`
- `services/worker/tests/ocr_stub.py`
- `services/worker/tests/test_ocr.py`
- `services/worker/tests/test_ocr_service.py`
- `services/worker/uv.lock`
- `supabase/migrations/20261005220000_paddleocr_pages.sql`
- `supabase/tests/ocr.local.mjs`
- `supabase/tests/upload.local.ts`
