# Local persistent CSV workflow

Increment 5 connects the browser to local Auth, private uploads, durable Python jobs,
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
Choose/create a supplier, then upload the current and new UTF-8 CSVs. Private upload
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
ownership, runs deterministic CSV reconciliation and atomically publishes results.
Keep the worker terminal running. The browser polls persisted state; refresh or leave
and re-enter without losing a queued run, results or attached files. Unsaved draft
mapping fields are not persisted until enqueue. A failed run requires a new comparison
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
