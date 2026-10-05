# Local CSV engine

`stockshift_worker.domain.csv_engine` provides `CsvOptions`, `parse_csv`,
`reconcile`, and `export_changed`. No cloud credentials or new dependencies are
needed. The worker CLI still runs the no-op queue scaffold; it does not process jobs.

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

This is an in-memory local engine, not a durable job handler. There are no database
writes, streaming catalogue persistence, human-review resolution, custom export
profiles, or large-file performance claims. Callers must not mutate validated
products/outcomes to bypass review. See the shared synthetic corpus README and
`tests/test_csv_engine.py` for reproducible expectations.
