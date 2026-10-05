# Versioned contracts

`schemas/v1/*.schema.json` is the source of truth (JSON Schema draft 7).
The `https://contracts.stockshift.invalid/` IDs are offline identities, not network endpoints.
Both validators load all schemas locally; no runtime schema downloads.

Run `npm run contracts:generate` from the repository root after changing schemas.
This regenerates TypeScript declarations and byte-identical schema copies packaged in the Python wheel.
Run `npm run contracts:check` to reject missing, stale or obsolete generated artifacts.

Use the workspace package's root export for constants/types and
`@stockshift/contracts/validation` for runtime validation. Python uses
`stockshift_worker.contracts.validate_contract`. Both reject invalid values without
defaults, coercion or mutation. TypeScript types cannot express every JSON Schema
constraint; validate untrusted payloads even when generated types compile.

Money, pack quantities and calculated decimal values are canonical strings or explicit
null, never JSON numbers. Preserve source strings and scale. Source identifiers remain
strings. Scores are optional/nullable, have a score type when present, and are never
implicitly calibrated probabilities. Missing confidence remains missing.
Field locators use one-based page/row positions and label bounding-polygon coordinates.

Extraction produces raw cells/semantic candidates and evidence. Normalization produces
validated products separately; no matching, arithmetic or provider implementation
exists here. Complete extraction requires a known total, no pending/failed units,
and equal completed/total counts. Cross-field count checks live in both runtime
validators because draft 7 cannot compare two property values.

`tests/fixtures/contracts/cases.json` is a shared acceptance corpus, not dashboard
or customer data. Both language test suites assert the same accept/reject expectation.
Extending v1 must preserve compatibility or introduce a new version; coordinate changes
with the worker, fixtures, packaged schema copies and generated types.
