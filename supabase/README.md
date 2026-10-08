# Local Supabase foundation

## Hosted CPU PDF code (Chunk 9; defaults off)

Hosted PDF support is implemented behind separate default-off inspection and
direct digital-extraction capabilities. This does not enable any hosted service.
The API requires a fresh matching advertisement from the existing CPU worker;
disabled/mixed worker profiles fail closed. All upgraded hosted workers advertise
their profile, including CSV-only workers. Apply the reviewed capability registry
migration before upgrading that worker, even when PDF flags remain off.

See [Chunk 9 configuration and local evidence](../docs/CHUNK_9_HOSTED_CPU_PDF_CODE.md)
for flag combinations, migration/worker rollout prerequisites and checks performed
with hosted-mode transports confined to native loopback. OCR remains disabled.

This checkout is **local only**. Do not link, push migrations, create a hosted
project, or use an existing access token, project ref, database password,
service-role key or remote connection string. No hosted project was accessed.

Before any future remote action, report the exact project name, project ref,
command, and whether it creates/alters/migrates/deletes remote resources, then
wait for explicit approval. No approval for remote operations is implied here.

## Reproduce locally

```sh
npm ci
npm run supabase:local -- --version
npm run supabase:local -- start
npm run supabase:local -- db reset --local
npm run supabase:local -- db lint --local
npm run supabase:local -- migration list --local
npm run test:db
npm run test:local
```

`start`/`reset`/`lint` require Docker Desktop or Podman. Reset affects the
`stockshift-local` local development database only. `npm run seed:local` creates a
synthetic local Auth account/workspace and prints local sign-in credentials. No real
users are seeded and public signup provisioning is outside this increment. See
[the local browser workflow](../docs/LOCAL_CSV_WORKFLOW.md) for web/worker startup.

The pinned CLI wrapper allows only specific local operations, strips credential
environment variables from child processes, fixes the workspace explicitly and
refuses a checkout containing a linked project ref. It rejects `link`, `db push`,
remote URLs/flags and remote migration commands. Create future local migration
files with `npm run supabase:local -- migration new descriptive_name`.

`npm run test:db`
executes all migrations in an isolated in-memory **PGlite PostgreSQL** instance,
using minimal fixture definitions of `auth.users`, `auth.uid`, Storage tables and
the Supabase API roles. It runs real SQL constraints, triggers, grants and RLS.
This checks application migrations and database authorization, but does **not**
verify the full Supabase Docker stack, Auth issuance, Storage HTTP/blob behavior,
or Supabase's own schema migrations. The fixtures are test-only, never production
migrations.

`npm run test:local` requires the running Docker-backed local stack with all local
migrations applied. Preserve an existing populated database: inspect its data and
migration history, then use `npm run supabase:local -- migration up --local` to
apply only pending migrations. Do not reset an existing database as a test prerequisite.
It runs the same 32 SQL security tests against PostgreSQL on `127.0.0.1:54322`,
without the embedded Auth/Storage bootstrap or reapplying application migrations.
Foundation SQL fixtures and per-case mutations are rolled back; job/HTTP fixtures
remain synthetic local data until reset. For Storage deletion assertions,
the suite first verifies Supabase's direct-delete guard, then uses the Storage API's
transaction-local delete flag to exercise RLS and the application immutability trigger.
It also runs native durable-job SQL tests and real Auth/Storage/Python integration,
including signed upload, SHA-256 finalization, retries, tenant isolation,
replacement/deletion rejection, the golden CSV corpus and abandoned-lease recovery.
Install the locked Python workspace first; the worker integration uses its `.venv`.
These tests leave synthetic local users, tenants and blobs; a local reset clears them.
The runner rejects linked checkouts, strips hosted credential variables, uses fixed
loopback connections, and obtains generated local keys from local CLI status only.
No credentials are printed or saved. PGlite is not used by this command.

Verified on October 5, 2026 with Docker Desktop and local PostgreSQL 17.11:
the Increment 3 reset/migration, 32 native SQL tests and eight HTTP tests passed, and
`db lint --local` reported no schema errors. No hosted project was accessed.
Increment 4 verification reset both migrations from scratch and passed 32 foundation
SQL tests, 20 durable-job SQL tests and 12 Auth/Storage/Python integration tests.
The native lint again reported no schema errors; all enabled local services were healthy.

