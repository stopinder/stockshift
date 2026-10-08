# Preview billing milestone — 8 October 2026

## Implemented

The signed-in Billing route lets workspace owners view subscription status, start Stripe Checkout and open a dedicated customer portal. Viewers/editors receive owner guidance and cannot call privileged billing actions. Authentication is verified server-side; status reads use the authenticated owner's workspace. Browser responses contain subscription status and period end, not Stripe IDs or credentials.

Checkout and portal returns use the existing stable `codex/customer-allowance` preview alias. Preview requires test mode and the exact configured return origin; Production still requires the canonical origin. Browser redirect destinations must be HTTPS Stripe Checkout/portal URLs. Existing active, trialing, overdue, unpaid, incomplete or paused subscriptions cannot create another checkout. Returning from Checkout does not grant access: bounded polling reads webhook-backed status. Switching workspaces/unmounting aborts pending requests and redirects.

The development middleware exposes billing and raw-body webhook routes. Hosted server credentials still must be configured explicitly for local API work.

## Configured test resources

- Stripe account: the user-selected account, test mode only.
- Existing StockShift test product. Added `app=stockshift`, `plan=csv-launch` metadata required by the existing validation. The price remains £29/month.
- Dedicated StockShift test portal. Invoices, payment method updates and cancellation at period end enabled; plan changes and customer updates disabled. App sessions explicitly select this configuration. No existing portal configuration was present.
- User created the webhook destination with the Vercel bypass query parameter and saved the signing secret. Its environment scope was corrected to Preview only.
- Branch-specific Preview configuration supplies test mode, approved price, trusted origin, portal configuration and enabled billing. Production billing remains disabled.
- Existing database webhook RPC and SELECT privilege verified by read-only SQL. No migration needed.

## Verification

157 JS/TS tests and 38 embedded PostgreSQL tests passed. Contracts, TypeScript, frontend build, formatting and diff checks passed. Added checks cover trusted Preview origins, rejection of live Preview keys, owner status summaries/mode mismatch, stale event synchronization, lifecycle checkout gating and Stripe redirect validation.

Standard `tsx --test` could not create its IPC socket in this execution environment; tests ran successfully with `node --import tsx --test`. Native browser QA was unavailable: Chromium download returned invalid archives. These checks do not establish real Stripe payment acceptance.

## Remaining acceptance

1. Sign into the stable Preview as the owner of a separate test workspace, open Billing and select Start test checkout.
2. Complete hosted Stripe Checkout using test card `4242 4242 4242 4242`, a future expiry and any three-digit CVC. Verify return to the same Preview and webhook-confirmed Active status.
3. Verify relevant webhook deliveries return HTTP 200, retry delivery and confirm subscription state remains correct. Synthetic unmapped events alone do not prove workspace synchronization.
4. Open Manage subscription, review invoices/payment details and schedule cancellation. Status stays active until the current period ends; verify final cancellation and a failed-payment lifecycle separately.
5. Test subscriptions deliberately do not grant live monthly comparison allowances in shared Supabase. Live entitlement activation and native concurrent enqueue remain separate gates.

No live charge, Production promotion, GPU inference or completed deployed payment lifecycle is claimed.
