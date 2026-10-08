# Business workspace creation — Preview milestone

## Agreed behavior

One trial business workspace per confirmed customer account, with three comparison attempts. Each additional business has a separate £29/month subscription and 20 comparisons per active live billing period. Workspaces do not share subscriptions or paid counters. Creation itself never charges a card.

For this release, the backend caps each account at three owned workspaces, including test workspaces. Existing owner accounts are recorded as having already received workspace access; additional workspaces do not replenish their free trial. A private trial ledger survives removal of memberships. Retry receipts are scoped by user and request ID, and creation is serialized with an advisory transaction lock. Browser roles cannot edit either ledger.

Additional businesses are created with zero trial comparisons and uploads/processing locked until their own active live subscription exists. Database insert triggers enforce this independently of the interface. Existing pilot access is preserved.

Preview offers a designated Stripe test workspace. It receives no additional trial allowance, counts towards the cap, remains locked for catalogue processing and cannot be billed using live keys. This distinction is retained server-side. The test option is not displayed by the Production frontend build.

## Interface

The header separates Comparisons and Billing with explicit spacing and wraps on small screens. A single workspace has a plain name; multiple workspaces use a labelled selector. Create workspace is a separate action.

The creation form shows server-provided account limits and whether the account is eligible for its first trial. It explains the £29/month additional business cost before creation, keeps a retry request in session storage and prevents concurrent submissions. Successful creation reloads memberships, selects the new business, remembers the selection and opens Billing when payment is required. Ordinary trial workspaces open Comparisons.

## Verification

159 JS/TS tests and 42 embedded PostgreSQL tests passed, along with contracts, typechecks, frontend build, formatting and diff checks. Tests exercise trial isolation, retry receipts at the cap, legacy onboarding, denied ledger edits, invited-viewer role preservation, test/live entitlement separation and locked upload/processing gates. The tested migration was installed in the shared database; function presence and authenticated/anonymous privileges were checked remotely.

Native PostgreSQL concurrency, signed-in browser creation/switching and actual Stripe payment lifecycle acceptance remain pending. Browser automation was already unavailable in this environment; no new Chromium retries were attempted. Existing leaked-password-protection advisory remains a separate launch item; private RLS tables intentionally have no browser policies.

## Next acceptance

1. Refresh the GitHub-backed Preview and confirm separated navigation and a plain workspace name when only one business is available.
2. Choose Create workspace, enter a test business name and select Stripe test workspace. Verify the new workspace is selected and Billing opens. Retry/reload must not generate duplicates.
3. Complete the test Checkout and verify actual webhook delivery and subscription status; then test portal cancellation and failed-payment recovery.
4. Test multi-workspace switching, member isolation and responsive layout. The additional business remains locked in shared Supabase after a test subscription; live paid allowance enforcement is deliberately separate.
5. Review the Preview before any approved main/Production release. No live payment or GPU inference is part of this delivery.
