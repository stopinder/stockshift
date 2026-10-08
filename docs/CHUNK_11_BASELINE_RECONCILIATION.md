# Chunk 11 — CSV baseline reconciliation

Completed locally on October 8, 2026. Cached `origin/main`
`7a14fbe09cc7aed025e2cc2ee6e12624c80df0d9` is the newer CSV baseline identified
by Chunk 10. It was merged into `codex/preview-cpu-pdf-release` as
`4fdf7f4302c2f0439374a4175c179b0342e3250e`, with parents `ab004a1` and `7a14fbe`.
The following documentation commit updates the release manifest/plan; resolve the
release branch to identify the final commit containing both code and metadata.
No fetch/push or hosted deployment identity check occurred.

## Incorporated baseline

| Commit    | Preserved behavior/dependency                                                                   |
| --------- | ----------------------------------------------------------------------------------------------- |
| `36a3d97` | Explicit hosted browser/API configuration and CSV Preview restrictions                          |
| `d3a5d6f` | API TypeScript import-extension rewriting and bounded actionable platform error codes           |
| `84cbcd4` | Numeric-unit validation, unit/pack clarity and persisted comparison settings                    |
| `8cfa4fe` | Existing launch page, guarded onboarding and inactive billing foundations/dependency            |
| `fd70672` | Existing workspace upload/comparison allowance enforcement and upload HTTP 429                  |
| `60770f9` | Member-scoped allowance projection and upload/draft/comparison gates                            |
| `7a14fbe` | Keep verified source files available and disable replacement rather than losing existing inputs |

The four existing baseline migrations are incorporated unchanged between the
catalogue-review and CPU-inspection migrations in timestamp order. The full
release has fifteen migration prerequisites. No new migration was invented,
applied persistently, duplicated or rewritten. SQL/worker/upload compatibility is
reviewed in [the updated rollout plan](CHUNK_10_PREVIEW_RELEASE.md); exact paths
and committed-byte hashes are in [the manifest](CHUNK_10_RELEASE_MANIFEST.json).

Billing APIs/implementation, subscription/allowance migrations, SDK pin and
commercial page/pricing content match the baseline. They are inherited existing
behavior, not a new billing rollout. No pricing, quota, subscription, Stripe
configuration or enablement was changed. `STOCKSHIFT_BILLING_ENABLED` remains
default-off by the existing code; hosted PDF flags and OCR remain default-off.

## Deliberate conflict decisions

Ten files conflicted. Each was reviewed against both parents:

- `api/pdf.ts`: retain authorized persisted inspection reads and worker agreement;
  never restore Python execution in the web API.
- `api/uploads.ts`, `server/uploads.ts`: retain parse/capability validation,
  lease-token finalization, reverified ownership/hash/size and enqueue recovery;
  retain explicit hosted configuration already shared by both branches.
- `server/supabase-upload-gateway.ts`: keep fresh PDF advertisements, authorized
  source/inspection access and eight-argument lease RPC; add the baseline's
  actionable upload-allowance HTTP 429 mapping.
- `src/supabase-config.ts`, `src/workflow.ts`: combine baseline import settings,
  unit checks and platform errors with the explicit public-env allowlist and
  default-off PDF configuration validation.
- `ComparisonDetail.vue`: combine allowance loading/authorization gates and saved
  settings with verified-file preservation, separate PDF byte/inspection states,
  capability gates and mandatory confirmed revision before comparison.
- `csv-preview.test.ts`: keep the inspection-aware gateway fixture and CSV-only
  rejection coverage.
- `vite.config.ts`: retain deployment validation and isolated daemon test port.
- `security.test.mjs`: preserve lease-aware security tests; update the full-schema
  public-table assertion from sixteen to nineteen and format the file. The added
  three baseline public tables remain RLS protected.

Nonconflicting baseline additions were retained, including the API-specific
TypeScript configuration, bootstrap Auth columns, lockfile and authorization/
allowance/onboarding tests. Worker code, CPU subprocess isolation, OCR routing
rejection, confirmed-complete revision requirements and all Chunk 4–9 migration
bytes remain unchanged from `ab004a1`.

