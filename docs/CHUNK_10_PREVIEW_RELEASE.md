# Chunk 10 — reviewed local release and proposed Preview rollout

Prepared October 8, 2026. No push, hosted discovery, migration, deployment,
capability enablement, OCR request, GPU operation or billing change was performed.
This is a review candidate, **not approval to deploy**.

## Release boundary and preserved work

The exact changed-file inclusion/exclusion inventory and ordered migration hashes
are in [CHUNK_10_RELEASE_MANIFEST.json](CHUNK_10_RELEASE_MANIFEST.json).
Initial main had 45 modified files and 83 untracked files, with an empty index.
Ignored `.tools`, local environment files, `.vercel`, virtual environments, build
outputs, database snapshots and browser traces are excluded.

Local branch: `codex/preview-cpu-pdf-release`. Its base is
`65000541282060083cd8b32721cb80e2a0e0abab`, the earlier PDF/provider foundation.
It includes the direct digital extraction, correction, confirmation and comparison
dependencies already in that history. The OCR cache schema and provider abstraction
are dependencies of existing PDF RPCs/imports; their inclusion does not enable OCR.
The two later local GPU-serving commits `0131358` and `b496e41` are excluded from
release ancestry. Original main remains at `b496e41` and all working files are
preserved byte for byte. Switching branch/index for selective staging does not
check out, delete or reset working files.

Included changes cover upload integrity/fencing/recovery, CPU inspection queue and
worker, asynchronous API/UI, direct hosted CPU policy, hosted CSV gateway/daemon
prerequisites, local-only launchers, migration/security/integration tests and
Chunks 4–9 evidence. `catalogue_layout.py` and `mapped_pdf.py` are included because
the existing PDF subprocess imports them; hosted CPU routing rejects their use.
The two earlier catalogue migrations preserve the verified revision validation
and fail-closed source price-basis rules. These rules concern supplier source
semantics, not commercial pricing or subscription billing.

Excluded work includes all GPU-serving files/changes, OCR connection/diagnostic/
replay entrypoints and tests, unrelated offline catalogue fixtures/reports,
infrastructure/budget drafts and temporary rendered images. Only the synthetic
benchmark pair/CSV oracle and the one-page public Blindtex scan needed by the
CPU acceptance checks are included. The benchmark manifest is preserved in full;
its unrelated real-catalogue metadata is historical and those files are not
release test dependencies. No captured OCR responses are added.

Four mixed files are staged selectively: README and worker README contain release
instructions rather than excluded historical infrastructure/replay references;
the shared browser test keeps CSV/daemon/digital regression cases but excludes the
added catalogue replay suffix; CI keeps daemon `--check` smoke changes but excludes
the GPU-serving test block. Their full original working copies remain available.
The changed lockfile has no semantic Git diff and is excluded.
The release adds `.gitattributes` to keep PDF fixtures binary and retain the
already-verified trailing blank lines of the two dependency migrations without
editing their SQL. The commit includes 84 changed/new files.

## Baseline and Production compatibility blockers

Only cached Git evidence is available. Cached `origin/main` is
`7a14fbe09cc7aed025e2cc2ee6e12624c80df0d9`; original main is ahead three and behind
seven. The missing seven commits include hosted module fixes, onboarding,
inactive billing foundations, usage allowances and verified upload reuse. This
candidate does **not** replace those changes or establish the actual deployed
version. No fetch or merge was performed. Before any rollout, establish approved
Preview/Production app and worker commit identities and reconcile this release
with the intended deployed baseline in a separately reviewed integration. Do not
deploy this branch over the newer CSV app as though it were an up-to-date main.

Cached origin also contains four migrations absent from this candidate:
`20261007132615_customer_workspace_onboarding.sql`,
`20261007133637_stripe_billing_foundation.sql`,
`20261007135419_customer_usage_allowances.sql`, and
`20261007153016_workspace_allowance_status.sql`. They are outside this chunk;
their applied state and interaction with upload/job triggers must be established
before extending an existing database. Do not remove or replay them, edit
migration history, or assume a fresh schema accurately represents Production.

**Preview must use an isolated StockShift database and queue.** Vercel Preview
environment scope does not isolate a Supabase database. Applying these migrations
to a shared project affects Production immediately even with all PDF flags off.
If the proposed target is shared with Production, stop: it requires a separately
approved coordinated app/schema rollout and compatibility validation.

