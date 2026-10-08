# Chunk 5: PDF upload and persisted inspection API

Completed locally on October 8, 2026. Existing modified and untracked work was
preserved. No migration was added or applied in this chunk.

## Behavior

`STOCKSHIFT_PDF_INSPECTION_ENABLED` is a server-only capability, defaulting off.
Setting it to `1` permits local PDF upload/inspection APIs. Hosted mode, Vercel
and CSV-only preview mode still reject PDFs even when this capability is set.
The checked-in environment example keeps it at `0`.

Finalization verifies registered Storage bytes, size, PDF signature and SHA-256,
then persists byte readiness and calls the existing authenticated inspection
enqueue RPC. It performs no PDF parsing in the web server. The RPC creates one
inspection/job per source and inspector version. Repeated finalization returns
that persisted inspection. A failure or interruption between readiness and
enqueue, including a lost enqueue response, is recoverable by retrying
finalization: ready bytes stay ready and are not downloaded again. Enqueue errors
return HTTP 503 with an explicit retry message.

The existing pre-readiness upload lifecycle is unchanged: a process crash while
the source is `verifying` still requires administrative investigation. This chunk
specifically recovers the finalization-to-enqueue gap; it does not add upload
lease recovery or an automatic sweeper.

`POST /api/pdf` validates the user with Auth and reads source/inspection rows
through tenant RLS. It returns persisted state only; it neither downloads blobs
nor spawns Python nor enqueues work. Its response contains:

- `fileId`;
- `byteVerification`: `pending`, `verifying`, `failed` or `verified`;
- `inspection`: id, status, pageCount, diagnostics and failure (nullable fields);
- `comparisonEligibility`: `requires_confirmed_extraction`.

Without an inspection row, the inspection status is `not_queued`. Persisted
statuses include `queued`, `running`, `inspected`, `ocr_required` and `failed`.
Verified bytes do not establish structural validity. Successful inspection does
not establish comparison eligibility. Inspection never starts extraction,
comparison or OCR; `ocr_required` is only a persisted diagnostic outcome.

## Changed files

- `.env.example`: default-off server capability.
- `apps/web/server/uploads.ts`: byte verification, capability gates and resumable
  idempotent inspection enqueue after finalization.
- `apps/web/server/supabase-upload-gateway.ts`: authenticated source read and
  inspection enqueue RPC.
- `apps/web/api/uploads.ts`: early create capability validation.
- `apps/web/api/pdf.ts`: authorized persisted inspection response.
- `apps/web/tests/uploads.test.ts`, `pdf-endpoint.test.ts` and
  `csv-preview.test.ts`: capability, recovery and endpoint regressions.
- `supabase/tests/inspection.local.ts`: native API/Storage/Auth/queue/worker checks.
- `supabase/tests/upload.local.ts`: byte-versus-inspection assertions and explicit
  test worker draining of inspection jobs.
- `supabase/README.md` and this report: local workflow and API documentation.

## Verification

Docker's Linux engine was reachable. The existing local stack was verified as
`stockshift-local` from this checkout, using loopback API/DB ports 54321/54322.
No database reset was performed. Hash snapshots confirmed that all 7,502
pre-existing rows across 18 tables remained unchanged after the native tests.
The suites retain their synthetic local fixtures.

- `npm run test:local`: **150 passed**, zero failures or skips: 32 foundation
  security, 20 queue/concurrency, 16 review, 15 PDF, 14 inspection SQL, 8 native
  inspection/API, 11 OCR-boundary SQL and 34 upload/worker integration tests.
  OCR-boundary SQL uses synthetic data and makes no OCR provider calls.
- Native checks cover real Auth/private Storage, repeated finalization, a
  readiness-to-enqueue interruption, a lost enqueue response, concurrent enqueue
  and worker claims, abandoned worker leases, tenant authorization, capability
  rejection, queued/running/inspected/OCR-required/failed responses and no
  extraction/comparison side effects from inspection.
- `npm run check`: passed contract checks, TypeScript, web/contracts tests,
  46 embedded database checks and production build. After the final test additions,
  TypeScript and the full web suite passed again: **83 web tests**. Contract tests
  passed **54**.
- `npm run format:check`, focused Prettier checks and `git diff --check`: passed.

## Remaining limitations

The unchanged UI expects the old PDF discovery response. Updating it to poll and
render persisted inspection outcomes belongs to a later chunk; the capability
remains off by default. Existing `verifying` crash recovery remains as described
above. There are no blockers to the tested local API/worker path.

No UI, pricing or billing code was changed by this chunk. No hosted access,
hosted migrations, deployment, GPU operation, OCR call, commit or push occurred.