Increment 5 adds `review_events`, append-only tenant/actor-scoped rejection and
unpaired no-match decisions, persisted-row summary/search RPCs and a tenant-authorized
export RPC. Native verification includes 16 review/security SQL tests and six more
HTTP export tests (18 HTTP integrations total). Unresolved reviews block export;
worker results remain immutable. Browser-only roles cannot insert/update/delete audit
events or approve unsupported matches. Only deterministic changed rows are exported.

## Schema and permission model

One migration creates exactly seven tables: `tenants`, `tenant_memberships`,
`suppliers`, `source_files`, `import_profiles`, `comparisons`, `comparison_files`.
Each tenant-owned resource carries `tenant_id`; resource associations use composite
tenant-aware foreign keys. All tables have UUID keys and creation timestamps.
Comparisons have one ready input per side. The second migration adds `jobs`,
`job_attempts`, `comparison_runs`, `comparison_results` and `match_candidates`.
All five add RLS, tenant-aware references and read-only tenant browser access.
Enqueue is constrained to current owner/editor membership; service-role worker RPCs
use tenant/worker/token checks. Neither browsers nor service-role clients have
direct mutation grants on these tables. See the worker guide for retry/lease semantics.

All seven tables enable RLS. Live database membership grants tenant reads to
owner/editor/viewer. Anon has no table access. Owner/editor may create/edit suppliers,
import profiles and comparison shells; column grants prevent identity/tenant/creator
edits. Viewers cannot write. Tenant-name edits require owner. There are no direct
client membership/source-file writes or delete grants.

`manage_tenant_member` permits only owners managing **other** registered users;
editors/viewers cannot self-promote, and owners cannot remove/demote themselves.
Tenant row locks serialize membership management, so concurrently demoting owners
cannot remove the remaining owner's membership through that operation. Initial
tenant/owner provisioning and account deletion remain administrative concerns.

RPC wrappers in public use `SECURITY INVOKER`. Their narrowly granted private
definer implementations use an empty search path and explicit actor/membership
checks. A private definer membership helper avoids recursive RLS. JWT user metadata
is never authorization data. The service role has table SELECT only for these
resources and access to the upload-transition RPC; it has no direct file or
membership write grants despite bypassing RLS.

## Private uploads

The `catalogue-uploads` bucket is private and limited to 10 MiB. Paths are generated
as `tenant_id/file_id/original`; filenames are stored separately. Storage SELECT
checks a registered path and current tenant membership. INSERT additionally requires
the registered creator to be a current owner/editor and the source to be pending.
Owner spoofing and arbitrary paths fail. No client UPDATE/DELETE policies exist.
Registered object mutation triggers also reject privileged metadata changes,
renames and deletes. Use Storage APIs for bytes, never direct Storage table writes.

`POST /api/uploads` is a thin server endpoint for a future client. Vite's development
server serves the shell only; it does not execute Vercel API functions. The service
functions can also be invoked directly in local server tests. No deployment is
performed. Requests require a Bearer token validated with Auth `getUser`, followed
by a fresh tenant membership lookup. Keys stay in `apps/web/server`; that directory
is never imported by the browser shell.

Server environment variable **names only** (see root `.env.example`):

- `STOCKSHIFT_LOCAL_SUPABASE_URL`
- `STOCKSHIFT_LOCAL_SUPABASE_PUBLISHABLE_KEY`
- `STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY`

The configured URL must be HTTP loopback on port 54321 with no credentials or extra
path. Standard `SUPABASE_*` variables are ignored. There are no secret `VITE_` vars.
Local keys are configured by the user from their new local stack; tests use
synthetic strings and mocked HTTP and do not load `.env`.

Create body: `{ "action": "create", "tenantId": "<uuid>", "filename": "file.csv",
"byteCount": 123, "supplierId": null, "importProfileId": null }`. Server/RPC
authorize the caller and create pending metadata, then sign the exact private path
**as the user** with `upsert: false`. No external URL or creator fields are accepted.
Signed upload capabilities are bearer secrets; do not log or share them. Their
expiry follows the pinned Storage SDK/API, rather than a claimed custom expiry.

Finalize body: `{ "action": "finalize", "tenantId": "<uuid>", "fileId": "<uuid>" }`.
The privileged transition rechecks tenant, registered creator, live editor role,
exact object, Storage owner and server-stored size. It locks the file and moves
pending → verifying with a private 120-second attempt lease. Server downloads only that registered path, checks actual
size, verifies supported UTF-8 CSV text and hashes the original bytes with SHA-256.
Only a valid server finish transaction marks ready and stores MIME/bytes/hash/time.
Ready retries are idempotent; pending/verifying/failed files cannot attach to a
comparison. Ready metadata and source ownership are immutable.

