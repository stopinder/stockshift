# Increment 5 verification

Scope: persistent browser CSV review/export workflow. Base commit:
`995ef2f648dbc8fa13d5bd4c14229196fe2391c5`. Work was performed in the requested
StockShift checkout, on main. No hosted Supabase project or credentials were used;
no linking, remote migration, project creation or Git push was performed.

## Delivered behavior

- Authenticated local workspace and owner/editor/viewer context.
- Comparison list, supplier/comparison creation and persistent comparison detail.
- Private signed CSV uploads and server verification, with real stage indicators.
- Explicit per-file mappings/conventions/defaults, durable enqueue and polling.
- Run-snapshot filenames, persisted database outcome counts and structured failure state.
- Server-side SKU/description search and outcome filtering, 100-row pages with a
  one-row lookahead, compact scrollable tables and sticky headers.
- Candidate basis, old/new normalized values and readable CSV file/row/column evidence.
- Append-only actor-scoped rejection/no-match decisions. Unsupported matches cannot
  be approved; worker results remain immutable and exclusions remain auditable.
- Server-generated changed-products CSV from tenant-authorized persisted rows.
  Unresolved review blocks export. Exact decimal text, leading-zero identifiers,
  undefined percentage state and deterministic ordering are preserved. Dangerous
  spreadsheet text prefixes are escaped without altering numeric delta cells.

## Schema/security

Migration `20261005175654_persistent_csv_review.sql` adds one table, `review_events`:
UUID identity, tenant/run/result composite foreign key, actor, supported decision,
required note and timestamp. One immutable decision per result. RLS permits tenant
reads; no browser or service-role direct mutation grants exist. Tenant-checked private
functions have empty search paths, explicit grants and public invoker wrappers.

New RPCs: `resolve_csv_review`, `csv_run_summary`, `csv_results_page`, `csv_export_rows`.
Summary/search use invoker RLS. Review serializes on the run; export takes a shared
run lock and checks completed processing plus zero unresolved reviews. Browser
users cannot claim/complete jobs or mutate worker output. All connections are local.

## Automated verification

| Suite | Result |
| --- | --- |
| Native foundation SQL/RLS | 32 passed |
| Native durable jobs SQL/RLS | 20 passed |
| Native review/export/pagination SQL/RLS | 16 passed |
| Real Auth/Storage/Python worker/HTTP export integration | 18 passed |
| Web JS/TS unit tests | 50 passed |
| Shared contract JS/TS tests | 54 passed |
| Python engine/contracts/job worker tests | 143 passed |
| Browser tests: five cases at three widths | 15 passed; 3 targeted workflow reruns passed |

Final database verification reset all three migrations from scratch against the
Docker-backed local Supabase PostgreSQL 17.11 stack. Database lint reported no
schema errors. No PGlite substitution was used. The supplementary embedded baseline
suite also passed 32 checks; those duplicate native foundation coverage and are not
counted as additional native security evidence.

Clean `npm ci`, generated-contract checks, web/server/browser-test typechecks,
production Vite build, Prettier checks, Python Ruff lint/format, source/wheel build
and installed-wheel imports/CLI passed. Wheel imports were verified from the separate
`.tools/wheel-verification` environment. Patch whitespace is checked before commit.

## Browser QA

Real Chromium: desktop 1440×1000, tablet 820×1100, mobile 390×844. Each width covers
authenticated creation, private upload/finalization, queued state after reload,
real running lease, actual Python execution, completed persisted results, search,
outcome filters, evidence, durable no-match exclusions, downloaded CSV, failure,
empty output, upload retry, invalid settings, unavailable comparison and invalid login.
The full successful flow checks browser exceptions and page-level horizontal overflow.
Tables intentionally scroll within their panels.

Issues fixed during QA:

- Explicit accessible names on supplier/outcome dropdowns.
- Review dialog now waits for the refreshed persisted table before closing; rapid
  follow-up review actions cannot reopen the just-resolved item.
- Readable source evidence replaces raw JSON/UUIDs in the main inspection view.
- Source evidence resets on each inspection; all three widths verify it expands visibly.
- Bounded result scrolling and sticky headers replace an excessively long table page.
- A server lookahead disables Next on a full final page, with native pagination
  coverage and browser assertions.
- Long titles wrap; tablet/mobile forms, navigation, counts and dialog layout adapt.
- Product errors/instructions describe user actions; local startup details live in docs.

Ignored `.tools/` contains test logs, screenshots, traces and synthetic local artifacts.
Reproduction: see `LOCAL_CSV_WORKFLOW.md`. No customer data or credentials are committed.

## Limits

- Local-only runtime; no hosted backend or worker deployment configured.
- UTF-8 CSV only, 10 MiB per source, existing 20,000-outcome worker limit.
- Browser mapping exposes SKU/cost/description and explicit file-wide commercial
  defaults, without per-row commercial-field mappings or inferred conventions.
- Review supports durable exclusion only; no approval/recalculation of unsupported
  matches, undo, fuzzy matching or manual record editing.
- Draft mapping edits persist only on enqueue; failed inputs require a corrected
  comparison. Uploaded files and completed outputs remain immutable.
- Changed-products export only; no customer-specific mappings or new/absent exports.
- Local seed creates synthetic owner accounts; public signup/account administration
  is outside scope. Comparison list shows the latest 100 entries.
- No XLSX/PDF/OCR, margin calculations, billing or marketing work was added.

## Changed files

The complete repository-relative inventory follows.

- `.env.example`
- `.github/workflows/ci.yml`
- `apps/web/api/export.ts`
- `apps/web/api/uploads.ts`
- `apps/web/e2e/workflow.spec.ts`
- `apps/web/index.html`
- `apps/web/package.json`
- `apps/web/playwright.config.ts`
- `apps/web/server/export.ts`
- `apps/web/server/supabase-upload-gateway.ts`
- `apps/web/src/App.vue`
- `apps/web/src/components/ComparisonDetail.vue`
- `apps/web/src/components/ComparisonList.vue`
- `apps/web/src/components/CsvSettings.vue`
- `apps/web/src/components/NewComparison.vue`
- `apps/web/src/main.ts`
- `apps/web/src/styles/main.css`
- `apps/web/src/workflow.ts`
- `apps/web/tests/workflow.test.ts`
- `apps/web/tsconfig.json`
- `apps/web/vite.config.ts`
- `docs/ARCHITECTURE_ASSESSMENT.md`
- `docs/INCREMENT_5_VERIFICATION.md`
- `docs/LOCAL_CSV_WORKFLOW.md`
- `package-lock.json`
- `package.json`
- `README.md`
- `scripts/seed-local.mjs`
- `scripts/verify-supabase-local.mjs`
- `scripts/web-local.mjs`
- `scripts/worker-local.mjs`
- `supabase/migrations/20261005175654_persistent_csv_review.sql`
- `supabase/README.md`
- `supabase/tests/review.local.mjs`
- `supabase/tests/security.test.mjs`
- `supabase/tests/upload.local.ts`