| Version combination                                   | Consequence                                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Old CSV API + Chunk 8 migration                       | Seven-argument begin/ready replay survives, but unfenced finish/fail is rejected; CSV finalization breaks |
| New API + pre-Chunk 8 database                        | Eight-argument lease RPC is missing; finalization fails closed                                            |
| New hosted worker + pre-Chunk 9 database              | Registry RPC is missing, including with flags 0/0; worker cannot poll normally                            |
| Old CSV worker + new queue schema                     | CSV signatures remain; an old consumer can claim and reject PDF jobs                                      |
| All new code + reviewed full schema + flags 0/0       | Verified local hosted-mode CSV path remains operational                                                   |
| Any mixed/missing/expired worker profile + PDF opt-in | PDF API/worker rejects processing; CSV does not require advertisement agreement                           |

The lease migration deliberately does not restore unsafe unfenced completion.
Migration-first is safe only on an isolated Preview with old finalizers quiesced
until its compatible API is deployed. Flags cannot fix the old CSV API conflict.

## Ordered migration review

Hosted applied history is **unknown**, so these are candidate prerequisites,
not a claim that eleven migrations are pending there. Apply only verified missing
versions, in this order, matching the committed-byte hashes in the manifest.
Five migrations are newly included in the release commit; six already exist in
the base. No SQL was edited or duplicated during preparation.

| Order/version                                             | Purpose and compatibility effect                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 `20261005141354_tenant_upload_foundations`              | Tenant/RLS/private Storage and upload RPCs; initial schema, never replay on an existing database                                            |
| 2 `20261005155832_durable_csv_jobs`                       | CSV runs/jobs/attempts/results; leased claim/load/complete/fail RPCs                                                                        |
| 3 `20261005175654_persistent_csv_review`                  | Immutable review events and authorized review/export gates                                                                                  |
| 4 `20261005184752_xlsx_ingestion`                         | Broadens source constraints and replaces comparison enqueue/load functions; preserves CSV signatures                                        |
| 5 `20261005191747_digital_pdf_corrections`                | Adds PDF extraction/revision relationships; changes queue constraints and claim/fail/load functions; CSV signatures remain                  |
| 6 `20261005220000_paddleocr_pages`                        | Private cache and PDF provider/revision RPC foundations; no network/model execution; OCR remains disabled                                   |
| 7 `20261006194510_catalogue_layout_review` **new**        | Replaces PDF enqueue/revision validators, retaining direct digital configuration and review rules                                           |
| 8 `20261006203229_catalogue_pricing_basis_review` **new** | Replaces revision validation; retail/unresolved supplier cost basis cannot be confirmed                                                     |
| 9 `20261008182416_cpu_pdf_inspection` **new**             | Adds inspection evidence and job relationship; replaces shared claim/fail functions and job-kind constraint; existing CSV signatures remain |
| 10 `20261008194938_upload_verification_recovery` **new**  | Adds private 120-second, five-attempt upload leases and eight-argument RPC; old unfenced finish/fail intentionally breaks                   |
| 11 `20261008201320_hosted_cpu_pdf_capabilities` **new**   | Private worker registry and service-only RPCs; required before every upgraded hosted worker, including disabled profiles                    |

DDL takes locks on shared tables/constraints and replaces globally used functions.
Existing rows must satisfy source/job constraints. Preserve a restorable backup,
inventory active jobs/uploads and validate the exact baseline on a separate test
instance before applying anything. Additive tables have RLS/explicit grants;
authenticated users cannot register workers or publish inspection results.
No bulk rewrite/delete of existing source or result rows is introduced by the
three new Chunk migrations. Runtime recovery can mark exhausted uploads failed;
queue claim can expire/dead-letter jobs under existing bounded lease rules.

## Proposed rollout sequence — future approval required

0. Establish the exact release commit after baseline reconciliation, dedicated
   Preview project identity, existing migration ledger, app/worker versions and
   backup/restore plan. Verify no Production connection or consumer shares it.
   If a CPU host is absent, report provisioning as a separate dependency; the
   existing Docker worker needs no new application service, Redis, disk or GPU.
   Stop any old Preview finalizers and drain old queue consumers gracefully.
