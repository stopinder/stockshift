# Local CSV engine

Production packaging excludes local diagnostic/replay entrypoints and fixtures.
Hosted CPU PDF processing rejects OCR independently; OCR stays disabled.
The default `stockshift-worker` command is a daemon. The CPU image defaults to
explicit hosted mode and permits CSV only. Configure `STOCKSHIFT_SUPABASE_MODE=hosted`,
`STOCKSHIFT_SUPABASE_URL=https://<preview-ref>.supabase.co` and the server-only
`STOCKSHIFT_SUPABASE_SECRET_KEY` in the worker host's secret settings. Never set
OCR credentials for this CSV preview. Vercel does not automatically run this worker. See
[preview readiness](../../docs/CHUNK_10_PREVIEW_RELEASE.md).

Scanned/mixed PDF extraction uses `RoutedPdfExtractor` and the worker-only
PaddleOCR-VL `/layout-parsing` adapter. It renders only pages that need OCR, caches
immutable page responses, and requires source verification through the existing
correction model. See [OCR configuration and local testing](../../docs/PADDLEOCR_WORKFLOW.md).
The CPU image contains the adapter and PDF renderer, not GPU model weights.

The existing layout adapter is retained as a PDF import dependency; hosted CPU
processing rejects layout routing and uses direct digital extraction only.

`stockshift_worker.domain.csv_engine` provides `CsvOptions`, `parse_csv`,
`reconcile`, and `export_changed`. No cloud credentials or new dependencies are
needed. The default CLI polls durable jobs every two seconds; `--poll` remains an alias,
`--once` processes at most one eligible job, and `--check` validates installed runtime
imports without credentials/network. `npm run worker:local` explicitly uses only
local stack credentials. Hosted mode never falls back to local keys or standard
SUPABASE_* variables. Opaque secret keys use `apikey`; legacy service_role JWTs
also use Bearer authorization.

SIGTERM/SIGINT stops further claims, interrupts idle waits and drains the current
job while its heartbeat remains active. Transient claim failures back off at the
poll interval. PostgreSQL retains fenced leases, bounded attempts, scheduled
retries, atomic/idempotent results and dead-letter handling. A host that kills a
job before drain completes leaves it recoverable after the 120-second lease.
No queue state is held only in worker memory. No HTTP listener, disk or Redis is
required. The service manager must restart a crashed process.

Default hosted mode refuses PDF/OCR extraction; approved CPU PDF flags permit
only direct digital extraction. Hosted XLSX remains unavailable.
Use an isolated preview database, not a mixed production queue.

## CSV preview verification

Build: `docker build -t stockshift-worker:csv-preview services/worker` from the
repository root. Import smoke: `docker run --rm --network none
stockshift-worker:csv-preview stockshift-worker --check`.

On Docker Desktop with host networking enabled, the browser suite can run the
actual image's default daemon against local Supabase; test credentials are passed
through process environment, not Docker command arguments. Test teardown sends
SIGTERM and asserts a clean drain/exit. See exact PowerShell commands and hosted
resource blockers in [preview readiness](../../docs/CHUNK_10_PREVIEW_RELEASE.md).

From `services/worker`, run the following with `uv run --locked python`:

```python
from pathlib import Path
from uuid import uuid4
from stockshift_worker.domain.csv_engine import (
    CsvOptions,
    parse_csv,
    reconcile,
    export_changed,
)

options = CsvOptions(
    encoding="utf-8-sig",
    delimiter=",",
    decimal_separator=".",
    columns={"supplier_sku": "SKU", "cost_price": "Price", "description": "Description"},
    currency="GBP",
    pack_quantity="1",
    unit="each",
    price_basis="unit",
    tax_basis="net",
)
fixtures = Path("../../tests/fixtures/csv")
old = parse_csv(
    (fixtures / "old_catalogue.csv").read_bytes(),
    source_file_id=str(uuid4()),
    source_name="old_catalogue.csv",
    options=options,
)
new = parse_csv(
    (fixtures / "new_supplier_catalogue.csv").read_bytes(),
    source_file_id=str(uuid4()),
    source_name="new_supplier_catalogue.csv",
    options=options,
)
outcomes = reconcile(old, new)
Path("changed_products.csv").write_bytes(export_changed(old, new, outcomes))
```