GPU-serving commits/files, OCR diagnostics/replay tools, local credentials and
temporary artifacts remain excluded. Original root is on
`codex/chunk11-preserved-work`; the release branch is checked out in
`C:/Users/Rob/WebstormProjects/stockshift/.tools/chunk11-reconcile`. All 240
original tracked/untracked file hashes match; original `main` is still `b496e41`.

## Verification actually run

| Check                                                      | Result                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Locked isolated workspace install                          | Passed with scripts/audit disabled; public npm registry supplied the uncached pinned Stripe SDK; no Stripe/API operation |
| `npm run check`                                            | Contracts generation, typecheck, 106 web + 54 contract + 52 existing embedded SQL tests and build passed                 |
| Final `npm run test:db` including new compatibility test   | 53 passed; total 213 web/contract/embedded SQL tests                                                                     |
| `npm run format:check`                                     | Passed                                                                                                                   |
| New baseline compatibility test in native local PostgreSQL | Passed; fixed `127.0.0.1:54322`, real SQL/RLS/upload leases/digests/allowance triggers                                   |
| Docker engine                                              | Reachable Linux engine                                                                                                   |
| Git whitespace/conflict checks and targeted formatting     | Passed                                                                                                                   |
| Local preservation fingerprint                             | All 10,996 rows unchanged across 22 public/private/Auth/Storage/ledger tables                                            |
| Original working-tree fingerprint                          | All 240 files unchanged; original `main` unchanged                                                                       |

The native test reads the local migration ledger, applies only missing baseline
definitions inside its own transaction, exercises CSV upload/enqueue idempotency,
PDF job accounting, exhaustion and tenant isolation, then rolls back all DDL and
fixtures. The ledger is never modified. Embedded verification applies the complete
fifteen-file chain and uses Postgres's actual built-in SHA-256 to represent the
extension digest function; native verification uses the real installed extension.
Neither mode starts a provider or calls OCR. No persistent local migration or
existing row change occurred.

The first typecheck lacked the new baseline SDK in the old shared dependency
directory. An isolated locked install corrected the verification environment.
Offline installation was attempted first; the SDK was not cached. Application
billing code was not changed to accommodate the environment.

The 168 native integration cases and six real-browser PDF acceptance cases from
Chunk 9 were not rerun against this merged UI/schema. They remain evidence for
the unchanged CPU backend, not proof of merged customer allowance/browser behavior.
The unchanged worker's 96-test/wheel verification from Chunk 10 was reused.

## Remaining compatibility and rollout blockers

**PDF accounting needs a separate decision before enablement.** The baseline
`bound_workspace_comparison` trigger invokes `consume_workspace_allowance` for
every inserted job. It treats PDF inspection and extraction as comparison usage.
The native test proves: one CSV enqueue consumes one allowance; repeated enqueue
consumes none; PDF inspection consumes another, and extraction consumes another;
the next new job fails with `Trial comparison allowance reached`. Inspection
creates no confirmed revision or OCR output. This is existing baseline policy,
preserved under the instruction not to change billing.

A normal old/new digital pair requires two inspections, two extractions and one
comparison, so a new customer's three-job trial cannot complete it. Existing
exempt pilot workspaces differ; paid allowance also counts each processing job.
Do not enable hosted PDF or infer customer acceptance from prior pilot tests.
Changing what constitutes a billable/limited comparison is outside this chunk.

The old seven-argument CSV finalizer is still incompatible with Chunk 8's fenced
completion. A Vercel Preview pointing at Production's database is not isolated;
the migration affects Production even when PDF flags are off. Keep the dedicated
Preview requirement and all worker-advertisement/mixed-consumer stop conditions.

The known cached code divergence is resolved. Actual deployed version, migration
ledger, isolated Preview project and provisioned CPU host remain unknown. After
the allowance decision, perform complete merged native/browser acceptance before
hosted enablement. No push, provisioning, hosted database access, deployment,
capability enablement, OCR request, GPU operation or billing change occurred here.
