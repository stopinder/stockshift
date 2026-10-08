# Chunk 9: hosted CPU PDF support, code only

Verified October 8, 2026 against the existing native local Supabase stack and CPU
worker. No hosted project was accessed, migrated, deployed or enabled. Existing
modified/untracked work and local data were preserved. No new infrastructure
beyond the existing worker and database is required by this implementation.

## Implementation

The actual `HostedGateway` already uses an explicitly configured HTTPS Supabase
project origin and server-only key. It shares the proven RPC/private Storage
transport with local operation, including bounded requests and redirect rejection.
The existing Docker worker already packages the digital PDF/inspection libraries.
Previously, hosted mode implicitly restricted extraction/comparison to CSV, while
inspection dispatch did not have that restriction.

Hosted inspection and digital extraction now have separate default-off flags.
The local inspection flag does not enable either hosted capability. Hosted XLSX
remains unavailable even when PDF inspection is enabled. CSV behavior is retained.

Browser and API capability values must match at deployment validation. The API also
requires fresh worker advertisements matching both flag values exactly before PDF
registration/finalization or inspection reads. Advertisements live in a private
RLS-protected table, with service-only RPCs and no browser grants. Missing/expired
advertisements and mixed worker profiles reject PDF requests with HTTP 503 before
upload mutations. Worker advertisements refresh every 30 seconds and expire after
120 seconds. All upgraded hosted workers advertise, including disabled profiles;
expired records are removed when advertisements are refreshed.

The worker enforces its own capability flags independently, including jobs sent
directly through existing authorized database RPCs. It also checks live worker
profile agreement before PDF inspection, extraction and comparison. Disabled
operations and mixed profiles never load
or parse PDF bytes. Extraction additionally requires persisted CPU inspection and
digital-candidate status for every selected page. Existing direct digital requests
keep their configuration shape: `{first_page,last_page,strategy}` with the provider
field omitted. The SQL contract reserves explicit `provider: "auto"` for routing;
hosted CPU execution rejects it and rejects layout-association routing before
download or child-process creation.

The child process is pinned to direct `DigitalPdfExtractor`, receives no OCR
credentials and rejects routed configurations. Parent NDJSON handlers reject OCR
events, and `HostedGateway` independently rejects `record_ocr_page`. Inspection
never queues extraction or comparison. A scanned document retains `ocr_required`;
forced extraction is rejected without a provider fallback or confirmable output.

PDF comparison reuses the existing normalization/correction path and requires a
complete, confirmed revision for the same source/tenant. Hosted comparison also
requires direct-digital `pdfplumber` provenance. Source ownership, SHA-256/size
checks, upload leases, job heartbeats/tokens and atomic publication remain intact.
Existing UI controls reflect the capability flags without adding a new workflow:
inspection-only profiles cannot extract or start PDF comparison.

## Checks actually run

| Check | Result |
| --- | --- |
| `npm run test:local` | 168 native checks passed: prior 163 plus five hosted-mode cases |
| Final focused `hosted-pdf.local.ts` rerun | Five passed, including disabled-worker advertisement, worker-side agreement and redirect rejection |
| `npm run check` | Contracts generation check, typecheck, 89 web + 54 contract + 46 embedded SQL tests and build passed |
| Final typecheck and build | Passed after the public-env allowlist/import adjustment |
| Focused CPU Python regression | 96 passed: hosted capabilities, job runner, inspection, daemon and digital PDF jobs |
| Native `db lint --local` | No schema errors |
| Repository/focused Prettier and changed Python Ruff checks | Passed |
| Desktop/mobile local PDF browser acceptance | Six passed on the final sequential run |
| Existing data fingerprints | All 9,489 pre-existing rows unchanged across 18 public/Auth/Storage tables |
| Docker engine | Reachable Linux engine |
| `git diff --check` | No whitespace errors |

Only `20261008201320_hosted_cpu_pdf_capabilities.sql` was applied locally to verify
the new registry. No reset or hosted migration occurred. Native tests retain new
synthetic users, tenants, files and results; test-owned capability advertisements
are removed after the hosted-mode suite.

Hosted-mode integration uses the real `SupabaseUploadGateway`, `HostedGateway`,
API handlers, Auth, signed private Storage, Postgres RPCs and CPU subprocesses.
Both production gateways retain their HTTPS project validation. Test-only transport
bridges replace the synthetic HTTPS origin with `127.0.0.1:54321` before networking;
unexpected origins and redirects are rejected. No production test switch or URL
validation bypass was added. Successful responses/results are not mocked.

The five native hosted-mode cases cover:

1. Missing, conflicting, mixed and expired advertisements; matching inspection-only
   and full profiles; browser denial of registry RPCs.
2. Real inspection-only processing, authorized status reads, tenant isolation and
   rejected extraction without payload publication.
3. The synthetic old/new digital pair through extraction, draft rejection,
   confirmation, comparison and HTTP export. All six outcomes and exact prices,
   identifiers, flags and three changed-product export rows match the manifest.
4. Blindtex inspection retaining `ocr_required`. Forced digital and explicit auto
   jobs publish no extraction payload and cannot confirm; zero OCR cache records.
5. Default-off hosted CSV upload/finalization without worker advertisements, then
   real hosted-gateway comparison preserving `00042` and exact delta `-1.05`.