Use a distinct source-file UUID for each input revision. Retain the source name,
original bytes, and the returned products/evidence together. Record and evidence
IDs are deterministic for a given file UUID and physical starting line. Reusing a
file UUID for different bytes or import settings is not supported.

## Input and comparison policy

Encoding, delimiter, exact header mapping, and decimal separator are mandatory.
There is no encoding/delimiter/locale inference. `utf-8-sig` explicitly handles a
UTF-8 BOM. Decode errors, malformed quoting, duplicate/blank/missing mapped headers,
and wrong-width rows fail the whole import. Completely empty physical lines are
ignored. Empty cells stay null, with raw empty text retained as evidence.

Optional `thousands_separator` accepts `.`/`,`/space and requires correct groups
of three digits. Optional `currency_symbol` permits only that literal prefix;
symbols are never used to infer currency. Decimal input rejects exponent notation,
non-finite values, negative prices, nonpositive packs, and tokens longer than 128
canonical characters. Prices retain scale. Identifiers retain original text and
leading zeros. Surrounding SKU whitespace requires review rather than trimming.

Map any supported product field explicitly. Per-file currency, pack quantity,
unit, price basis and tax basis are caller assumptions for unmapped columns, with
no implicit defaults. A mapped blank cell overrides the assumption with null.
Pack quantity defaults use canonical decimal-point text even with comma input.

Only unique exact raw SKUs match. Duplicates and conservative case/whitespace SKU
collisions require review. GTIN and manufacturer-scoped MPN collisions across raw
SKUs also require review; they never create matches. Conflicting known GTIN, MPN
or manufacturer values veto an otherwise exact SKU. Missing/invalid required
values become individual review outcomes, including an exact-SKU counterpart.
Missing optional corroborating identifiers do not invent conflicts.

For a valid exact pair, currency, pack quantity, unit, price basis and tax basis
must all be known and equal (pack equality uses Decimal). Missing/incompatible
bases create a review outcome with null delta/percentage and explicit issues.
Pack/unit change flags survive review, but price flags do not imply a comparable
price movement. Units are literal strings; there is no conversion or alias logic.
Unmatched valid records are `new`/`absent`; they are never included in this export.

Prices use Decimal throughout. Absolute deltas are exact; percentages use a local
300-digit arithmetic context and round to **six decimal places, half even**. Zero
old cost produces a null percentage and `zero_old_cost` issue. There are no margin
calculations or fuzzy matching, and no invented confidence scores.

## Output and limitations

Returned product, evidence and outcome dictionaries validate against the existing
v1 contracts. Evidence covers each mapped cell: file UUID, physical starting line
(header is line 1), original header name and raw decoded CSV cell text. This is
cell content after CSV unquoting, not the original byte-level quoted lexeme. Default
assumptions are represented by `CsvOptions`, not fabricated source evidence.

`export_changed` returns UTF-8 CSV bytes with CRLF records and a fixed standard
column order. It includes only `changed` outcomes in `not_required`/`approved`
states whose records have no validation issues. There is no review-decision API;
`needs_review`, pending and rejected results never appear as approved changes.
The exporter rechecks deterministic eligibility, rejects altered result links or
calculations, and emits each eligible result once. Relabeling a review row as
approved cannot bypass the underlying comparison rules.
Text beginning with `=`, `+`, `-` or `@` after leading whitespace/control/BOM is
prefixed with an apostrophe. This deliberate text transformation protects common
spreadsheet imports; decimal columns remain exact numeric text. Consumers should
import SKU columns as text to retain leading zeros in spreadsheet applications.

The engine itself remains in memory; the job adapter below persists its output.
There is no streaming catalogue persistence, human-review resolution, custom export
profiles, or large-file performance claims. Callers must not mutate validated
products/outcomes to bypass review. See the shared synthetic corpus README and
`tests/test_csv_engine.py` for reproducible expectations.

## Durable local worker

