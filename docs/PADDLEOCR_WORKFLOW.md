# Scanned PDF extraction (Increment 8)

## Boundary and routing

`RoutedPdfExtractor` implements the existing validated `DocumentExtractor` protocol.
The worker first runs pdfplumber on every selected page. Pages with complete, usable
embedded table geometry stay digital; scanned or unsupported pages alone are rendered
and sent to the PaddleOCR-VL serving adapter. CSV/XLSX never enter this provider.
Original page order survives routing. Tables/row fragments are never joined across
pages; explicit headers, column mappings and page-continuation confirmation remain
mandatory. The existing normalizer, deterministic engine, results, review and export
pipeline are reused.

The browser defaults to **Digital extraction only**. To process scans, choose
**Digital + OCR for required pages**, select a bounded page range and extract.
Digital-only OCR-required evidence remains immutable; opting into OCR creates a
distinct configuration/job. Heavy processing runs in an isolated worker subprocess,
never in the Vercel API. The API only validates the private PDF and reports page count
and configured model identity. No endpoint URL or token reaches the browser.

## Worker configuration

Configure the worker process environment explicitly; do not put tokens in Vite
variables, command arguments, repository files or browser settings.

| Variable | Default / requirement |
| --- | --- |
| `STOCKSHIFT_OCR_ENDPOINT` | Operator-controlled URL ending `/layout-parsing`; HTTPS, or HTTP on loopback only |
| `STOCKSHIFT_OCR_TOKEN` | Optional endpoint bearer token; worker only |
| `STOCKSHIFT_OCR_MODEL` | `PaddleOCR-VL-1.6`; must match the persisted extraction configuration and actual deployed model |
| `STOCKSHIFT_OCR_TIMEOUT` | 30 seconds per HTTP call, configurable 1–120 |
| `STOCKSHIFT_OCR_MAX_PAGES` | 10 OCR pages per selected document, configurable 1–50 |
| `STOCKSHIFT_OCR_MAX_DOCUMENT_PAGES` | 50 selected pages maximum, configurable 1–50 |

The local web process must use the same `STOCKSHIFT_OCR_MODEL` identity if changed.
Start the installed worker with `npm run worker:local` after the local Supabase stack
is ready. That launcher obtains only loopback credentials. There are no hosted
Supabase setup/link/migration instructions in this workflow.

The adapter follows PaddleOCR's official JSON **POST /layout-parsing** image API:
base64 PNG `file`, `fileType: 1`, and a single `layoutParsingResults` entry containing
`prunedResult.parsing_res_list` table blocks. It accepts rectangular HTML tables with
plain text cells. Merged/nested/ragged tables, unsafe markup, invalid geometry,
multiple image-page responses and missing tables fail visibly. No remote URLs from
the response are fetched or displayed. Server paths, logs, URLs and unrelated block
metadata are discarded; validated table evidence is retained privately.