Configuration tests exercise all four flag combinations, malformed values,
CSV-only conflicts, OCR opt-in rejection and browser/API mismatches. CPU subprocess
tests prove routing is rejected before provider initialization. Existing worker
inspection fixtures were updated to explicitly opt in to the new hosted gate.
OCR database tests in the full native suite use synthetic stored envelopes and
make no provider calls.

The first browser run passed five cases; the mobile Blindtex monitor falsely
classified ordinary local Supabase reads because a random comparison UUID contained
`8771`. The monitor now checks URL host/path and actual port rather than query IDs.
The complete sequential rerun passed six cases: exact baseline, saved correction
with its expected two-row export, and Blindtex, each at desktop/mobile widths.
No application defect was found in those local acceptance journeys.

## Required future rollout configuration — not applied

All checked-in defaults remain off. A future approved rollout needs:

1. Inspect actual hosted migration history and apply only reviewed pending
   migrations. This includes the inspection/review foundations, Chunk 8 upload
   lease recovery and Chunk 9 capability registry. The registry is required before
   upgrading hosted worker code, including when PDF flags remain off.
2. Run the reviewed existing CPU worker image with `STOCKSHIFT_RUNTIME=production`,
   `STOCKSHIFT_SUPABASE_MODE=hosted`, the approved HTTPS project origin and its
   server-only secret/service-role key. No new GPU or OCR service is needed.
3. Use the same project origin/public key in browser and API configuration, with
   the private key confined to API/worker configuration. The existing strict
   hosted URL/key validation remains mandatory.
4. Synchronize these flags across API and **every** worker; mirror the first two
   with their `VITE_` prefix for the browser build. Clear any conflicting
   `STOCKSHIFT_CSV_ONLY=1` / `VITE_STOCKSHIFT_CSV_ONLY=1` override before PDF opt-in.

| Profile | `STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED` | `STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED` | `STOCKSHIFT_OCR_ENABLED` |
| --- | --- | --- | --- |
| Current default: CSV | 0 | 0 | 0 |
| Future approved inspection only | 1 | 0 | 0 |
| Future approved digital workflow | 1 | 1 | 0 |
| Invalid | 0 | 1 | any |

OCR opt-in is rejected in hosted CPU mode. Do not configure an OCR provider/token
for this rollout. Start matching workers before enabling the API/browser profile;
allow old conflicting advertisements to expire. Upgrade/align all queue consumers:
an old CSV-only consumer can reject a PDF job, and mixed upgraded profiles block
API acceptance. The API does not treat an advertisement as a deployment guarantee;
the underlying durable queue still handles process/transport interruptions.

These are required future settings, not instructions executed in this chunk.
No hosted environment was changed or capability enabled.

## Changed files

- `.env.example`: explicit default-off flags.
- `apps/web/src/pdf-capabilities.ts`: shared browser/API profile validation.
- `apps/web/src/supabase-config.ts`: validate hosted browser flags.
- `apps/web/src/workflow.ts`: public flag allowlist and format/comparison gates.
- `apps/web/src/components/ComparisonDetail.vue`: allowed uploads and comparison gate.
- `apps/web/src/components/PdfSettings.vue`: extraction capability gate/explanation.
- `apps/web/server/uploads.ts`: hosted format gate and worker agreement before mutation.
- `apps/web/server/supabase-upload-gateway.ts`: deployment matching and registry check.
- `apps/web/api/pdf.ts`: worker agreement before authorized inspection reads.
- `apps/web/tests/hosted-pdf-capabilities.test.ts`: configuration matrix.
- `apps/web/e2e/pdf-acceptance.spec.ts`: precise OCR request monitor.
- `services/worker/src/stockshift_worker/jobs/capabilities.py`: profile validation/advertisement.
- `services/worker/src/stockshift_worker/jobs/gateway.py`: registry RPC and OCR RPC rejection.
- `services/worker/src/stockshift_worker/jobs/runner.py`: dispatch, heartbeat and comparison gates.
- `services/worker/src/stockshift_worker/jobs/inspection.py`: inspection gate.
- `services/worker/src/stockshift_worker/jobs/pdf.py`: inspected-page/direct-provider gates and isolation.
- `services/worker/src/stockshift_worker/entrypoints/pdf.py`: CPU-only subprocess routing guard.
- `services/worker/tests/test_hosted_pdf_capabilities.py`: policy/isolation tests.
- `services/worker/tests/hosted_cpu_local.py`: loopback-only hosted transport bridge.
- `services/worker/tests/test_pdf_inspection.py`: explicit hosted inspection opt-in fixtures.
- `supabase/migrations/20261008201320_hosted_cpu_pdf_capabilities.sql`: private registry/service RPCs.
- `supabase/tests/hosted-pdf.local.ts`: five native hosted-mode acceptance cases.
- `scripts/verify-supabase-local.mjs`: include hosted-mode suite.
- `supabase/README.md`, `services/worker/README.md`: rollout prerequisites.
- `docs/CHUNK_9_HOSTED_CPU_PDF_CODE.md`: this evidence/configuration report.

## Remaining release blockers

No blocker remains for the locally verified code paths. Actual hosted migration
state, worker availability, deployment configuration and end-to-end hosted runtime
remain unverified. Repository infrastructure drafts are not evidence that a worker
has been provisioned. A future approved rollout must establish those prerequisites
and verify hosted Auth/Storage/queue behavior. No additional infrastructure beyond
the existing CPU worker/database was authored or provisioned here.

OCR processing remains independently disabled and outside this chunk. No hosted
access, deployment, OCR request, GPU operation or pricing/billing change occurred.
