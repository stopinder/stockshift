# Local persistent CSV/XLSX workflow

Increments 5–6 connect the browser to local Auth, private uploads, durable Python jobs,
persisted outcomes, audited review exclusions and trusted changed-products export.
Use Node 22.12–22.x / npm 10.x, Docker and Python 3.11–3.14. No hosted setup is provided.

From the repository root:

```powershell
npm ci
npm run supabase:local -- start
npm run supabase:local -- db reset --local
uv sync --project services/worker --locked
npm run seed:local
```

Reset deletes local database/storage data. The seed command prints a newly generated
synthetic account and password; keep them locally. It grants ownership of a local
workspace without implementing account administration or public signup.

In separate terminals:

```powershell
npm run dev:local
npm run worker:local
```

Open `http://127.0.0.1:5173`, sign in with the generated account and create a comparison.
Choose/create a supplier, then upload the current and new UTF-8 CSVs or XLSX workbooks. Either side may use a different format. Private upload
registration, signed transfer and server verification must finish for both inputs.
Upload states are real stages, not invented percentage progress. Each file is limited
to 10 MiB. Failed uploads can be retried; attached files are immutable.

For a repeatable sample use `tests/fixtures/csv/old_catalogue.csv` and
`tests/fixtures/csv/new_supplier_catalogue.csv`. For **both** files use:

- Headers: SKU, Price, Description.
- Delimiter comma; decimal dot; no thousands separator.
- Currency GBP; unit each; pack quantity 1; per-unit price; net tax.
- No currency symbol prefix.

These commercial assumptions are explicit defaults for every row. This increment's
mapping form exposes SKU/cost/description; files requiring per-row commercial-field
mapping should be prepared accordingly. No conventions are inferred from file content.

Start comparison. The worker polls, claims a lease, validates source bytes and tenant
ownership, normalizes either format and runs the shared deterministic reconciliation and atomically publishes results.
Keep the worker terminal running. The browser polls persisted state; refresh or leave
and re-enter without losing a queued run, results or attached files. CSV draft mapping fields are not persisted until enqueue. XLSX draft selection/mapping
is retained in this browser for re-entry; the authoritative configuration is snapshotted on enqueue. A failed run requires a new comparison
with corrected files/settings; retries for transient worker failures remain automatic.

The sample yields 100 outcomes: 50 unchanged, 30 changed, 10 new, 8 absent, 2 needing
review. Counts come from persisted database rows. Search SKU/description or filter
outcomes; results page in groups of 100. Inspect a row to see both normalized records,
compatibility reasons, candidate basis and field-level source evidence.

Review decisions are append-only `reject` or `no_match` exclusions with actor, reason
and timestamp. No-match is allowed only for unpaired records. Unsupported matches
cannot be approved or arbitrarily recomputed in this increment. Original worker
classifications, candidates and evidence remain unchanged. There is no undo; create
a corrected comparison if inputs need adjustment. Viewers can inspect/export but only
owners/editors can create comparisons, upload, enqueue or resolve review.

Resolve every review item before export. Export downloads `changed_products.csv`,
generated server-side from the tenant-authorized database RPC. It includes only
deterministic `changed` / `not_required` rows, excluding uncertain/excluded, new, absent
and unchanged rows. Columns and ordering are deterministic; decimals retain original
text precision, undefined percentages are empty with an explicit state, identifiers
stay strings, and dangerous spreadsheet text prefixes receive an apostrophe. CSV
consumers must import identifier columns as text to prevent their own numeric coercion.
Empty completed comparisons export a header-only CSV. No ERP-specific mappings exist.

All launchers use the running loopback stack's keys and discard hosted credential
variables. Only the public local key is exposed to Vite; service secrets stay server/worker
side. API/browser/worker configuration refuses hosted URLs. A production build without
local public configuration displays a connection-required state and makes no hosted calls.

## Verification

```powershell
npm run supabase:local -- db reset --local
npm run test:local
npm run test --workspaces
npm run typecheck
npm run build
npm run format:check
uv run --project services/worker pytest
uv run --project services/worker ruff check .
uv run --project services/worker ruff format --check .
uv build --project services/worker
```

Browser checks use real local Auth/Storage/Postgres and execute the real Python worker:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/.tools/browsers"
npx playwright install chromium
npm run test:browser
```

Run browser tests while no independent polling worker is active; the test runner
explicitly executes each queued job. Tests create synthetic local users/workspaces.
Screenshots/traces/downloads live in ignored `.tools/`. Desktop, tablet and mobile
coverage includes uploads, queue, reload, filters, review, export and error/empty states.

## XLSX workbooks

Install the locked Python worker (`uv sync --project services/worker --locked`) before
starting the local web server. XLSX finalization and preview call its installed
`stockshift_worker.entrypoints.workbook` module over private stdin, without shell,
credentials or network. This adapter is local-only; no hosted Python/API deployment
is configured. Reconciliation continues through the existing polling worker.

1. Upload an ordinary, unencrypted `.xlsx` file (10 MiB maximum). Extension and
   authoritative file structure determine verified MIME; browser MIME is not trusted.
2. Choose a visible worksheet explicitly. Hidden sheets are listed but disabled;
   empty worksheets are rejected. No worksheet or business fields are guessed.
3. Enter the header row (1–200), then Refresh header preview. Headers must be
   unique, nonblank plain text in consecutive columns. Preview shows at most five
   rows and truncates each cell to 200 characters; Vue renders text without HTML.
4. Map SKU, cost and optionally description. Currency, pack quantity and UOM can
   map to separate columns; mapped blanks stay null instead of falling back to
   defaults. Supply explicit file-wide commercial defaults for unmapped fields.
   Text prices use your decimal/thousands/symbol settings; stored numeric prices
   use their raw OOXML decimal token, without binary float conversion or rounding.
5. Start comparison; reload/re-enter to see persisted processing, results and review.
   Review and changed-products CSV export behave exactly as for CSV inputs.

Text identifiers preserve leading zeros. A numeric identifier may use an unambiguous
simple zero mask (`00000`) to preserve its displayed padding. General-format integer
identifiers up to 15 digits retain their stored token. Missing zeros already lost by
Excel cannot be recovered. Fractional/scientific/long numeric identifiers and other
identifier formatting are rejected: store identifiers as text in the source workbook.
Formatting never supplies currency, pack quantities or business meaning.

All mapped formulas are rejected, including cached values: this worker does not
calculate formulas or assert cache freshness. Replace formulas with saved literal
values. Mapped dates/times, boolean/error cells and ambiguous identifiers stop the
job with an actionable error and no partial results. Invalid textual or negative
prices and blank required values retain null values and go to review; they never
become zero. Source evidence records file, worksheet, physical row, header and
original raw token. CSV physical-line provenance is unchanged.

Supported workbook limits: 50 worksheets, 256 columns, 20,200 physical worksheet
rows, 200,000 cells per selected sheet, 1,000 ZIP entries and 40 MiB expanded content;
the shared worker still caps reconciliation at 20,000 outcomes. Merged cells,
nonconsecutive/duplicate headers, external links, macros/templates, malformed XML,
unsupported archive layouts and encrypted/legacy OLE containers require a fresh
values-only `.xlsx` copy. Passwords are never requested or used. ZIP expansion limits
and `defusedxml==0.7.1` protect the direct XML reader. `openpyxl==3.1.5` is a test-only
fixture writer; production ingestion uses Python `zipfile`, defused XML and Decimal.

No PDF/OCR, fuzzy matching, margin calculations, XLSX export, billing, customer
export mappings or hosted worker deployment are introduced.