After installing the locked Python workspace, start and reset the local stack from
the repository root with `npm run supabase:local -- start` and
`npm run supabase:local -- db reset --local`. Set only
`STOCKSHIFT_LOCAL_SUPABASE_URL` (`http://127.0.0.1:54321`) and
`STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY` from that newly started local stack.
The worker does not load `.env`, standard `SUPABASE_*` credentials, arbitrary
connection strings or hosted URLs. Redirects are forbidden. Do not expose the key
to a browser. There are no hosted startup instructions in this increment.

From `services/worker`:

```sh
uv run --locked stockshift-worker --once
uv run --locked stockshift-worker --poll --poll-interval 2
```

The default command polls; use `--check` for a no-network import smoke. A local
owner/editor enqueues via `enqueue_comparison_job(p_tenant,p_comparison,p_key,
p_current_options,p_incoming_options,p_max_attempts)` using their authenticated
token. Both options objects use the explicit `CsvOptions` fields shown above.
Both comparison sides must reference ready same-tenant CSV uploads. Enqueue
snapshots the file IDs/settings; reuse of a tenant idempotency key with different
inputs/settings/retry policy is rejected. A new key creates a new immutable run.
The browser has no direct job/result mutation grants and cannot call worker RPCs.

Polling uses `FOR UPDATE SKIP LOCKED` to claim one eligible job. Each attempt gets
a fresh token and a 120-second lease; a background heartbeat renews it every
30 seconds. Claim transactions end before parsing/downloading. Every load,
heartbeat, failure and completion checks tenant, worker and unexpired token.
Expired attempts become `expired`; the next poll reclaims the job with a new
token, fencing the abandoned process. Even without another execution, an expired
last attempt becomes `dead_letter` on the next poll.

Execution is **at least once**. The worker rechecks size and SHA-256, parses both
CSV inputs with the frozen settings, and calls the existing deterministic engine.
All results/candidates, run completion, attempt success and job success commit in
one transaction. No partial outputs are published on a validation error. Result
IDs are deterministic within a run, and `(run,source_result_id)` is unique.
Repeating completion with the same winning token and canonical JSON payload
returns success; changed payloads and stale tokens fail. A crash or lost HTTP
reply cannot create duplicate outputs. There is no exactly-once execution claim.

Transient network/service errors retry after 5, 10, 20... seconds (capped at 300),
with three attempts by default and an enqueue limit of 1–10. Invalid CSV/settings
or integrity failures are terminal `failed`; retry exhaustion is `dead_letter`.
Attempts and jobs retain structured code/stage/message/retryability details without
logging input contents, credentials or HTTP bodies. A heartbeat failure prevents
publication. If failure recording is unavailable, lease expiry provides recovery.
Terminal jobs are inspectable; there is no manual retry UI/API or external dispatcher.

Results store the primary outcome, independent flags, complete old/new normalized
values, exact decimal text plus PostgreSQL `numeric`, calculation/compatibility
issues, and cell evidence (file/record/row/column/raw text). Percentages explicitly
distinguish `defined`, `zero_old_cost` and `not_comparable`. Review outcomes create
pending candidates with their available exact-SKU pair or an unpaired record and
reasons; missing counterparts and confidence scores stay null. No fuzzy proposals
or automatic review approvals are introduced.

Bounds: UTF-8 CSV, 10 MiB per source, 20,000 outcomes per run and a 32 MiB RPC
payload/response cap. Output is published as one transaction; larger jobs need a
future batching design. There is no hosted worker deployment, cancellation,
streaming checkpoint, cleanup, review UI, OCR/PDF/XLSX or export job in this increment.
The host poller supplies recovery; stopping every poller stops dispatch/reclaim.

`npm run test:local` executes the native SQL suites and real Auth/Storage/Python
integration, including the 100-outcome fixture and abandoned-lease recovery. It
requires the installed `services/worker/.venv`. Test fixtures are synthetic and
remain locally until reset. Python unit tests use a fake gateway, while final
database verification uses Docker-backed Supabase, never PGlite.

## XLSX ingestion (Increment 6)

`domain.xlsx.parse_xlsx` reads bounded ordinary OOXML archives directly using
`zipfile`/`defusedxml==0.7.1`; prices are parsed from stored XML tokens with Decimal.
It calls the same `normalize_rows` as CSV, then the same reconciliation/publication
pipeline. `format: "xlsx"`, `worksheet` and integer `header_row` extend the existing
options dictionary; explicit `columns` can map currency/pack/unit as well as SKU,
cost and description. `inspect_workbook` returns worksheet metadata and an optional
bounded header/sample preview. It never recalculates formulas.