1. **Migrations:** apply only approved missing versions above to that verified
   isolated target. Check actual function signatures, grants, RLS, constraints
   and private registry, with PDF flags still 0/0 and OCR 0. Wait for schema-cache
   refresh. Do not run database reset or the loopback-only local launcher here.
2. **CPU worker:** build the reviewed worker image from the same release commit;
   pin its resulting digest, run non-root with hosted configuration and PDF flags
   0/0. Use normal daemon entrypoint, not `--check`/`--once`. Verify graceful drain,
   successful CSV jobs and fresh 0/0 advertisements. Upgrade **every** consumer;
   an unadvertised legacy process is not detected by registry agreement.
3. **Vercel Preview:** deploy that same commit with all PDF flags 0/0. Root
   `apps/web`, Node 22.x/npm 10, Vite build and `dist`; allow workspace packages
   outside root. Check browser/API project/key agreement, Auth, private Storage,
   fenced CSV upload/retry, compare/review/export and authorization isolation.
   Do not alter Production environment scope or promote this deployment.
4. **Capability enablement:** after explicit rollout approval, move all workers
   to inspection 1/extraction 0 first. Drain/restart consistently; let old profiles
   expire (120 seconds) and verify agreement. Rebuild/redeploy Preview with matching
   server/browser 1/0 flags and prove inspection-only review gates. Then, if
   accepted, repeat workers-first and Preview rebuild with 1/1. A 0/1 profile is
   invalid. Recheck advertisements immediately before PDF uploads. Never set OCR 1.
5. **Acceptance:** use real approved Preview Auth/Storage/CPU worker, not mocked
   responses. Verify synthetic old/new upload → inspection → explicit digital
   extraction → review/correct → confirm → compare → export. Match all six outcomes,
   exact price strings/leading-zero IDs and three export rows. Repeat documented
   `00042` correction 4.20→5.25, reopen and verify unchanged outcome/two export rows.
   Test Blindtex `ocr_required`, unavailable extraction/comparison/export and zero
   OCR requests; inspection alone must never bypass confirmation. Exercise repeated
   finalization, lost enqueue response/recovery, stale lease rejection, tenant
   isolation, disabled capabilities and desktop/mobile return/poll behavior.

## Configuration scopes and advertisement checks

| Setting                                                                                           | Required scope/value                                                                      |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `STOCKSHIFT_SUPABASE_MODE`                                                                        | Vercel Preview API and every CPU worker: `hosted`                                         |
| `VITE_STOCKSHIFT_SUPABASE_MODE`                                                                   | Preview browser build: `hosted`                                                           |
| `STOCKSHIFT_SUPABASE_URL` / `VITE_STOCKSHIFT_SUPABASE_URL`                                        | Identical approved isolated `https://<ref>.supabase.co` origin; browser value is public   |
| `STOCKSHIFT_SUPABASE_PUBLISHABLE_KEY` / `VITE_STOCKSHIFT_SUPABASE_PUBLISHABLE_KEY`                | Identical public key in Preview API/build; worker does not require it                     |
| `STOCKSHIFT_SUPABASE_SECRET_KEY`                                                                  | Preview API and CPU worker secret storage only; never `VITE_`, logs or Git                |
| `STOCKSHIFT_RUNTIME`                                                                              | CPU worker: `production` (image default)                                                  |
| `STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED`                                                        | Preview API and every worker: start `0`, approved stages `1`                              |
| `STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED`                                                        | Preview API and every worker: start `0`, then approved digital stage `1`                  |
| `VITE_STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED` / `VITE_STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED` | Preview build: exactly mirror API; changes require rebuild/deployment                     |
| `STOCKSHIFT_OCR_ENABLED`                                                                          | API and all workers: explicitly `0`; hosted validation rejects opt-in                     |
| `STOCKSHIFT_CSV_ONLY` / `VITE_STOCKSHIFT_CSV_ONLY`                                                | May be `1` for disabled CSV profile; remove or `0` before PDF stages, since `1` conflicts |
| `STOCKSHIFT_PDF_INSPECTION_ENABLED`                                                               | Local-only server capability, default `0`; does not enable hosted PDFs                    |
| OCR endpoint/token/replay configuration                                                           | Absent from this rollout; no OCR provider fallback                                        |