An HF Inference Endpoint or equivalent GPU service can wrap this same serving
contract. Deployment, model provisioning and GPU scale-to-zero are future operator
work, not implemented here. `model_version` is an operator-declared immutable identity,
not remote model attestation. Operators must change it when changing weights/pipeline.
Official references:
[PaddleOCR-VL serving documentation](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PaddleOCR-VL.html)
and [PaddleOCR repository](https://github.com/PaddlePaddle/PaddleOCR).

## Deterministic preprocessing and limits

PDFium (`pypdfium2==5.14.0`) renders only routed pages at 144 DPI, respecting PDF page
rotation. No automatic orientation, grayscale, contrast correction, unwarping or
cross-page restructuring is applied. Provider preprocessing/merging is disabled so
returned geometry stays in rendered page coordinates. Each page is limited to 12
million pixels and 10 MB rendered PNG; source PDFs remain bounded to 10 MiB.
Responses are bounded to 2 MB/page, 100 blocks, 32 columns, 2,000 rows/table and
10,000 characters/cell. Document limits remain 5,000 rows and 16 MB extraction output.
The isolated OCR subprocess has a 180-second total deadline and is killed on lease
loss or timeout. Select smaller ranges for slow services.

## Evidence, confidence and correction

Extraction runs retain provider/model/adapter/configuration hashes. Each routed page
stores page number, rendered dimensions/DPI/hash, request hash, provider, status and
available uncalibrated provider score. Original cell text and table bounding geometry
remain in the common evidence contract, with page/table/row/column references.
Table geometry is explicitly table-level; it is never presented as detected cell
geometry. Missing confidence stays null, never a fabricated percentage.

Every OCR product row requires explicit **Checked against source** verification,
even when the provider supplies a high score. Correct values remain separate from
original OCR evidence. Changing a row's corrected fields clears its verification.
The append-only revision saves verified row IDs, corrections, actor and timestamp;
confirmation is gated in the browser and PostgreSQL and checked again during
normalization. Drafts/verification survive reload. Blank/invalid prices and existing
compatibility/matching uncertainty continue into review; OCR verification does not
approve uncertain matches. No arithmetic or SKU repair is performed by the model.

## Cache, usage and failures

Private, RLS-enabled `private.ocr_pages` uses tenant/extraction/source foreign keys
and one row per selected OCR page. Browser roles cannot read or write this cache.
Worker RPCs validate the active tenant/job/source/lease before every event. The child
waits for the parent to persist request authorization before sending page bytes, and
waits for cache publication before continuing. Completed responses/digests are
immutable and conflicting completion is rejected.

Request keys bind tenant/source identity, source SHA, page, model/adapter version,
DPI and rendered SHA. Configuration digest separates digital and OCR extraction;
enqueue is idempotent. Retries reuse completed page responses, and corrections,
filters, refresh and comparison retries never rerun OCR. Usage records count reserved
provider requests per page (maximum three) and retain failures. A reservation may
outlive a worker crash before the HTTP call; this is attempted usage, not confirmed
billable usage. The endpoint receives a stable `Idempotency-Key`; operators must
implement that header at the service boundary to prevent repeated GPU charging after
a crash between remote completion and local cache publication. Native Paddle serving
is not assumed to provide exactly-once billing. No customer billing is added.

HTTP 429/408/5xx, transport failures and timeouts produce safe structured retryable
errors using the existing queue backoff/max-attempt policy. Completed earlier pages
remain cached. Other invalid/unsupported provider output produces visible failed-page
metadata and incomplete/OCR-required extraction; partial catalogues cannot be
confirmed or reconciled. Exhausted jobs are dead-lettered. Private original bytes are
sent only as controlled rendered page data over the configured service connection;
there are no public permanent URLs and no Supabase credentials in the OCR subprocess.

## Local stub and verification

Install the locked worker development environment. For a manual **synthetic stub**:

```powershell
services/worker/.venv/Scripts/python.exe services/worker/tests/ocr_stub.py 8771
$env:STOCKSHIFT_OCR_ENDPOINT = 'http://127.0.0.1:8771/layout-parsing'
npm run worker:local
```

Use fixtures generated by `tests/ocr_fixture.py` (base64 scanned supplier PDF; optional
`mixed` and `incoming` arguments). The stub recognizes only the exact rendered hashes
of these repository fixtures. It does not recognize text, run PaddleOCR or accept
customer documents. Optional `rate_once`, `unavailable` and `malformed` modes exercise
failure handling. Stop the stub and clear its environment variable after use.

Python tests exercise real PDF rendering, page routing, normalization, isolated
subprocesses and local HTTP with deterministic provider output. Docker-backed local
Supabase tests exercise actual cache/usage, leases, RLS, immutable corrections,
results and exports. Browser QA uses the synthetic serving stub at all three widths.
Installed-wheel and network-disabled CPU container smoke also use synthetic provider
output. CI has no paid/live GPU dependency. These checks establish integration and
security behavior, not model extraction accuracy. No real PaddleOCR-VL model inference
was run for this increment; representative real-model quality validation remains an
operator task before enabling the endpoint for customer files.
