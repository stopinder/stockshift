# Chunk 14 — verified Preview baseline reconciliation

Completed October 9, 2026 in the isolated release worktree
`C:/Users/Rob/WebstormProjects/stockshift/.tools/chunk11-reconcile`, branch
`codex/preview-cpu-pdf-release`, starting at `82fcaa2`. AGENTS.md and the Chunk 13
audit were read. Code commit: `3b04b2341117ba20760d6a34fb4515c0be5cdad6`.
The final documentation commit is resolved by the manifest's `releaseRef`.

## Source and scope

Both exact commits were fetched through the GitHub connector and into local Git:

- `afb645e3d536aa7e8ab1995b7ef85ebb60cdb1f0`: owner billing status/interface,
  disabled status without Stripe access, bounded status polling, duplicate
  checkout prevention, test/live separation, trusted Preview return origin and
  explicit portal configuration.
- `1423916cbc1d0b4f5e2e858f62747edcc6882d71`: one business trial per confirmed
  account, three owned workspaces including test workspaces, user/request-scoped
  idempotency receipts, serialized creation, subscription-locked additional
  businesses, authorized allowance projection, dependent creation interface and
  test/live workspace enforcement in billing authorization.

The two commits were applied in order without conflicts using no-commit
cherry-picks, then committed together with focused native verification. Their
historical milestone reports are included as upstream evidence; their provider
configuration and prior verification statements are not actions performed here.
All upstream application changes are retained, avoiding partial billing/workspace
dependencies. The only additional code changes are the native test harness and
its inclusion in the local verification workflow.

No prices, subscription entitlements, payment configuration or deployed billing
were changed. The existing £29/month / 20-comparison policy, active-live-period
requirements, pilot exemptions, first-business three-comparison trial, upload
limits and byte limits are preserved. Payments are not activated. The dedicated
PDF Preview must set `STOCKSHIFT_BILLING_ENABLED=0`, omit Stripe credentials and
keep `VITE_STOCKSHIFT_BILLING_TEST_MODE` absent/off. Its acceptance uses a fresh
ordinary business trial; designated Stripe test workspaces remain locked.

CPU inspection/extraction code, persisted API, capability agreement, upload
ownership/hash/lease fencing, complete confirmed PDF revision gates and the
comparison-only allowance migration remain unchanged from `82fcaa2`. The merged
development middleware retains asynchronous PDF handling alongside billing routes.
Inspection never creates extracted products or grants comparison eligibility;
scanned documents still stop at `ocr_required`. No OCR implementation is enabled.

## Migration reconciliation

The fresh isolated database uses **17 source migrations**, ordered in the updated
manifest and rollout plan. The added
`20261008141550_business_workspace_creation.sql` is byte-identical to the fetched
Preview source. It executes after `20261007153016_workspace_allowance_status`
and before `20261008182416_cpu_pdf_inspection`. The final
`20261008213000_comparison_job_allowance_accounting` narrows charging to
`reconcile_csv`, while the new subscription BEFORE INSERT guard covers all three
job kinds. No existing migration was edited, renamed or regenerated; the previous
16 committed migration hashes remain unchanged.

The Chunk 13 hosted ledger used different versions for five same-name migrations:

| Source version | Audited hosted version | Name                          |
| -------------- | ---------------------- | ----------------------------- |
| 20261007132615 | 20261007134233         | customer_workspace_onboarding |
| 20261007133637 | 20261007134242         | stripe_billing_foundation     |
| 20261007135419 | 20261007140327         | customer_usage_allowances     |
| 20261007153016 | 20261007160303         | workspace_allowance_status    |
| 20261008141550 | 20261008142412         | business_workspace_creation   |

For a fresh isolated project, source numbering is the explicit canonical history.
For the existing shared database, these mappings are informational: exact applied
statement equivalence remains unproven. Do not replay source files, rename applied
migrations or automatically repair the ledger. A separately reviewed existing-
database path must compare exact applied statements/schema semantics, explicitly
approve metadata mapping only where equivalence is proven, and create new forward
migrations for actual divergence. Old seven-argument finalizers also require a
coordinated upgrade. No executable Production migration path is supplied here.

## Checks actually run

- `npm run check`: generated contracts, typecheck, **114 web tests**, **54 contract
  tests**, **57 embedded SQL tests** and production build passed. After adding the
  real-job gate case, all **five workspace embedded cases** passed separately;
  the resulting embedded coverage is 58 cases. No application change followed.
- `npm run test:local`: **175 checks passed**, including five new native workspace
  cases, comparison concurrency/idempotency/fenced retry, authorization, private
  Storage, upload verification recovery and CPU worker integrations. Hosted-mode
  configuration tests used only loopback services; synthetic PDFs reached exact
  digital results and Blindtex stopped without an OCR provider call.
- Focused native workspace plus merged-schema PDF/accounting checks: **six cases
  passed**, including one-trial receipts/caps, legacy-onboarding bypass rejection,
  confirmed-account/role isolation, subscription-state gates, actual upload
  reservation and `inspect_pdf` / `extract_pdf` / `reconcile_csv` insert rejection,
  and free PDF preparation with comparison-only trial/paid charging.
- New workspace migration and fixtures were exercised in fully rolled-back
  transactions against fixed-loopback native PostgreSQL. Expected errors use
  savepoints; no reset or persistent schema/ledger change occurred. Fresh full
  migration ordering was exercised in embedded PostgreSQL, not a newly provisioned
  hosted database. The persistent local ledger remains at 16 versions.
- Targeted Prettier, Git whitespace and committed migration-hash checks passed.
  Docker reported Linux. All **10,996 original row fingerprints across 22 tables**
  and **240 original-worktree file hashes** remain unchanged; no pending jobs.

No browser acceptance was rerun in this chunk. Chunk 12's six desktop/mobile
real-browser cases remain prior CPU workflow evidence; current merged native
worker and schema checks are additional evidence, not a claim of merged browser
or hosted acceptance. Ignored `.tools/chunk14-*.log` files contain command output;
secrets, local environment, browser traces and temporary artifacts are excluded.

## Remaining decisions and rollout boundary

The missing Preview baseline is resolved. Provisioning still requires a confirmed
isolated Supabase project, separate pinned CPU worker and dedicated Vercel project,
Free quota/cost approval where needed, protection against automatic deployment to
the shared Vercel backend before any later push, worker image/target/advertisement
verification, and real hosted acceptance. Follow the Chunk 13 plan with this new
release ref and 17-file migration order. Keep OCR disabled and capability defaults
off until a separately authorized isolated rollout. Rollback must retain business
trial receipts/subscription guards and comparison-only accounting, along with
upload leases and compatible APIs. The shared hosted migration path remains a
separate unresolved task.

No push, hosted database access/change, resource creation, deployment, hosted
capability enablement, payment activation, OCR request or GPU operation occurred.
Only GitHub source and public Supabase documentation were accessed remotely.