## Current limits

Only UTF-8 CSV uploads are accepted; source extension and text/binary gates define
the supported `text/csv` MIME policy. CSV has no unique magic signature: this is
not a claim of semantic catalogue validation. Direct Python parsing still owns
header mappings, locale/encoding support and record validation in the next workflow.
Client content-type/size/hash claims never establish readiness.

Full blobs are verified in memory (10 MiB cap). No resumable uploads, signed URL
refresh flow, quota accounting, cleanup or automatic upload-recovery worker exists.
A signing failure leaves an inert pending row. Invalid bytes become failed and
require a new intent. Transient verification errors release the current lease;
an interrupted process leaves a lease that expires after 120 seconds. The creator
with a current owner/editor membership can retry the same finalize request without
re-uploading. An active attempt returns HTTP 409; an expired attempt can be reclaimed.
Legacy verifying rows without leases can also be reclaimed. Five claims are allowed;
the next retry after expiry marks the source failed and requires a new upload.
Every attempt downloads and hashes the original bytes again. Claim and finish check
registered Storage ownership/size, and completion requires the current live token.
Stale finish/fail/release requests cannot change a newer attempt or a ready source.
Ready retries still recover PDF inspection enqueue gaps without extracting products.
The service-only eight-argument transition RPC includes `p_lease`; the legacy
seven-argument RPC supports begin/ready replay but rejects unfenced finish/fail.
See [Chunk 8 verification](../docs/CHUNK_8_UPLOAD_VERIFICATION_RECOVERY.md).
Administrators holding database-superuser/blob-storage credentials remain
trusted; application policies cannot constrain someone who disables those controls.

Official references used: [RLS and grants](https://supabase.com/docs/guides/database/postgres/row-level-security),
[private Storage authorization](https://supabase.com/docs/guides/storage/security/access-control),
[signed uploads](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl),
[server user validation](https://supabase.com/docs/reference/javascript/auth-getuser).

## XLSX extension

Migration `20261005184752_xlsx_ingestion.sql` permits verified ordinary XLSX MIME
paired with a `.xlsx` filename, alongside unchanged CSV validation. Storage remains
private with the same 10 MiB cap and immutable object policies. Enqueue/load accept
both structured formats; XLSX enqueue requires explicit format/worksheet/header
settings. All existing tenant references, RLS, role gates, lease tokens and atomic
completion semantics remain in effect. No new tables or browser mutation grants.
Real local integration tests cover XLSX signed uploads, authenticated discovery,
tenant denial, precise persisted results/provenance, review/export and terminal
formula errors without partial publication. The historic `*_csv_job` RPC names
remain stable for compatibility and now transport normalized CSV/XLSX jobs.

## Digital PDF extraction/corrections

Migration `20261005191747_digital_pdf_corrections.sql` adds tenant-owned
`extraction_runs` and append-only `correction_revisions`, expands the private upload
MIME/extension gate to PDF, and extends the existing fenced jobs with `extract_pdf`.
The job has exactly one comparison or extraction reference. Browser members can
read their tenant's extraction/revisions; only owner/editor enqueue/save RPCs may
create them. Browser direct mutation and worker claim/progress/completion are denied.
Worker paths revalidate tenant/source/lease ownership. Completed evidence and all
revision events reject update/delete even through privileged table access. Confirmed
revision references include both tenant and source in foreign keys.

`npm run test:local` now includes native PDF security/lease/revision checks and real
Auth/private Storage/Python PDF extraction/correction/comparison/export integration.
Keep using the guarded local commands and apply pending migrations with
`migration up --local` on an existing populated instance. Never link or push
migrations to a hosted Supabase project for this workflow.

## Local PDF inspection API

PDF upload finalization and persisted inspection reads require the server-only
`STOCKSHIFT_PDF_INSPECTION_ENABLED=1` opt-in. The default is off; hosted/Vercel
PDF uploads remain rejected. Native tests enable the capability only in their
local test process.

Finalization verifies bytes and idempotently enqueues the CPU inspection job.
If enqueue fails after byte readiness, retry finalization to recover without
re-uploading. `POST /api/pdf` reads authorized persisted inspection status/results;
it does not execute Python or initiate extraction, comparison or OCR. Byte
verification, inspection success and confirmed extraction remain separate gates.
See [the Chunk 5 report](../docs/CHUNK_5_PDF_UPLOAD_API_INSPECTION.md) for the response
contract, native checks and remaining UI integration work.
