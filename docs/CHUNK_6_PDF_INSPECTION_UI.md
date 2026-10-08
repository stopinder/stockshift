# Chunk 6: asynchronous PDF inspection UI

Completed locally on October 8, 2026. Read `AGENTS.md`, inspected modified and
untracked files, and preserved existing work. No server API or schema changes
were needed.

## Behavior and compatibility

The old UI expected `{pages, ocrModel}` from `/api/pdf`. This incompatibility was
reported before implementation. The UI now consumes Chunk 5's persisted
`byteVerification` and `inspection` response without expanding the API scope.

Upload verification, queued/running inspection, digital-table candidates,
OCR-required documents and failures have distinct messages. PDF upload badges
say bytes are verified, rather than claiming comparison readiness. Inspection
does not produce products or automatically start extraction or comparison.

Page count and per-page candidate diagnostics populate the page controls. Digital
extraction is enabled only for a valid selected range of persisted candidate
pages. The OCR extraction option was removed; scans/unsupported documents explain
that OCR is disabled and suggest CSV/XLSX or a usable digital PDF. Existing source
evidence, corrections, draft saving and explicit mapping confirmation remain.

Returning to an attached PDF restores inspection, extraction and correction
revision state. Inspection/extraction polling uses a single delayed request only
while processing is pending; terminal states and status errors stop polling.
Status errors offer a manual status retry. Verified uploads with an enqueue gap
offer an explicit idempotent finalization retry without another upload. Terminal
inspection failures require a corrected upload in a new comparison.

Context generations discard late inspection/extraction/save responses after a
file/client/workspace change or unmount. Sign-out invalidates pending responses
and clears PDF state. Upload callbacks also ignore a disposed comparison, and
do not attach an upload after leaving its context.

## Changed files in this chunk

- `apps/web/src/components/PdfSettings.vue`: persisted inspection UI, page gates,
  pending-only polling, retry controls, context guards and OCR-disabled copy.
- `apps/web/src/components/ComparisonDetail.vue`: PDF-specific byte badge and
  upload response guards.
- `apps/web/src/workflow.ts`: retain verified PDF uploads when finalization/enqueue
  responses fail, allowing the attached settings UI to recover explicitly.
- `apps/web/src/pdf-inspection.ts`: inspection contract, labels, pending detection
  and digital-page range eligibility.
- `apps/web/tests/pdf-inspection.test.ts`: page eligibility, polling and state tests.
- `apps/web/e2e/pdf-inspection.spec.ts`: focused native local browser integration.
- This report.

## Checks actually run

- `npm run check`: passed contract generation checks, TypeScript, **86 web tests**,
  **54 contract tests**, **46 embedded SQL tests**, and the production build.
- `npm run format:check`: passed. Focused new-file Prettier checks and
  `git diff --check`: passed.
- Focused Playwright suite: **10 passed** across Chromium desktop **1440×1000**
  and mobile **390×844**. It uses real local Auth, private Storage, upload/API
  handlers, PostgreSQL and the CPU worker. Network interception deliberately
  simulates delayed finalization responses, a readiness-to-enqueue gap and a
  transient inspection read failure; ordinary inspection states are persisted
  native results.
- Synthetic old/new PDF pair: bytes verified → queued → running → digital-table
  candidates, one persisted page each. Extraction remains explicit and Start
  comparison stays disabled without confirmed revisions. Leaving while queued
  and returning works. Terminal inspection causes no further polling.
- Blindtex scan: one persisted page, OCR required, OCR-disabled explanation,
  extraction/comparison disabled, same state after reload.
- Recovery/error checks: explicit enqueue retry after interruption, manual status
  retry after HTTP 503, and terminal invalid-PDF failure.
- Stale-response checks: held old responses do not reappear after leaving the
  file context, changing workspace or signing out.
- Explicit digital extraction/correction regression: two-page synthetic document
  extracts only after clicking the button; a correction draft and confirmed
  revision survive reload. No comparison is automatically created.
- Inspection-only cases assert zero extraction, revision, comparison and product
  result rows. No OCR provider is configured or called. Workers refuse to consume
  an unrelated unfinished queue.

Screenshots were visually inspected for the synthetic pair and Blindtex at both
widths, and overflow assertions passed. Artifacts are in ignored `.tools/`:
`chunk6-{desktop,mobile}-{synthetic-pair,blindtex,failure,explicit-gates}.png`.
The final browser log is `.tools/chunk6-browser.log`.

Initial browser attempts exposed two test-harness races (removing an interceptor
before delayed fulfillment, and navigating to the same hash without remounting).
Those were corrected; the final full focused run passed all ten tests.

Docker's Linux engine was reachable. The existing `stockshift-local` database was
used without reset or migration. Row fingerprints confirmed all **7,954
pre-existing rows across 18 tables** remained unchanged. Synthetic browser
fixtures remain local. The full legacy browser/OCR suite and `npm run test:local`
were not rerun in this UI chunk; native integration was exercised through the
focused browser suite above.

## Local verification and boundaries

The checked-in capability remains `STOCKSHIFT_PDF_INSPECTION_ENABLED=0`.
For the focused checks, opt in only in the command's local shell:

```powershell
$env:STOCKSHIFT_PDF_INSPECTION_ENABLED = '1'
$env:STOCKSHIFT_TEST_DAEMON = '1'
npm run test:browser -- apps/web/e2e/pdf-inspection.spec.ts --project=desktop --project=mobile
Remove-Item Env:\STOCKSHIFT_PDF_INSPECTION_ENABLED
Remove-Item Env:\STOCKSHIFT_TEST_DAEMON
```

This starts the guarded local web launcher on loopback port 5183 and obtains keys
from local CLI status. For manual local web use, set only the inspection capability
and run `npm run dev:local`; no capability or credential is written to an env file.
Hosted/Vercel PDF rejection is unchanged even if the capability is enabled.

No blockers remain for the requested UI. The separate administrative `verifying`
crash-recovery limitation is unchanged. Hosted PDFs and OCR remain disabled.
No hosted access/migrations, deployment, GPU actions, pricing/billing changes,
commit or push occurred.
