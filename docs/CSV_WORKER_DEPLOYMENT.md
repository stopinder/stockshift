# CSV-only Render worker release

This branch isolates the worker changes from origin/main (Increment 7). It does
not publish the pending OCR-serving, catalogue-layout, frontend/API or migration
changes in the main checkout. The only web configuration change disables automatic
Vercel deployment for codex/csv-preview-worker. No Vercel release is authorized.

## Exact manual creation settings

Use deploy/render.csv-preview.yaml as the source of truth. Render service type
cannot be repaired by putting a Python command into the existing Node Web Service.
Create a separate Background Worker; do not delete/change that existing service.

| Setting                        | Value                                                          |
| ------------------------------ | -------------------------------------------------------------- |
| Approved workspace             | helios, tea-db2uufqd0e5s73ehlbjg                               |
| Service type                   | Background Worker                                              |
| Name                           | stockshift-csv-preview-worker                                  |
| Repository                     | https://github.com/stopinder/stockshift                        |
| Branch                         | codex/csv-preview-worker                                       |
| Runtime / Language             | Docker                                                         |
| Region                         | Frankfurt                                                      |
| Compute plan                   | 0.5c-512mb, 0.5 CPU / 512 MB, $7/month                         |
| Instances                      | 1                                                              |
| Auto-Deploy                    | Off                                                            |
| Automatic preview environments | Off                                                            |
| Root Directory                 | Blank, repository root (rootDir is omitted)                    |
| Dockerfile Path                | services/worker/Dockerfile                                     |
| Docker Build Context           | services/worker                                                |
| Docker Command override        | Blank (dockerCommand is omitted)                               |
| Effective Start Command        | stockshift-worker, from Docker CMD                             |
| STOCKSHIFT_RUNTIME             | production                                                     |
| STOCKSHIFT_SUPABASE_MODE       | hosted                                                         |
| STOCKSHIFT_SUPABASE_URL        | Dedicated StockShift project's HTTPS origin; enter securely    |
| STOCKSHIFT_SUPABASE_SECRET_KEY | Same project's server-only secret/service_role; enter securely |

No disk, Redis, public HTTP port, health route, GPU or OCR credentials. Creating the
worker or applying the Blueprint initiates the first paid deployment even though
Auto-Deploy is Off. Confirm workspace/card/price and backend settings first. No
workspace upgrade is authorized; if the displayed incremental baseline exceeds
$7/month, stop. Do not substitute the unrelated existing Supabase project keys.

## Backend blocker

A dedicated StockShift Supabase preview backend and its two runtime values are
not yet configured/verified. Missing/invalid values cause startup to fail clearly;
installation alone does not make the workflow operational. This task does not
authorize Supabase provisioning, migrations or hosted data changes.

This release is based on the existing Increment 7 schema/code. The committed
migration chain on this branch defines the CSV job RPCs, private catalogue-uploads
bucket and tenant isolation. The pending Increment 8 migrations are not included.
Before connection, verify the approved dedicated backend implements claim_csv_job,
load_csv_job, heartbeat_csv_job, complete_csv_job and fail_csv_job and the source
tables/Storage policies from this branch. Browser users require explicit tenant
memberships. The hosted web gateway/configuration is a separate unpublished change;
the existing Vercel site is not made operational by this worker deployment.

Never set the secret under VITE_. No environment files, captured responses,
diagnostic controllers, private documents or replay tools are included in the
worker release. Docker build context is allowlisted; no model inference is used.

## Validation

From repository root:

```powershell
docker build -t stockshift-worker:csv-preview-release services/worker
docker run --rm --network none stockshift-worker:csv-preview-release stockshift-worker --check
```

Default CMD runs the real daemon; --check is only a credential-free import smoke.
Hosted mode fails non-CSV jobs before invoking PDF/XLSX extraction. SIGTERM/SIGINT
stops new claims and drains the current job with the existing fenced lease and
heartbeat; hard termination recovers through lease expiry. Completion/retry and
tenant ownership remain in the existing durable database functions.

After a backend is separately approved and connected, run isolated synthetic CSV
upload -> finalization -> queued/claimed job -> persisted results -> review ->
reload -> export tests. Do not claim hosted acceptance until that completes.
