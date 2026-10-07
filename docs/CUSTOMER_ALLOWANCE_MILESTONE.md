# Customer allowance visibility — 7 October 2026

## Recovery and scope

Reviewed the current Notion Finished Product Sprint and QA gate, the deployed Vercel project, and the actual hosted source branch. The previous session published fd70672c7061a844f57c389ee6726cbd3ff57359 and deployment dpl_Bn6Vtrb9dCtYSAvEU7EYrWaWYzZE is READY. The public stockshift.co landing page was inspected in the cloud browser. Registration and payments remain closed. A public domain does not establish commercial-launch readiness.

This increment completes the code for customer-facing allowance visibility, one outstanding item in commercial gate 3. SMTP/email acceptance and the Stripe lifecycle remain separate release gates. This increment does not open signup, enable billing, run OCR, deploy the worker, or promote main.

## Architecture and changes

Existing Vue/Vite application, Vercel API orchestration, dedicated Supabase Postgres/Auth/Storage and existing durable worker are preserved. No additional service, dependency or parallel app is introduced.

A read-only workspace_allowance_status RPC projects the effective allowance using the same eligibility rules as the existing enforcement trigger: pilot exemption, trial allowance, or a currently active live Stripe period. Editors and viewers receive effective limits without access to owner-only subscription identifiers. The private SECURITY DEFINER implementation checks auth.uid and actual workspace membership, uses an empty search_path, and grants only authenticated execution through an invoker wrapper. It never changes counters.

The Vue status panel displays remaining comparisons, upload reservations, reserved bytes and paid period end. It explains failed-job counting, worker retry behavior, cumulative upload reservations and closed payment availability. Exhaustion keeps saved results/review/export reachable. New drafts need two remaining file reservations; an existing draft with both files can still queue when upload reservations are exhausted but a comparison remains.

Creation, upload and enqueue refresh the allowance before acting. Uploads check actual file size against the remaining byte allowance. Upload/queue outcomes refresh it again, including uncertain failures where the server may already have accepted the action. Database enforcement continues to decide eligibility under races; the browser is advisory and cannot write counters. Stale responses are discarded across workspace switches, logout and component disposal. Failed allowance reads clear the old usable state, disable new work and offer retry without blocking saved results.

## Verification executed

- 151 JavaScript/TypeScript tests passed, including file-size limits, two-reservation creation, exhausted comparisons, drafts with ready files, malformed response rejection, pilot access, stale workspace/logout responses and failure/retry state.
- 38 embedded PostgreSQL tests passed. New coverage verifies owner/viewer projection parity, non-member and anonymous denial, read-only behavior, test-mode rejection, active live eligibility, billing-period rollover, delinquency, expiry, future periods and owner-only subscription isolation.
- Contract generation check, typechecks, build, formatting and git diff checks passed.
- Runtime: Node 24.19.0/npm 11.9.0. Dependency installation used --engine-strict=false because the source pins Node 22/npm 10. Dependency versions and lockfile were preserved. No Node 22 execution is claimed.
- The standard npm test wrapper encountered a tsx IPC-pipe permission error; the same JS/TS test files passed using node --import tsx --test. Database tests ran with node --test.

## Release boundary and remaining acceptance

Code is prepared for review, not installed in the live database or promoted to the live site. Apply the additive migration before deploying the frontend. It is backward compatible with the prior frontend. Frontend rollback leaves the unused read-only RPC safely in place.

Browser acceptance of the new signed-in panels is still required. Local Playwright Chromium downloads were truncated and failed; the cloud browser could inspect the public site but could not connect to the local development server, and had no authenticated StockShift session. No desktop/tablet/mobile acceptance or full real-worker regression is claimed for this increment.

Before release, exercise trial/pilot/exhausted/error states at desktop, tablet and mobile widths; upload two CSVs and verify decrements after queueing; switch workspaces and refresh; confirm saved results, review and export remain available at exhaustion. Run native PostgreSQL concurrent-enqueue acceptance separately. Embedded PostgreSQL tests do not prove native multi-connection concurrency. Stripe billing-period synchronization still needs real webhook lifecycle acceptance.

Next commercial milestone remains custom SMTP and canonical confirmation/recovery URLs with actual external-customer email delivery, followed by isolated Stripe lifecycle acceptance. Keep registration and billing off until the documented launch gates pass.
