# StockShift commercial launch sprint — 7 October 2026

## Release scope
CSV supplier catalogue reconciliation only: upload, deterministic matching, persistent results, mandatory review for flagged records and changed-products export. XLSX/PDF/OCR, margin analysis, ERP write-back and customer purchase-order ingestion are not offered in this hosted release.

## Competitor assessment
Reviewed official public pages on 7 October 2026:
- Diffchecker, https://www.diffchecker.com/excel-compare/ and https://www.diffchecker.com/pricing/: immediate two-file upload, visible comparison examples, broad spreadsheet formats, no signup for comparison, detailed FAQ and privacy/certification evidence. Its advantage is low friction and breadth. StockShift must differentiate with commercial product-level decisions and reviewed update exports; cannot claim superior accuracy or equivalent certifications.
- Synkronizer, https://www.synkronizer.com/ and https://www.synkronizer.com/excel-compare-pricing: Excel add-in, comparison/merge capabilities, trial download and perpetual licensing. Its advantage is working within Excel. StockShift's intended advantage is a saved browser workflow for supplier changes, with fewer setup steps. This is positioning, not proven competitive superiority.
- Sheetgo, https://www.sheetgo.com/: broad spreadsheet/business automation, demo/trial routes, product imagery and security/social proof. Adjacent alternative rather than a direct price-list reconciler. StockShift should maintain a narrow outcome instead of matching an automation suite.

## Design decision
Implemented directly in the existing Vue application, avoiding a second design artifact that can drift from the product. Forest-green typography, illustrative product comparison, exact code/price examples, three-step workflow, practical FAQ, explicit supported formats and truthful launch availability. No invented customer logos, testimonials, time-saving statistics or certifications.

## Account onboarding
Email signup, confirmation guidance, reset request and recovery password form. Public registration is fail-closed unless VITE_STOCKSHIFT_REGISTRATION_ENABLED=1. Do not enable until custom SMTP, canonical redirect URLs and a delivered external-customer confirmation/reset test pass. Existing sign-in remains available. Confirmed non-anonymous accounts can create one initial owner workspace through a private, authenticated RPC; repeated calls reuse existing membership without promoting invited viewers.

## Billing foundation
Server-only Stripe Checkout/portal and signed raw-body webhook endpoint. Billing remains fail-closed unless STOCKSHIFT_BILLING_ENABLED=1, and must remain off until the full release gates pass. Selected account: Robormiston (user confirmed). No live Stripe objects created and no charges initiated by this increment.
- Provisional pricing hypothesis: GBP 29/month, recurring monthly, CSV launch product. Not an established optimal price, not yet advertised as purchasable.
- Server configuration: STOCKSHIFT_STRIPE_MODE (test/live), STOCKSHIFT_STRIPE_SECRET_KEY (prefer restricted key), STOCKSHIFT_STRIPE_PRICE_ID, STOCKSHIFT_STRIPE_WEBHOOK_SECRET, STOCKSHIFT_PUBLIC_ORIGIN=https://stockshift.co.
- Product metadata must include app=stockshift and plan=csv-launch. API rejects another product, currency, amount, interval or mode.
- Checkout uses authenticated owner membership and server-side customer mapping; caller-supplied prices/return URLs are ignored. Existing active or delinquent subscriptions route to portal instead of another purchase.
- Webhooks verify signatures and mode, re-read current subscription state, and record state/events transactionally through a service-only function. Database subscription status is a foundation, not implemented/enforced paid entitlement or usage quota.
- No automatic tax configuration; business identity, selling jurisdiction, tax registration and customer-facing tax presentation must be verified before charging.

## Remaining commercial release gates
1. Custom SMTP and sending-domain authentication, correct Supabase site/redirect URLs, real external email delivery and password recovery.
2. Stripe isolated testing environment/credentials, product/price/webhook/portal setup, checkout/cancellation/failed-payment/refund tests and raw-body behavior on the deployed runtime.
3. Paid entitlement and atomic comparison/storage usage limits, including retry/idempotency/concurrency behavior. Billing must remain off until implemented and verified.
4. Business identity, support contact, privacy/terms, retention/deletion policy and practical account deletion/export process.
5. Monitoring/alerts, supported catalogue-size limits, worker restart/failure recovery and backup/restore verification appropriate for customer data.
6. Fresh customer journey on desktop/tablet/mobile with realistic CSVs; then production environment and production release promotion with rollback.

A live domain and a passing build do not mean the commercial launch gate has passed. Registration and payment availability stay explicit; no unfinished functionality is sold.
