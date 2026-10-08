# Chunk 13 — isolated Preview infrastructure audit

Read-only audit on October 8, 2026. Release worktree:
`C:/Users/Rob/WebstormProjects/stockshift/.tools/chunk11-reconcile`, branch
`codex/preview-cpu-pdf-release`, commit
`82fcaa29b20f8066702b29c4d0b6f34131837b4a`. AGENTS.md and the Chunk 12 rollout plan
were read. This report is a local artifact, not rollout authorization. The release
commit, manifest, code and existing worktrees were not modified.

## Verified source and resource inventory

| Resource                                  | Verified identity and current state                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub                                    | Public repository [stopinder/stockshift](https://github.com/stopinder/stockshift), repository ID `1405467470`; remote `main` is `7a14fbe09cc7aed025e2cc2ee6e12624c80df0d9`.                                                                                                                                                                                                                                                 |
| Local release                             | `82fcaa2`; exact release branch lookup returns no remote branch. The release is not published.                                                                                                                                                                                                                                                                                                                              |
| Vercel                                    | Project `stockshift`, `prj_YOILRLj6WEsJWXCKYMB0eStUYaja`, team `stopinders-projects`, `team_iCIcaRV1Yllh7i91md1XI6md`. Vite, project Node setting **24.x**, deployment protection enabled for all except custom domains. Root/install overrides are not exposed by the returned project metadata.                                                                                                                           |
| Latest Production-target deployment       | READY `dpl_CxKkEQFMhQiER6DreDj2YBR7jz1z`, [deployment](https://stockshift-fruaburqt-stopinders-projects.vercel.app), source `main` at **`7a14fbe`**. `stockshift-navy.vercel.app` and the `git-main` alias point here.                                                                                                                                                                                                      |
| Custom Production domain                  | `stockshift.co` points to READY `dpl_4ZV6yqQfQ11pVHbXr46R2TAYMpLp`, also **`7a14fbe`**, rather than the latest Production deployment ID.                                                                                                                                                                                                                                                                                    |
| Latest Preview / customer-allowance alias | READY `dpl_GGSDVrNvdHdcaL9KhJfN7HSvM63R`, [deployment](https://stockshift-a2r892d5z-stopinders-projects.vercel.app), source `codex/customer-allowance` at **`1423916cbc1d0b4f5e2e858f62747edcc6882d71`**. Target is null/non-Production. Its branch alias points to this deployment.                                                                                                                                        |
| Other Vercel aliases                      | The CSV frontend branch alias points to `36a3d97` (`dpl_HRNE9b2BMqSYDXvTcy6oAi6K7VHJ`). `stockshift-stopinders-projects.vercel.app` still points to older `16705f7` (`dpl_8NrdtdYTnjWExjATS4dRt9GQVs61`). These are distinct from current Production/custom-domain routing.                                                                                                                                                 |
| Shared Supabase                           | Project **StockShift**, ref **`eahpcvoeichpyvwzklfg`**, organization `fcnxkkyfpfcieevhzaeg` (**Free**), `eu-west-1`, ACTIVE_HEALTHY, PostgreSQL `17.11.0.003`. Development branch list is empty.                                                                                                                                                                                                                            |
| Render workspace                          | User confirmed **helios**, `tea-db2uufqd0e5s73ehlbjg`, for read-only audit.                                                                                                                                                                                                                                                                                                                                                 |
| Live CPU/CSV worker                       | [stockshift-csv-preview-worker](https://dashboard.render.com/worker/srv-db2vpj60tbcc7387ql3g), service `srv-db2vpj60tbcc7387ql3g`. Docker background worker, Frankfurt, **one `0.5c-512mb` instance**, not suspended. Auto-deploy and PR previews off. Repository `stopinder/stockshift`, branch `codex/csv-preview-worker`. Live deploy `dep-db30rjbtqb8s73dpon70`, source **`b53f53a62fbc9f1ea548b4fb04ef618c28cf7f5e`**. |
| Other Render service                      | `stockshift`, `srv-db2v8did0e5s73eilaeg`, is a **suspended** Node web service in Oregon, `main`, auto-deploy enabled, Node build with `stockshift-worker` start command. It is not a suitable replacement for the Docker background worker. It was not resumed or changed.                                                                                                                                                  |

Deployment commits and aliases were checked separately: a newest READY deployment
does not establish where every domain routes. GitHub comparison confirms the
current Preview is two commits ahead of `7a14fbe`: `afb645e` and `1423916`. Their
17 changed files include billing API/UI, workspace creation, allowance projection,
styles, tests and `20261008141550_business_workspace_creation.sql`. Those changes
are absent from `82fcaa2`. See the [exact comparison](https://github.com/stopinder/stockshift/compare/7a14fbe09cc7aed025e2cc2ee6e12624c80df0d9...1423916cbc1d0b4f5e2e858f62747edcc6882d71).

## Isolation and safely observed capabilities

**Current Vercel Production and Preview share backend configuration.** Both
`STOCKSHIFT_SUPABASE_URL` and `VITE_STOCKSHIFT_SUPABASE_URL` are the same plain
configuration value, `https://eahpcvoeichpyvwzklfg.supabase.co`, each scoped to both
Production and Preview. Both modes are `hosted`. The server secret entry is also
scoped to both; its value was not decrypted or printed. No branch-specific
Supabase override appeared in the complete environment metadata response.

The customer-allowance Preview branch has additional billing-specific overrides,
including plain `STOCKSHIFT_BILLING_ENABLED=1`. They were not changed. PDF capability
variables are absent from the current project environment inventory; this is not
evidence of enabled processing. Current environment configuration is verified,
but historical effective build environment snapshots were not independently
reconstructed by running either deployed application.

The shared hosted database accepts only `kind='reconcile_csv'`. Read-only catalogue
queries confirm:

- `pdf_inspections`, `extraction_runs` and `private.cpu_pdf_workers` are absent.
- The seven-argument upload finalizer exists; the eight-argument leased finalizer
  and `register_cpu_pdf_worker` do not.
- `bound_workspace_comparison` still charges every accepted job without a kind
  filter. New PDF kinds cannot currently enter this schema.
- Newer `require_paid_workspace_upload` / `require_paid_workspace_job` triggers
  and `private.require_workspace_subscription` are installed. The database has
  `create_business_workspace(text,uuid,boolean)`, trial-claim/request tracking and
  the newer allowance wrapper; these are absent from the release baseline.

The live Render worker's deployed source has `csv_only()` return true in hosted
mode and lacks Chunk 9 worker advertisement/CPU inspection support. Resource
metrics show one live instance, about 33–34 MiB recent memory usage and a 512 MiB
limit. This is idle/CSV evidence, not a PDF capacity benchmark.

**Worker sharing is not fully observable.** The connected Render tools do not
provide a read-only environment-variable listing. Its Supabase target, effective
runtime flags, credentials and additional consumers outside this workspace were
not inspected. There is one observed live StockShift worker, not one verified
consumer per environment. Since the web environments share a database/queue,
they cannot be regarded as worker-isolated. If this worker points to that project,
it consumes work from both environments; that final mapping remains unverified.
No worker was invoked and no live job or customer row was read or changed.

## Applied hosted migration versions

The shared project's actual ledger contains these **eight** versions:

| Version          | Name                          | Release comparison                                                 |
| ---------------- | ----------------------------- | ------------------------------------------------------------------ |
| `20261005141354` | tenant_upload_foundations     | Same version/name as release.                                      |
| `20261005155832` | durable_csv_jobs              | Same version/name as release.                                      |
| `20261005175654` | persistent_csv_review         | Same version/name as release.                                      |
| `20261007134233` | customer_workspace_onboarding | Release uses `20261007132615`.                                     |
| `20261007134242` | stripe_billing_foundation     | Release uses `20261007133637`.                                     |
| `20261007140327` | customer_usage_allowances     | Release uses `20261007135419`.                                     |
| `20261007160303` | workspace_allowance_status    | Release uses `20261007153016`.                                     |
| `20261008142412` | business_workspace_creation   | Missing from release; Preview source filename is `20261008141550`. |

Ledger statement fingerprints were read without retrieving statement bodies.
Same-name/different-version migrations are **not established as byte-equivalent**.
This is not an instruction to replay the sixteen release migrations into this
database. That would risk duplicate definitions, overwrite newer workspace policy
and introduce the old-finalizer incompatibility into Production. An upgrade of
this existing shared project requires a separate baseline/history reconciliation.

## Existing resources suitable for a separate Preview

The existing **StockShift Free organization** is a candidate container for a new,
separate project; the current StockShift project is unsuitable because Production
already uses it. No existing isolated StockShift database was found. The generic
Supabase project/organization listings omit StockShift even though direct reads
of its ref and organization succeed. Therefore listings are incomplete and a
second Free slot cannot be inferred from them.

The visible **Mindworks Pro organization**, `fnndieicfcjsjikxyyqd`, is a paid
fallback container for a new isolated project. Its Mindworks and Platform projects
are unrelated and are not candidates to repurpose. Render's existing helios
workspace can contain a second CPU worker without changing the existing worker.
The existing Vercel team can contain a dedicated project. An exact search found no
`stockshift-cpu-pdf-preview` Vercel project; name/creation eligibility still requires
confirmation at provisioning time.

## Proposed resource and configuration plan — not executed

1. **Source boundary first.** Keep `82fcaa2` as the audited candidate. Before any
   rollout, explicitly decide whether this separate PDF acceptance environment
   tests that candidate or needs a separately reviewed merge of `1423916` first.
   Do not silently replace the existing billing/business Preview or alter its
   subscription policy. A changed candidate requires an updated manifest and
   relevant verification.
2. **Supabase:** proposed new project `stockshift-cpu-pdf-preview`, preferably in
   StockShift Free organization `fcnxkkyfpfcieevhzaeg`, region `eu-west-1`, PostgreSQL 17. Confirm Free eligibility before creation. Use fresh Auth/Storage/database
   and synthetic-only accounts/data. Do not clone Production users, blobs or
   subscription rows. New project ref/keys are unavailable until provisioning.
   If no Free slot is available, stop for cost approval; use a new Micro project in
   Mindworks Pro only after that approval. Do not upgrade the existing Free
   organization, move projects or provision a paid branch implicitly.
3. **CPU worker:** proposed new Render background worker
   `stockshift-cpu-pdf-preview-worker` in helios, Frankfurt, Docker runtime,
   `0.5c-512mb`, exactly one instance, auto-deploy/PR previews off. Build the release
   `services/worker/Dockerfile` with context `services/worker`, root directory empty,
   default `stockshift-worker` daemon command, non-root UID 10001. Pin the exact
   release commit and resulting image digest. No Render database, Redis, persistent
   disk, public web port, GPU or OCR configuration is needed. Measure PDF peak
   memory and processing time in acceptance; stop for a revised capacity/cost plan
   if 512 MiB is insufficient. Do not resize automatically.
4. **Web/API:** proposed dedicated Vercel project `stockshift-cpu-pdf-preview` in
   `team_iCIcaRV1Yllh7i91md1XI6md`, Vite, root `apps/web`, **Node 22.x / npm 10**,
   workspace access outside root enabled, `npm ci`,
   `npm run build --workspace @stockshift/web`, output `dist`, committed API-aware
   rewrites. Target deployments to **Preview** only. Keep deployment protection;
   test through a signed-in browser rather than creating share/bypass credentials.
   Do not reuse existing project-level Supabase/billing environment entries or any
   Production alias. Record actual Preview project ID/deployment/URL after creation.
5. **Source publication prerequisite:** the release branch is currently local.
   Do not push it without separate authorization and an automatic-deployment check:
   existing Vercel Git integration can build new branches with the shared backend.
   Before an approved branch push, arrange a separately approved, project-specific
   exclusion for this branch on the existing shared Vercel project. Alternatively,
   publish an approved immutable worker image and manually deploy the local pinned
   source only to the new Vercel project; no Git branch push is required in that
   path. Artifact/registry publication and all deployments remain future actions.
   Render must consume the reviewed release code/image, not the current `b53f53a`
   branch. Stop if that source identity cannot be pinned.

Future secret installation belongs in the **new** providers' secret stores only.
The operator must supply the new project's server key without exposing it in Git,
logs or this report. Browser/API use matching public keys from that same project.
Never inherit the existing project's secret, Stripe configuration or environment
groups. Configure new Supabase Auth site/redirect URLs to the actual approved
Preview origin/branch alias, with email confirmation and the existing private
`catalogue-uploads` bucket policy. Do not add Production redirects or domains.

| Setting                                            | New Preview API                       | New Preview browser build    | New CPU worker                |
| -------------------------------------------------- | ------------------------------------- | ---------------------------- | ----------------------------- |
| `STOCKSHIFT_SUPABASE_MODE`                         | `hosted`                              | —                            | `hosted`                      |
| `VITE_STOCKSHIFT_SUPABASE_MODE`                    | —                                     | `hosted`                     | —                             |
| `STOCKSHIFT_SUPABASE_URL`                          | New isolated HTTPS origin             | —                            | Same new origin               |
| `VITE_STOCKSHIFT_SUPABASE_URL`                     | —                                     | Same new origin              | —                             |
| `STOCKSHIFT_SUPABASE_PUBLISHABLE_KEY`              | New project's public key              | —                            | Not required                  |
| `VITE_STOCKSHIFT_SUPABASE_PUBLISHABLE_KEY`         | —                                     | Same public key              | —                             |
| `STOCKSHIFT_SUPABASE_SECRET_KEY`                   | New project secret store only         | **Absent**                   | New project secret store only |
| `STOCKSHIFT_RUNTIME`                               | `production`                          | —                            | `production`                  |
| `STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED`         | Start `0`, approved stages `1`        | —                            | Matching `0` then `1`         |
| `STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED`         | Start `0`, approved digital stage `1` | —                            | Matching `0` then `1`         |
| `VITE_STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED`    | —                                     | Match API; rebuild on change | —                             |
| `VITE_STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED`    | —                                     | Match API; rebuild on change | —                             |
| `STOCKSHIFT_CSV_ONLY` / `VITE_STOCKSHIFT_CSV_ONLY` | `0`                                   | `0`                          | `0`                           |
| `STOCKSHIFT_OCR_ENABLED`                           | Explicit `0`                          | —                            | Explicit `0`                  |
| `STOCKSHIFT_PDF_INSPECTION_ENABLED`                | `0` (local-only flag)                 | —                            | Not required                  |
| `STOCKSHIFT_BILLING_ENABLED`                       | `0`                                   | —                            | Absent                        |
| Stripe keys/webhook/price/portal configuration     | Absent                                | Absent                       | Absent                        |
| OCR endpoint/token/replay variables                | Absent                                | Absent                       | Absent                        |

Flags progress **0/0 → 1/0 → 1/1**, workers first at each separately approved
enabled stage, then Preview rebuild. `0/1` is invalid. No capability was changed
during this audit. New Preview billing stays inactive; existing deployed billing
is untouched.

## Exact migration → worker → web → enablement sequence

Only the new verified isolated database receives the candidate's full sixteen-file
chain, in this order, with hashes from `CHUNK_10_RELEASE_MANIFEST.json`:

```text
20261005141354_tenant_upload_foundations.sql
20261005155832_durable_csv_jobs.sql
20261005175654_persistent_csv_review.sql
20261005184752_xlsx_ingestion.sql
20261005191747_digital_pdf_corrections.sql
20261005220000_paddleocr_pages.sql
20261006194510_catalogue_layout_review.sql
20261006203229_catalogue_pricing_basis_review.sql
20261007132615_customer_workspace_onboarding.sql
20261007133637_stripe_billing_foundation.sql
20261007135419_customer_usage_allowances.sql
20261007153016_workspace_allowance_status.sql
20261008182416_cpu_pdf_inspection.sql
20261008194938_upload_verification_recovery.sql
20261008201320_hosted_cpu_pdf_capabilities.sql
20261008213000_comparison_job_allowance_accounting.sql
```

The OCR-cache migration supplies existing RPC/schema dependencies; it enables no
provider. The newer hosted business-workspace migration is deliberately not in
this candidate chain; adding it requires prior source/policy reconciliation.

Before applying anything, record new project identity, empty/expected history,
backup and exact release hash. Apply only missing approved versions; never reset
a populated database. Verify grants/RLS, private Storage, eight-argument finalizer,
worker registry and comparison-only trigger, then wait for schema-cache refresh.
Deploy the pinned new worker at 0/0 and verify fresh disabled advertisements and
CSV operation. Deploy the same pinned web/API candidate at 0/0 and verify Auth,
upload/retry/review/export, tenant isolation and capability-disabled rejection.

For approved 1/0 and 1/1 stages, drain/restart only the new worker, let previous
advertisements expire, then rebuild Preview to match. In the new database,
service-only worker registrations refresh at most every 30 seconds and expire
after 120. Observe at least two refreshes, match worker UUIDs to the complete new
consumer inventory, and check `cpu_pdf_workers_agree` for the intended enabled
pair. At 0/0 that agreement function is intentionally false; inspect fresh disabled
records and CSV readiness instead. Never treat registry agreement as proof that
an old, unadvertised consumer is absent. The old Render worker must never receive
the new project credentials or new queue.

## Expected additional costs — estimates, USD before tax

Public prices were checked today; Render's dynamic pricing table was also read
in the browser. These are incremental infrastructure estimates, not invoice totals
or accepted charges.

| Database choice, with one new `0.5c-512mb` worker                 | Database addition | Worker addition | Additional baseline |
| ----------------------------------------------------------------- | ----------------: | --------------: | ------------------: |
| Separate Free project, if eligible                                |          $0/month |        $7/month |        **$7/month** |
| Separate Micro in existing Mindworks Pro organization             |   About $10/month |        $7/month | **About $17/month** |
| New paid organization with one Micro, only if separately approved |    From $25/month |        $7/month |  **From $32/month** |

A worker capacity increase to `1c-2g` would cost **$25/month**, an additional $18
over the smallest worker; it is a fallback estimate, not a selected upgrade.
The existing live worker's compute remains a separate ongoing cost. Render
background workers have no Free compute tier. No additional Render workspace
upgrade is required for one separately configured worker; the actual helios plan,
credits and invoice were not exposed. See [Render pricing](https://render.com/pricing)
and [supported worker plans](https://render.com/docs/compute-plans).

Supabase Free allows two active projects, can pause after an inactive week, and
includes 500 MB database, 1 GB Storage and limited egress. Free-slot eligibility is
unverified because connector listings are incomplete. A new project in the Pro
organization adds compute rather than another organization subscription; existing
organization credits are not assumed unused. See [Supabase pricing](https://supabase.com/pricing).

A separate Vercel project using the existing team/seat is expected to add no fixed
project/seat fee; builds, functions and transfer still consume shared usage and
may add charges. The connector did not expose the current team plan/usage/credits;
the earlier Pro record is historical, not current invoice verification. The Pro
public platform fee is $20/month with one deploying seat included; do not count a
second such fee merely for a second project. See [Vercel Pro pricing](https://vercel.com/docs/plans/pro-plan).
Do not alter spend caps, plan selections, seats or billing settings in this audit.

## Hosted acceptance and rollback plan

Acceptance uses real new Preview Auth/Storage/CPU worker at desktop and mobile
widths. Run the synthetic pair through upload → CPU inspection → explicit digital
extraction → inspect/correct → confirm → compare → export. Match all six outcomes,
exact price strings, leading-zero identifiers and three export rows. For a fresh
non-exempt trial, allowance stays 3 through both confirmations and becomes 2 after
one comparison. Repeated enqueue/retries must charge once; competing comparisons
must respect limits. Exercise correction `00042: 4.20 → 5.25`, reopen, confirm the
persisted correction and expected unchanged classification/two-row export.

Blindtex must stop at persisted `ocr_required`, including after reopening, without
extraction/comparison/export eligibility or any provider request. Also test
inspection-only and disabled modes, unauthorized/cross-tenant access, repeated
finalization, interrupted enqueue/verification recovery, concurrent and stale
finalizers, lease replacement, return/sign-out/stale-response handling and CSV
regressions. Capture actual source/image/deployment identities, migrations,
advertisements, results/exports and no-OCR evidence. Chunk 12's six browser cases
and 170 native checks are prior local evidence; no hosted acceptance ran here.

Stop for shared project credentials/queue, wrong source/image, unapproved newer
baseline, unverified history, mixed/missing advertisements, API/browser mismatch,
OOM/timeout, authorization leakage, stale completion, review bypass, allowance or
exact-result regression, or any OCR route. No Production alias promotion is part
of this Preview acceptance.

Rollback withdraws only the new Preview traffic, restores the compatible release
API/browser with flags 0/0, drains current new-worker leases and restarts it at
0/0; wait for prior advertisements to expire and verify CSV. Preserve the new
database, migrations, evidence and comparison-only trigger. Never revert to the
old seven-argument API with leased schema, reset/delete data, replay migrations,
restore the all-job accounting trigger, or send work to the legacy consumer.
If the compatible disabled deployment is unavailable, stop new traffic/consumers
pending forward repair. Existing Production and billing Preview resources remain
outside this rollback. Resource deletion, billing changes and database restore
require a separate request.

## Unavailable facts and audit boundaries

- Current Free creation quota/permissions, exact creation quotes, provider invoices,
  account credits/spend usage, Render workspace tier and Vercel team tier.
- Render worker's database origin/effective environment, deployed image digest,
  other consumers outside the observed workspace and CPU PDF memory capacity.
- Historical per-deployment effective environment snapshots and actual runtime
  behavior of the protected hosted apps.
- Byte/semantic equivalence of differently numbered hosted migration statements;
  no ledger repair or source reconciliation was performed.
- Actual GPU state was not queried; no GPU management or OCR endpoint was accessed.

Read-only GitHub/Vercel/Supabase/Render connector calls, three schema-catalogue
SELECT queries and public pricing/documentation reads were performed. No secret
values were decrypted, key/password endpoints called, environment files pulled,
application logs fetched or customer data queried. Generic Supabase lists and an
explicit-team Vercel project list were incomplete; exact known resource lookups
provided the successful evidence and the omissions are recorded above.

Only this local report was added. No commit, push, resource creation, migration,
deployment, capability enablement, OCR call, GPU operation, provider plan change
or deployed pricing/billing change occurred. The existing release manifest and
rollout plan remain the historical Chunk 12 artifacts; use this audit's verified
shared-resource and newer-baseline findings when preparing the next decision.
