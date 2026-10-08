# Chunk 12 — comparison-only allowance accounting

Verified October 8, 2026 in `.tools/chunk11-reconcile` on
`codex/preview-cpu-pdf-release`, starting at `f18b829`. Code commit:
`826f2fd9431889cde32202d736629fdfda882544`. The following documentation commit is
the final release tip; resolve the release ref in the manifest to identify it.

## Fix and enforcement review

The baseline AFTER INSERT trigger charged every `jobs` row, including preparation.
The ten-line additive migration
`20261008213000_comparison_job_allowance_accounting.sql` replaces only that trigger
with `WHEN (new.kind = 'reconcile_csv')`. CSV and PDF comparisons both use this kind.
`inspect_pdf` and `extract_pdf` do not consume comparison allowances.

Reviewed all affected paths:

- `private.consume_workspace_allowance`: tenant counter row lock, three-comparison
  trial, twenty-comparison valid live period, pilot exemption and paid period reset
  are unchanged. The source-file trigger still reserves files and expected bytes.
- `private.enqueue_comparison_job`: tenant editor/owner authorization, tenant/key
  advisory lock, comparison lock, exact settings/key reuse checks, verified inputs
  and complete confirmed PDF revisions precede insert. Rejected inserts roll back
  their run and counter changes together.
- `private.enqueue_pdf_inspection` and `private.enqueue_pdf_extraction`: existing
  authorized file/configuration locks and idempotent job reuse are unchanged.
  Inspection enqueue recovery and verification ownership/hash/lease checks remain.
- Worker claim, failure, lease replacement and completion update the existing job;
  they do not insert a charged comparison. Stale leases remain fenced.
- `workspace_allowance_status`, browser `allowance.ts`, allowance panel and workflow
  gates read existing counters. No second job-count calculation requires changes.
  API quota errors still map to bounded 429 responses.

No prices, subscription policy, upload limits, application UI or worker source were
changed. No retrospective counter rewrite/refund was performed.

Changed release files (eleven total):

- `supabase/migrations/20261008213000_comparison_job_allowance_accounting.sql`
- `supabase/tests/allowance.local.mjs`
- `supabase/tests/release-baseline.test.mjs`
- `supabase/tests/upload.local.ts`
- `apps/web/e2e/pdf-acceptance.spec.ts`
- `scripts/supabase-local.mjs`
- `scripts/verify-supabase-local.mjs`
- `supabase/README.md`
- `docs/CHUNK_10_RELEASE_MANIFEST.json`
- `docs/CHUNK_10_PREVIEW_RELEASE.md`
- `docs/CHUNK_12_ALLOWANCE_ACCOUNTING.md`

## Native local verification

Docker reported `linux`; generated local API configuration was verified at
`http://127.0.0.1:54321` and PostgreSQL used fixed loopback port 54322. The ledger
contained eleven versions, with four missing earlier CSV baseline migrations.
After fingerprinting populated data, the reviewed local-only command
`npm run supabase:local -- migration up --local --include-all` applied those four
versions and the new accounting migration. No database reset was performed.

`npm run test:local` passed **170 checks**. It now includes:

- A real native fresh-trial test: eight simultaneous same-key requests produce one
  comparison/charge; eight requests across distinct comparisons sharing the tenant
  accept exactly two more and reject six at the three-comparison limit. Rejected
  requests leave no orphan comparison runs. Same-key reuse works at zero allowance.
  A retry uses a replacement lease, rejects stale completion and never charges
  again; a further new comparison remains rejected after successful completion.
- The complete-schema test in native PostgreSQL: repeated PDF enqueue is free,
  another extraction configuration is allowed at exhausted comparison allowance,
  a new comparison is denied, another tenant cannot inspect the file, and a local
  paid-subscription fixture retains twenty comparisons through PDF preparation then
  nineteen after an actual comparison. This case rolls back completely.
