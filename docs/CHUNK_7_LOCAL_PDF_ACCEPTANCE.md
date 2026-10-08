# Chunk 7: local digital-PDF workflow acceptance

Verified on October 8, 2026 using the actual local Chromium browser, Supabase
Auth/private Storage/PostgreSQL, web API handlers and CPU Python worker. No
responses, extraction results or comparison results were mocked. Existing work
was preserved; no application defect requiring a code change was found.

## Browser acceptance

The focused suite completed six cases: baseline pair, separately corrected pair
and Blindtex, each at desktop 1440×1000 and mobile 390×844. The digital cases used
the normal browser controls for every successful mutation:

1. Register/upload the benchmark old/new PDFs and finalize verified bytes.
2. Run the CPU worker and observe persisted digital-table candidate inspection.
3. Click explicit digital extraction for each source; run the worker.
4. Inspect source text, identifiers, prices and original cells; explicitly map
   SKU, Price, Description, Currency, Pack and UOM. Use the printed benchmark's
   per-unit/net basis.
5. Confirm both mappings, reopen, explicitly start comparison and run the worker.
6. Inspect all six rendered outcomes and download the actual changed-products CSV.

The benchmark oracle is `synthetic_export_pair` in
`tests/fixtures/catalogue-benchmark/expected-results.json`, with the independent
CSV oracle in `synthetic/expected-changed-products.csv`. Both input PDF SHA-256
values matched the manifest:

- Old: `da6986c765ee1472b6065399eba25a4b2331cbe779d8df41229cff9330b69aa1`.
- New: `734260aefc8b4639f3671703931bf4f700c05598169c2df4d6d680da8448c679`.

## Baseline outcomes and export

Every persisted outcome, exact decimal, change flag, identifier and commercial
field matched the manifest. Each result retained page-1 provenance. Counts were
three changed, one unchanged, one new, one absent and zero needs-review.

| SKU | Outcome | Old cost | New cost | Exact delta | Change % | Export |
| --- | --- | --- | --- | --- | --- | --- |
| 00042 | changed, price decrease | 5.25 | 4.20 | -1.05 | -20.000000 | yes |
| 00123 | changed, price increase | 19.995 | 20.995 | 1.000 | 5.001250 | yes |
| 00756 | unchanged | 0.80 | 0.80 | 0.00 | 0.000000 | no |
| 08001 | changed, description | 1234.56 | 1234.56 | 0.00 | 0.000000 | yes |
| 09000 | absent | 2.00 | — | — | — | no |
| 09999 | new | — | 12.00 | — | — | no |

Both downloaded baseline exports contained exactly three data rows. All 13 cells
per row matched the manifest, including descriptions, GBP, each, pack 1, unit
price basis, net tax basis, percentage state and change flags. Leading zeros and
source decimal precision were retained. Export ordering was compared by exact
SKU, as instructed by the manifest.

## Separate correction expectation

`CHUNK_7_CORRECTION_EXPECTATION.json` was written before the corrected acceptance
run. It specifies changing the incoming `00042` cost from `4.20` to `5.25`.
The browser saved a correction draft, left the comparison, reopened it, and
verified that the correction remained `5.25` while the original stayed `4.20`.
It then explicitly confirmed the revised mapping and compared the files.

The result matched that separate expectation: `00042` became unchanged with
old/new cost `5.25`, delta `0.00`, percentage `0.000000` and no change flags.
Counts became two unchanged, two changed, one new and one absent. The actual
download contained only `00123` and `08001`; every exported cell for those two
rows remained identical to the benchmark. All five other outcomes remained
unchanged from the baseline expectation.

## Blindtex and review gates

The benchmark's one-page Blindtex scan fixture
`services/worker/tests/fixtures/catalogue_layout/remaining/awkward-catalogue.pdf`
reached persisted `ocr_required`, including after reload. The browser displayed
the OCR-disabled explanation. Extraction and comparison were disabled and export
was unavailable. Its tenant had zero extraction runs, correction revisions,
comparison runs or comparison result rows. No OCR browser request was observed;
the worker had no OCR endpoint/token and only performed CPU inspection.

For both digital runs, inspection alone left all extraction/revision/comparison
tables empty and Start comparison disabled. Extracted data without confirmation
also left comparison disabled. Confirming only one side was insufficient.
Confirming both sides created no comparison until the explicit Start comparison
click. Persisted extraction configurations were digital, and no raw page used
`paddleocr-vl`.

## Evidence and checks actually run

Artifacts are retained in ignored `.tools/`:

- `chunk7-{desktop,mobile}-baseline-results.png`: real six-row results UI.
- `chunk7-{desktop,mobile}-correction-reopened.png`: reopened correction draft.
- `chunk7-{desktop,mobile}-corrected-results.png`: corrected outcome counts.
- `chunk7-{desktop,mobile}-blindtex-stopped.png`: OCR-required stop.
- `chunk7-{desktop,mobile}-{baseline,corrected}-export.csv`: actual browser downloads.
- `chunk7-{desktop,mobile}-{baseline,corrected}-evidence.json`: tenant/comparison/run
  IDs, all exact outcomes, counts, persisted inspections, digital configurations
  and parsed export rows. These contain no credentials.
- `chunk7-browser.log`, `chunk7-check.log` and `chunk7-format.log`.

Checks:

- Focused Playwright acceptance: **6 passed**, desktop and mobile. Overflow
  assertions passed; result/correction/Blindtex screenshots were inspected.
- `npm run check`: passed contract generation checks, TypeScript, **86 web**,
  **54 contract** and **46 embedded database** tests, plus production build.
- `npm run format:check`, focused new-file Prettier checks and
  `git diff --check`: passed.
- Docker Linux engine was reachable. Container labels confirmed
  `stockshift-local` belongs to this checkout; API/database stayed on loopback
  ports 54321/54322. No reset or migration was performed.
- Fingerprints confirmed all **8,244 pre-existing rows across 18 tables** stayed
  unchanged. Native browser fixtures remain local. No unrelated unfinished jobs
  were consumed, and the final queue had no unfinished jobs.

Initial harness assertions assumed export was disabled rather than hidden before
results, and assumed summary JSON included zero-count categories. Those test
assumptions were corrected to the existing contracts. The final six-case run
passed without application changes. The full legacy/OCR browser suite and
`npm run test:local` were not rerun; this acceptance used the real native stack
through the focused browser workflow.

## Changed files and release blockers

Only three files were added:

- `apps/web/e2e/pdf-acceptance.spec.ts`.
- `docs/CHUNK_7_CORRECTION_EXPECTATION.json`.
- This report.

Reproduce against the existing local stack with the documented local capability:

```powershell
$env:STOCKSHIFT_PDF_INSPECTION_ENABLED = '1'
$env:STOCKSHIFT_TEST_DAEMON = '1'
npm run test:browser -- apps/web/e2e/pdf-acceptance.spec.ts --project=desktop --project=mobile
Remove-Item Env:\STOCKSHIFT_PDF_INSPECTION_ENABLED
Remove-Item Env:\STOCKSHIFT_TEST_DAEMON
```

The capability was enabled only in the verification process. The checked-in
default remains off; hosted PDF processing is disabled and unverified. Hosted
PDF infrastructure/capability work and administrative recovery for uploads stuck
in `verifying` remain release blockers. Scanned/unsupported documents cannot be
processed while OCR remains disabled. This acceptance establishes the synthetic
local digital journey, not full real-catalogue or hosted acceptance.

No hosted access, hosted migrations, deployment, GPU operation, OCR call,
pricing/billing change, commit or push occurred.