Each upgraded worker calls service-only `register_cpu_pdf_worker` at most every
30 seconds, including during long-job heartbeats and when profile is 0/0. Records
expire after 120 seconds. Confirm observed worker UUIDs correspond to the complete
deployment inventory, refresh over at least two intervals, and contain the exact
desired pair. `cpu_pdf_workers_agree(p_inspection,p_extraction)` must return true
for enabled inspection profiles: at least one live worker and every live record
matches. It deliberately returns false for disabled inspection, so 0/0 readiness
requires inspecting fresh disabled advertisements and CSV processing instead.
Use privileged read-only inspection only during separately approved rollout;
browser clients must be denied both registry RPCs. Never treat registry agreement
as proof that an old unadvertised consumer is gone.

## Stop conditions and rollback

Stop for shared Production database/queue, unknown or divergent migration history,
unreconciled deployed baseline, invalid existing constraints, failed backup,
missing registry RPCs, legacy consumers, stale/mixed advertisements, mismatched
browser/API flags/origins/keys, authorization leakage, stale verification publish,
unexpected provider routing/OCR traffic, review bypass, incorrect exact results,
CSV regression or worker resource/timeout failures. Do not enable capabilities
merely because a deployment builds successfully.

On failure, withdraw Preview traffic or redeploy the compatible new API/browser
with flags 0/0 first; in-flight PDF work may already exist, so disable/drain workers
under the incident plan and let leases expire naturally if interrupted. Restart
all workers with flags 0/0, confirm old advertisements expire, and verify CSV.
Keep additive schema/evidence/data; do not drop tables, reset, delete queues or
rewrite applied migrations. Do not roll back the API to the old seven-argument
finalizer while the lease migration remains. If the worker is rolled back, keep
PDF entrypoints off and ensure no PDF job can be claimed by a legacy consumer;
otherwise keep the upgraded disabled worker or stop consumers. Schema restore or
forward repair requires separate approval and coordinated traffic quiescence.
OCR remains disabled and the GPU remains paused throughout.

## Verification evidence and limits

Reuse [Chunk 9 evidence](CHUNK_9_HOSTED_CPU_PDF_CODE.md): 168 native local checks,
189 web/contract/embedded SQL tests, 96 focused Python tests, typecheck/build,
database lint, formatting and six real browser acceptance cases passed. All 9,489
pre-existing rows were unchanged. No database or browser acceptance rerun is
needed solely for this documentation/staging task.

Release-only selection created a packaging concern, so the staged tree was
materialized independently of excluded working files. Targeted checks actually run:

- Contracts generation check and workspace typecheck passed.
- 89 web and 54 contract tests passed; all 46 embedded SQL tests passed.
- Staged-tree Vite production build passed.
- Worker source distribution/wheel built offline from the staged files; locked,
  hash-checked runtime dependencies and the wheel installed into a fresh local
  environment using only the existing cache. Credential-free installed-wheel
  `stockshift-worker --check` and all 96 focused CPU Python tests passed.
- All eleven migration hashes match committed LF bytes; all three PDF fixture
  blobs match their original bytes. Staged whitespace and targeted formatting
  checks passed. Scope/private-key-token scan covered all 186 release-tree files.
- All 128 initially modified/untracked files retain their original SHA-256 hashes;
  main retains its original commit. No local database operation was needed.

The first attributes edit replaced existing LF rules, causing Windows CRLF
conversion in the disposable snapshot and failing strict generated-text checking.
The edit was corrected to retain the existing LF/PNG rules and add only PDF and
dependency-migration attributes; the snapshot was rematerialized with committed LF
bytes. Three embedded tests initially lacked the snapshot's Python interpreter;
they passed after configuring that disposable tree to use the separately installed
release wheel. These were snapshot setup issues; no application or migration fix
was made. Native database/browser checks from Chunk 9 were reused, not rerun.
No actual hosted compatibility, image deployment, identity, migration ledger or
provisioned worker has been established.

Release blockers remain baseline reconciliation, approved isolated Preview
infrastructure/configuration, hosted migration/worker/API rollout and real hosted
acceptance. Administrative verifying recovery is now implemented and locally
verified in Chunk 8; its deployment remains pending. OCR processing is intentionally
disabled and is not a prerequisite for this digital-only release.
