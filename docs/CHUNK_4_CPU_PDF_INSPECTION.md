# Chunk 4 — durable CPU PDF inspection

Completed locally on 2026-10-08, from Windows HEAD `b496e41`. Read `AGENTS.md`
and inspected modified/untracked files before implementation. The interrupted
worktree contained catalogue mapping/review, hosted CSV restrictions and benchmark
fixtures, but no `inspect_pdf` job or inspection migration. Those existing changes
were preserved. No branch merge, commit, push or deployment was performed.

## Implemented backend

- One additive migration, `20261008182416_cpu_pdf_inspection.sql`, introduces
  `pdf_inspections` and a separately linked `inspect_pdf` queue kind. It depends
  on the existing migrations, including the two unpublished catalogue-review
  migrations; neither was recreated or edited.
- `enqueue_pdf_inspection(tenant, file)` requires actual owner/editor membership
  and a same-tenant, finalized private PDF. Advisory locking and a unique
  file/inspector-version constraint make repeated enqueue return the same job.
  Enqueue and job creation are atomic. Enqueue accepts no provider configuration.
- Existing claim, heartbeat, attempt, backoff and dead-letter mechanisms are
  reused. New service-only load/complete RPCs enforce tenant identity and live
  lease tokens. Identical completion can be retried by the original worker/token;
  changed results and stale workers are rejected. Successful evidence is immutable.
- Authenticated members can read only their tenant's inspection state/results.
  Anonymous access and client result writes are revoked. Inspection RPCs use the
  project's existing private-definer/public-invoker pattern with explicit grants,
  an empty search path and membership/lease authorization.
- The worker downloads the registered private object and verifies byte length
  and SHA-256 before parsing. Its separate isolated Python entrypoint accepts
  only `inspect_pdf`, imports no OCR provider, and receives no Supabase or OCR
  credentials. Unknown queue kinds fail rather than falling through to comparison.
- Results contain document page count plus page/state/reason/table-count
  diagnostics. No raw text, product records, monetary values or confidence claims
  are generated. A ruled rectangular table is only a `digital_candidate`; that
  is not verified extraction or commercial import eligibility. Missing embedded
  tables and unsupported merged structure produce `ocr_required` with no OCR call.

## Limits and failure behavior

Input limit: 10 MiB. Inspection supports at most **50 pages in the entire
document**, a stricter inspection bound than the existing extraction's 50-page
selection limit. Every accepted page is probed; larger documents fail explicitly
and must be split. The CPU probe uses the current ruled-table strategy only;
borderless tables may conservatively require OCR.

Each page is limited to 20,000 parsed objects, 100,000 text characters and 32
tables; each table to 2,000 rows, 32 columns and 64,000 cells. These parser-level
complexity limits are checked as data becomes available, not an OS memory quota.
The subprocess has a 60-second execution/input/output deadline and is killed on
timeout or heartbeat loss. Output reads are capped at 64 KiB, persisted results
at 32 KiB, and stderr is not exposed. Database validation requires complete,
ordered diagnostics for every page and a consistent summary state.

Integrity errors, corrupt/encrypted files and unsupported input/complexity limits
are terminal with safe failure messages. Transport errors and timeouts follow
the existing bounded retry policy (three attempts), then dead-letter. Scans are
successful inspections with state `ocr_required`, rather than repeatedly failed
extraction jobs. Inspection never creates comparison runs, extraction runs,
correction revisions or exports, and does not change pricing/allowances.

## Files changed for this chunk

New:

- `supabase/migrations/20261008182416_cpu_pdf_inspection.sql`
- `services/worker/src/stockshift_worker/extraction/pdf_inspection.py`
- `services/worker/src/stockshift_worker/entrypoints/pdf_inspection.py`
- `services/worker/src/stockshift_worker/jobs/inspection.py`
- `services/worker/tests/test_pdf_inspection.py`
- `supabase/tests/inspection.test.mjs`
- This report.

Updated: worker `jobs/gateway.py` and `jobs/runner.py`, the existing worker test
gateway's explicit comparison kind, the security test's RLS table count, and
`scripts/verify-supabase-local.mjs` to include inspection tests in native mode.
No UI, upload API, hosted capability, pricing or billing files were edited by
this chunk.

## Verification actually run

- `npm run check`: passed contract consistency, TypeScript checks, web/contracts
  tests, all 46 embedded PostgreSQL tests (32 existing security + 14 inspection),
  and production web build.
- Locked worker test suite: **400 passed, 2 skipped**. Existing skips concern
  image-column mutations on fixtures that have no image columns.
- Final focused CPU inspection suite: **24 passed**.
- Worker Ruff lint/format, repository Prettier checks, inspection-test Prettier
  check, credential-free CLI check, worker wheel/sdist build, and
  `git diff --check`: passed.
- The actual synthetic `old-catalogue.pdf` and `new-catalogue.pdf` each returned
  one page with `inspected`/`digital_candidate` through the CPU subprocess.
  The existing one-page Blindtex scan (`awkward-catalogue.pdf`) returned
  `ocr_required`. Those real results persisted through the migration's fenced
  completion RPC in embedded PostgreSQL with zero extraction/comparison side
  effects. These are structural inspection tests, not new OCR accuracy evidence.