- Existing queue/review/PDF/inspection, authorization, private Storage, upload
  verification recovery and real CPU worker integrations. Hosted-mode capability
  tests transport requests only to local services, including exact digital results
  and the Blindtex stop. No OCR provider request is made.

The first concurrency run exposed a test helper's PostgreSQL-array/JSON mismatch;
the helper was corrected, and only its own fixture jobs were completed. The first
full suite then hit trial limits in the shared HTTP stress fixture. Those new
test-only workspaces are now explicitly pilot-exempt because this suite tests more
than three comparisons/twenty uploads. Fresh-trial acceptance and concurrency
tests remain non-exempt. The final full suite passed with no pending jobs.

## Actual merged browser evidence

Command: `STOCKSHIFT_TEST_DAEMON=1 STOCKSHIFT_PDF_INSPECTION_ENABLED=1 npm run
test:browser -- pdf-acceptance.spec.ts --project desktop --project mobile` (the
variables were set with PowerShell). This launches the release app on loopback
port 5183 and uses real Supabase Auth/Storage and the installed CPU worker wheel.
**All six cases passed** in 1.5 minutes, at 1440×1000 and 390×844.

Each synthetic case starts with a fresh non-exempt trial workspace. Both PDFs
upload, inspect, explicitly extract, map/review and confirm with allowance still
**3**. The comparison changes it to **2**, with exactly two file reservations and
**4,755 bytes** reserved; paid usage remains zero. All six baseline outcomes and
three export rows match the benchmark exactly, including decimal strings and
leading-zero identifiers. The saved correction `00042: 4.20 → 5.25` persists after
reopening, changes that product to unchanged and produces the expected two rows.

Blindtex reaches persisted `ocr_required`, survives reopening and consumes no
comparison allowance. Extraction, comparison and export stay unavailable. Explicit
review/confirmation gates remain effective; inspection alone creates no products
or revisions. Browser request monitors observed no OCR traffic; worker integration
also verifies the CPU-only boundary. Viewports had no horizontal overflow.

Local evidence is retained in the release worktree's ignored `.tools` directory:
`chunk7-{desktop,mobile}-{baseline,corrected}-evidence.json` (including allowance),
the matching exact export CSVs, inspected/reopened/results/Blindtex screenshots,
`chunk12-local-final.log`, `chunk12-check.log`, `chunk12-advisors.log` and
`chunk12-preservation.json`. Browser traces/results live in `.tools/browser-results`.
No credentials or temporary evidence files are committed.

## Other checks and preservation

`npm run check` passed generated contracts, typecheck, **106 web tests, 54 contract
tests and 53 embedded SQL tests**, and the production build. After strengthening
the paid/cross-comparison test assertions, the affected schema test was rerun and
the final native suite exercised both changes. Targeted Prettier and Git whitespace
checks passed. Native database lint found no schema errors. Local advisors reported
one existing performance warning for `comparisons.editor_insert` re-evaluating
`auth.uid()` per row; that policy is unchanged and outside this fix.

All **10,996 pre-existing row fingerprints across 22 tables**, including original
migration ledger rows, remain present unchanged. All **240 original-worktree file
hashes** match the Chunk 11 preservation snapshot. New migrations/test fixtures
are additive. The original branch/worktree was not switched or overwritten.
Earlier focused CPU Python checks are reused because worker code is unchanged.

## Remaining release blockers

Accounting and merged local acceptance are resolved. Actual hosted app/worker
versions and migration history remain unknown. A separately approved isolated
Preview database/queue and CPU worker configuration, migration → worker → Preview
API rollout, advertisement checks and real hosted acceptance are still required.
The old seven-argument finalizer remains incompatible with the leased completion
RPC, so a shared Production database requires a coordinated upgrade. Keep the
accounting migration during rollback; do not restore the defective all-job trigger.

Hosted capabilities remain default-off, OCR remains disabled and the GPU remains
paused. No hosted access/migration, push, deployment, OCR call, GPU operation or
deployed billing change occurred. See the updated release manifest and Preview plan
for exact migration hashes, configuration scopes, stop conditions and rollback.