The server's local stdin adapter uses the installed worker environment for upload
verification and discovery. The polling worker independently revalidates bytes, SHA,
format, tenant and configuration before parsing and atomically publishing output.
Worksheet and row participate in deterministic record/evidence IDs. Provenance
includes original XML raw text, selected worksheet, physical row and header.

See [workbook assumptions and local mapping](../../docs/LOCAL_CSV_WORKFLOW.md#xlsx-workbooks)
for limits, formulas, identifier padding and actionable failure behavior. The public
CSV APIs and their monetary semantics remain unchanged. `openpyxl` is pinned only
in the development group to write realistic OOXML test fixtures, not used at runtime.

## Digital PDF provider and revisions (Increment 7)

`extraction.digital_pdf.DigitalPdfExtractor` implements the existing validated
`DocumentExtractor` protocol using pinned `pdfplumber==0.11.10`. It reads embedded
text and table cell geometry, reports actual page progress, and returns the existing
provider-neutral `ExtractionResult` envelope with raw cells, page/table/row/cell
locators and bounding polygons in page points. It does not guess semantic fields,
assign confidence scores, run OCR, match products or calculate margins.

Durable `extract_pdf` jobs share claim/lease/heartbeat/attempt/retry/fencing with
comparison jobs. Parsing runs in a credential-free subprocess with a 60-second
deadline, bounded input/output and cancellation on lost lease. Progress/completion
RPCs validate tenant/source/job ownership and lease tokens; duplicate completion is
idempotent and conflicting publication is rejected. Timeouts are retryable, bounded
by the existing three-attempt policy; corrupt/encrypted input fails terminally.

`extraction_runs.payload` stores the immutable raw validated envelope and
`raw_pages` stores text previews. Append-only `correction_revisions` store full
mapping/correction snapshots with actor/time and optimistic revision checks.
`comparison_runs` snapshot confirmed revision IDs via tenant/source-aware foreign
keys. `normalize_pdf` applies that snapshot through the same `normalize_rows`
contract as CSV/XLSX, then replaces synthetic row locators with original PDF evidence.
Normalized products are persisted in the existing comparison result old/new values;
original source evidence always contains the extracted value, even after correction.
A future OCR provider can implement the same extraction envelope while leaving
normalization, reconciliation, publication and review/export unchanged.

See [digital PDF assumptions and correction steps](../../docs/LOCAL_CSV_WORKFLOW.md#digital-pdfs-increment-7).
`reportlab==5.0.1` is development-only and generates synthetic test fixtures. The
installed-wheel and CPU-container smoke tests parse these fixtures without any
fixture writer installed in the runtime. No OCR model or hosted credentials are used.

# Hosted CPU PDF capabilities (Chunk 9)

The existing HTTPS hosted gateway and CPU worker now support inspection and direct
digital extraction behind `STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED` and
`STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED`, both defaulting to `0`. Extraction
requires inspection; `STOCKSHIFT_OCR_ENABLED` must remain `0`. Hosted XLSX and
provider routing remain unavailable. Hosted OCR RPCs are rejected independently.

Upgraded hosted workers advertise their actual profile to the private capability
registry every 30 seconds, including during job heartbeats; advertisements expire
after 120 seconds. The API rejects missing, expired or conflicting profiles.
Workers also check matching live profiles before PDF execution/comparison.
The new reviewed migration is required before worker rollout, including default-off
CSV operation. Local gateway operation is unchanged and needs no advertisements.

Hosted extraction checks persisted CPU inspection and every selected page before
download/parser execution. Its isolated subprocess receives no OCR credentials and
cannot select a routed/mapped provider. PDF comparison accepts only complete,
confirmed direct-digital revisions. Queue tokens, integrity checks and atomic
publication remain the existing mechanisms.

See [Chunk 9 rollout configuration and evidence](../../docs/CHUNK_9_HOSTED_CPU_PDF_CODE.md).