- Tests cover duplicate enqueue, owner/editor versus viewer/outsider/anonymous
  access, forged metadata, tenant isolation and composite FKs, registered-object
  ownership, integrity/size failures, corrupt/encrypted PDFs, timeout, heartbeat
  loss, expired/replaced leases, retry/dead-letter behavior, completion conflicts,
  immutable results and malformed/incomplete/oversized diagnostics.

## Remaining blockers and boundaries

At the initial verification, Docker Desktop's Linux engine was unavailable. No migration was applied to a
native local Supabase instance; native PostgreSQL concurrency, live Auth/Storage
and HTTP worker integration remain unverified. Embedded PostgreSQL executed the
full migration chain and authorization/queue SQL; the worker tests used the real
CPU parser subprocess with a test gateway. Native verification is wired into
`npm run test:local` once the local stack has these migrations.

Upload finalization/enqueue integration and API/UI polling are deliberately left
for the next chunk. Hosted PDF uploads remain disabled. No hosted migrations,
OCR requests, GPU management actions or pricing/billing changes occurred. GPU
state was not queried in this offline task; no resume/start call was made.
No hosted-readiness or end-to-end customer workflow claim is made.

## Native follow-up verification

Docker's Linux engine is now reachable. Container labels verified the existing
`supabase_db_stockshift-local` database belongs to this checkout; PostgreSQL is
17.11 and checks connect only to loopback ports 54321/54322.

The database contained 251 Auth users, 218 tenants, 626 source files, 331 terminal
jobs and 578 Storage objects. No unfinished jobs existed. A full local database
backup was saved to the ignored `.tools/chunk4-native-before.sql` before changes.
The database was not reset. The local-only CLI wrapper now also allows exactly
`migration up --local` and its help command; linked/URL/hosted commands remain
rejected. Three pending migrations (the two catalogue-review migrations and CPU
inspection) applied to this verified local instance. Migration history is current
and `db lint --local` reports no schema errors.

The first native run found a test assertion reading the first job in the database
instead of the test job. Inspection assertions now scope service-role queries
to the test tenant/job, preserving correctness in a populated database. No worker
or schema defect was found. A new `inspection.local.ts` suite is included in
`npm run test:local` to exercise real Auth tokens, signed/private Storage uploads,
concurrent HTTP enqueue, competing PostgreSQL workers, expired-lease recovery,
stale completion rejection and the real CPU worker through the loopback gateway.
All worker subprocesses in this suite strip OCR configuration.

The new suite passed all four tests: old synthetic PDF with duplicate enqueue,
competing claims and lease recovery; new synthetic PDF; Blindtex scan; and a
deliberately mismatched SHA-256 on test-owned metadata. Both synthetic PDFs
persisted one-page digital candidates, Blindtex persisted `ocr_required`, and
integrity failure persisted only a terminal failure with null diagnostics.
Cross-tenant Storage downloads, inspection reads and enqueue were denied.
No extraction, comparison, correction or export rows were created for these
inspection fixtures. Existing data is retained; test suites add synthetic local
accounts, workspaces and blobs.

Final native command: `npm run test:local` exited successfully, **146 passed,
zero failed or skipped**:

| Suite | Passed |
| --- | ---: |
| Foundation authorization/RLS/Storage SQL | 32 |
| Durable queue and competing-worker SQL | 20 |
| Persistent review SQL | 16 |
| PDF queue/revision SQL | 15 |
| CPU inspection authorization/fencing SQL | 14 |
| CPU inspection Auth/Storage/concurrency/worker integration | 4 |
| OCR metadata/cache/usage SQL with synthetic payloads, no provider calls | 11 |
| Existing Auth/Storage/upload/CSV/XLSX/digital-PDF worker/export HTTP integration | 34 |

`npm run test:db` also passed all 46 embedded database regressions after the test
scoping fix. Both inspection test files passed Prettier, and `git diff --check`
passed. Local row fingerprints verified that all **7,066 pre-existing rows across
18 tables** remained unchanged throughout testing. The snapshot covers all public
tables plus Auth users and Storage object metadata; the full pre-migration database
dump remains available locally. Tests retained their newly created synthetic
fixtures, as the documented native workflow specifies.

Follow-up changes are limited to the inspection tests/new native integration
suite, the local CLI/verification wrappers, and local workflow/report documentation.
The applied schema and CPU worker required no defect fixes. No hosted Supabase
access, deployment, hosted PDF enablement, external OCR/provider call, GPU action,
billing change, commit or push occurred. API/UI integration remains outside Chunk 4.

Supabase guidance reviewed: [RLS grants and policies](https://supabase.com/docs/guides/database/postgres/row-level-security),
[database functions](https://supabase.com/docs/guides/database/functions), and the
[current Postgres security-release notice](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes).
The notice concerns legacy encryption, ltree/GiST indexes and custom operators;
none is introduced by this migration.
