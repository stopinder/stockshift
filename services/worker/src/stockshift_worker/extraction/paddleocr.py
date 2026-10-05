"""Bounded PaddleOCR-VL serving adapter. Only rendered, opted-in pages leave the worker."""

import base64
import io
import json
import math
import os
from hashlib import sha256
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID, uuid5

import pypdfium2

from stockshift_worker.extraction.base import ExtractionResult
from stockshift_worker.extraction.digital_pdf import DigitalPdfExtractor, PdfError

ADAPTER_VERSION = "1"


class OcrFailure(PdfError):
    def __init__(self, code, message, *, retryable=False):
        super().__init__(message)
        self.code, self.retryable = code, retryable


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise OcrFailure(
            "ocr_redirect", "OCR service redirected the request. Check worker configuration."
        )


def setting(name, default, minimum, maximum):
    try:
        value = int(os.environ.get(name, default))
        if not minimum <= value <= maximum:
            raise ValueError
        return value
    except ValueError as exc:
        raise OcrFailure("ocr_configuration", "OCR worker limits are invalid.") from exc


class PaddleClient:
    """Official /layout-parsing image API; no URL fetching, redirects or proxy inheritance."""

    def __init__(self, model):
        self.model = os.environ.get("STOCKSHIFT_OCR_MODEL", "PaddleOCR-VL-1.6")
        self.url = os.environ.get("STOCKSHIFT_OCR_ENDPOINT", "")
        p = urlparse(self.url)
        if (
            self.model != model
            or not p.hostname
            or p.username
            or p.password
            or p.query
            or p.fragment
            or p.path != "/layout-parsing"
            or not (
                p.scheme == "https"
                or p.scheme == "http"
                and p.hostname in ("127.0.0.1", "localhost")
            )
        ):
            raise OcrFailure(
                "ocr_unavailable",
                "OCR service is not configured for this model. Ask your operator to configure it.",
                retryable=True,
            )
        self.timeout = setting("STOCKSHIFT_OCR_TIMEOUT", 30, 1, 120)
        self.token = os.environ.get("STOCKSHIFT_OCR_TOKEN", "")
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def predict(self, png, key):
        body = json.dumps(
            {
                "file": base64.b64encode(png).decode(),
                "fileType": 1,
                "useDocOrientationClassify": False,
                "useDocUnwarping": False,
                "useLayoutDetection": True,
                "useChartRecognition": False,
                "useSealRecognition": False,
                "mergeLayoutBlocks": False,
                "formatBlockContent": False,
                "restructurePages": False,
                "returnMarkdownImages": False,
                "visualize": False,
            }
        ).encode()
        headers = {"Content-Type": "application/json", "Idempotency-Key": key}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        try:
            with self.opener.open(
                Request(self.url, data=body, headers=headers), timeout=self.timeout
            ) as r:
                raw = r.read(2000001)
                if len(raw) > 2000000:
                    raise OcrFailure(
                        "ocr_response_size",
                        "OCR response is too large. Select fewer/simpler pages.",
                    )
                return json.loads(raw)
        except HTTPError as exc:
            retry = exc.code in (408, 429) or exc.code >= 500
            raise OcrFailure(
                "ocr_rate_limit" if exc.code == 429 else "ocr_unavailable",
                "OCR service is busy or unavailable. Processing will retry if eligible.",
                retryable=retry,
            ) from None
        except (URLError, TimeoutError, ConnectionError):
            raise OcrFailure(
                "ocr_timeout",
                "OCR service did not respond. Processing will retry if eligible.",
                retryable=True,
            ) from None
        except (ValueError, TypeError):
            raise OcrFailure(
                "ocr_response",
                "OCR service returned an invalid response. Ask your operator to check it.",
            ) from None


class TableParser(HTMLParser):
    """Accept rectangular plain-text cells only. Never expand merged cells or evaluate HTML."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self.row, self.cell = [], None, None
        self.tables = 0

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.tables += 1
            if self.tables > 1:
                raise ValueError("nested/multiple tables")
        elif tag == "tr":
            if self.row is not None:
                raise ValueError("nested row")
            self.row = []
        elif tag in ("td", "th"):
            if (
                self.row is None
                or self.cell is not None
                or any(k in ("rowspan", "colspan") and v != "1" for k, v in attrs)
            ):
                raise ValueError("merged cell")
            self.cell = ""
        elif tag == "br" and self.cell is not None:
            self.cell += "\n"
        elif tag not in ("thead", "tbody", "tfoot"):
            raise ValueError("unsupported HTML")

    def handle_data(self, data):
        if self.cell is not None:
            self.cell += data
            if len(self.cell) > 10000:
                raise ValueError("cell limit")
        elif data.strip():
            raise ValueError("unstructured text")

    def handle_endtag(self, tag):
        if tag in ("td", "th"):
            if self.cell is None or self.row is None:
                raise ValueError("cell boundary")
            self.row.append(self.cell.strip() or None)
            self.cell = None
        elif tag == "tr":
            if self.row is None or self.cell is not None:
                raise ValueError("row boundary")
            self.rows.append(self.row)
            self.row = None
        elif tag not in ("table", "thead", "tbody", "tfoot"):
            raise ValueError("unsupported HTML")


def response_tables(raw, width, height):
    """Retain only this page's validated blocks; discard server logs/paths/URLs."""
    try:
        if raw.get("errorCode") != 0:
            raise ValueError
        results = raw["result"]["layoutParsingResults"]
        if len(results) != 1:
            raise ValueError
        blocks = results[0]["prunedResult"]["parsing_res_list"]
        if not isinstance(blocks, list) or not 1 <= len(blocks) <= 100:
            raise ValueError
        tables, retained = [], []
        for b in blocks:
            if b.get("block_label") != "table":
                continue
            html = b["block_content"]
            if not isinstance(html, str) or len(html) > 500000:
                raise ValueError
            parser = TableParser()
            parser.feed(html)
            parser.close()
            rows = parser.rows
            if (
                parser.tables != 1
                or parser.row is not None
                or parser.cell is not None
                or not 2 <= len(rows) <= 2000
                or not 2 <= len(rows[0]) <= 32
                or any(len(r) != len(rows[0]) for r in rows)
            ):
                raise ValueError
            box = b.get("block_bbox")
            if box is not None and (
                not isinstance(box, list)
                or len(box) != 4
                or any(type(v) not in (int, float) or not math.isfinite(v) for v in box)
                or not (0 <= box[0] < box[2] <= width and 0 <= box[1] < box[3] <= height)
            ):
                raise ValueError
            score = b.get("confidence")
            if score is not None and (
                type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1
            ):
                raise ValueError
            tables.append({"rows": rows, "bbox": box, "confidence": score})
            retained.append(
                {
                    "block_label": "table",
                    "block_content": html,
                    "block_bbox": box,
                    "confidence": score,
                }
            )
        if not tables:
            raise ValueError
        return tables, {"parsing_res_list": retained}
    except (ValueError, KeyError, TypeError, AttributeError, IndexError):
        raise OcrFailure(
            "ocr_structure",
            (
                "OCR could not establish rectangular tables. Correct the source or upload "
                "CSV/XLSX; partial pages cannot be confirmed."
            ),
        ) from None


def render_page(data, number, dpi):
    try:
        with pypdfium2.PdfDocument(data) as doc:
            page = doc[number - 1]
            w, h = page.get_size()
            if w * h * (dpi / 72) ** 2 > 12000000:
                raise ValueError
            bitmap = page.render(scale=dpi / 72)
            image = bitmap.to_pil()
            out = io.BytesIO()
            image.save(out, format="PNG")
            width, height = image.size
            image.close()
            bitmap.close()
            page.close()
            png = out.getvalue()
            if not 1 <= len(png) <= 10000000:
                raise ValueError
            return png, width, height
    except Exception:
        raise OcrFailure(
            "ocr_render",
            "PDF page could not be rendered within OCR limits. Export a smaller, unencrypted PDF.",
        ) from None


class RoutedPdfExtractor:
    """DocumentExtractor combining direct pages with opt-in PaddleOCR-VL page results."""

    def __init__(self, data, configuration, *, client=None, cache=None, event=None):
        self.data, self.configuration = data, configuration
        self.client, self.cache = client, cache or {}
        self.event = event or (lambda value: None)
        self.raw_pages = []

    def extract(self, request, context):
        cfg, req = self.configuration, request.to_payload()
        if len(req["page_selection"]) > setting("STOCKSHIFT_OCR_MAX_DOCUMENT_PAGES", 50, 1, 50):
            raise OcrFailure(
                "ocr_document_limit", "Document page limit exceeded. Select fewer pages."
            )
        digital = DigitalPdfExtractor(self.data, cfg)

        # Digital inspection progress is not OCR completion; only report final routed pages.
        class Inspection:
            is_cancelled = context.is_cancelled

            def report_progress(self, **kwargs):
                pass

        payload = digital.extract(request, Inspection()).to_payload()
        failed = payload["completion"]["failed_units"]
        self.raw_pages = digital.raw_pages
        if cfg.get("provider", "digital") != "auto" or not failed:
            context.report_progress(
                completed_units=len(self.raw_pages), total_units=len(self.raw_pages)
            )
            return ExtractionResult.from_payload(payload)
        max_pages = setting("STOCKSHIFT_OCR_MAX_PAGES", 10, 1, 50)
        if len(failed) > max_pages:
            raise OcrFailure(
                "ocr_page_limit",
                f"OCR needs {len(failed)} pages; limit is {max_pages}. Select fewer pages.",
            )
        model, dpi = cfg["model_version"], cfg["dpi"]
        client = self.client or PaddleClient(model)
        digital_version = payload["provider"]["sdk_version"]
        payload["provider"].update(
            provider="digital+paddleocr-vl", sdk_version=ADAPTER_VERSION, model_version=model
        )
        bad = set(failed)
        evidence = {e["evidence_id"]: e for e in payload["evidence"]}
        payload["records"] = [
            r
            for r in payload["records"]
            if evidence[r["raw_cells"][0]["evidence_id"]]["locator"]["page"] not in bad
        ]
        ids = {r["record_id"] for r in payload["records"]}
        payload["evidence"] = [e for e in payload["evidence"] if e["record_id"] in ids]
        payload["warnings"] = [
            w
            for w in payload["warnings"]
            if w["code"] not in ("ocr_required", "unsupported_layout")
        ]
        errors = []
        context.report_progress(completed_units=0, total_units=len(self.raw_pages))
        for completed, meta in enumerate(self.raw_pages, 1):
            number = meta["page"]
            meta["provider"] = "pdfplumber"
            meta["sdk_version"] = digital_version
            if number in bad:
                if context.is_cancelled():
                    raise OcrFailure(
                        "ocr_cancelled", "OCR was cancelled; retry processing.", retryable=True
                    )
                png, width, height = render_page(self.data, number, dpi)
                key = sha256(
                    json.dumps(
                        [
                            req["tenant_id"],
                            req["file_id"],
                            req["sha256"],
                            number,
                            model,
                            ADAPTER_VERSION,
                            dpi,
                            sha256(png).hexdigest(),
                        ]
                    ).encode()
                ).hexdigest()
                meta.update(
                    provider="paddleocr-vl",
                    model_version=model,
                    adapter_version=ADAPTER_VERSION,
                    sdk_version=ADAPTER_VERSION,
                    request_hash=key,
                    rendered_sha256=sha256(png).hexdigest(),
                    dpi=dpi,
                    confidence=None,
                    rendered_width=width,
                    rendered_height=height,
                    evidence_scope="table",
                )
                try:
                    cached = self.cache.get(str(number))
                    meta["request_count"] = (cached or {}).get("request_count", 0)
                    if cached and cached["request_hash"] == key and cached["status"] == "ready":
                        raw = cached["response"]
                        tables, retained = response_tables(
                            {
                                "errorCode": 0,
                                "result": {"layoutParsingResults": [{"prunedResult": raw}]},
                            },
                            width,
                            height,
                        )
                    else:
                        meta["request_count"] += 1
                        self.event({"ocr_request": {"page": number, "request_hash": key}})
                        tables, retained = response_tables(client.predict(png, key), width, height)
                        self.event(
                            {
                                "ocr_page": {
                                    "page": number,
                                    "request_hash": key,
                                    "response": retained,
                                }
                            }
                        )
                    meta.update(
                        status="completed",
                        table_count=len(tables),
                        text="\n".join(
                            " | ".join(v or "" for v in r) for t in tables for r in t["rows"]
                        )[:50000],
                    )
                    meta["confidence"] = min(
                        (t["confidence"] for t in tables if t["confidence"] is not None),
                        default=None,
                    )
                    for ti, table in enumerate(tables, 1):
                        for ri, row in enumerate(table["rows"], 1):
                            rid = str(uuid5(UUID(req["file_id"]), f"ocr:{key}:table:{ti}:row:{ri}"))
                            cells = []
                            for ci, value in enumerate(row, 1):
                                eid = str(uuid5(UUID(rid), f"column:{ci}"))
                                label = f"Column {ci}"
                                box = table["bbox"]
                                cells.append(
                                    {"column_name": label, "value": value, "evidence_id": eid}
                                )
                                payload["evidence"].append(
                                    {
                                        "schema_version": "v1",
                                        "evidence_id": eid,
                                        "record_id": rid,
                                        "source_file_id": req["file_id"],
                                        "field_name": label,
                                        "raw_text": value,
                                        "artifact": req["object"],
                                        "locator": {
                                            "page": number,
                                            "sheet": None,
                                            "row": ri,
                                            "column": label,
                                            "table": str(ti),
                                            "cell": f"{ri}:{ci}",
                                            "bounding_polygon": None
                                            if box is None
                                            else [
                                                [box[0], box[1]],
                                                [box[2], box[1]],
                                                [box[2], box[3]],
                                                [box[0], box[3]],
                                            ],
                                            "coordinate_system": None
                                            if box is None
                                            else "page_pixels",
                                        },
                                    }
                                )
                            payload["records"].append(
                                {"record_id": rid, "raw_cells": cells, "semantic_candidates": {}}
                            )
                            payload["warnings"].append(
                                {
                                    "code": "ocr_verification_required",
                                    "field": rid,
                                    "message": (
                                        "Verify this OCR row against source. Confidence is "
                                        "uncalibrated or unavailable. Bounds refer to the "
                                        "table, not individual cells."
                                    ),
                                }
                            )
                except OcrFailure as exc:
                    meta.update(status="failed", error_code=exc.code, message=str(exc))
                    self.event(
                        {
                            "ocr_failure": {
                                "page": number,
                                "request_hash": key,
                                "failure": {
                                    "code": exc.code,
                                    "message": str(exc),
                                    "retryable": exc.retryable,
                                },
                            }
                        }
                    )
                    errors.append(exc)
            context.report_progress(completed_units=completed, total_units=len(self.raw_pages))
        if errors and any(e.retryable for e in errors):
            raise next(e for e in errors if e.retryable)
        payload["completion"]["failed_units"] = [
            p["page"] for p in self.raw_pages if p.get("status") == "failed"
        ]
        payload["completion"]["state"] = "incomplete" if errors else "complete"
        if errors:
            payload["warnings"].append(
                {
                    "code": "ocr_partial_failure",
                    "field": None,
                    "message": (
                        "Some OCR pages failed; this catalogue cannot be confirmed. "
                        "Upload a corrected source."
                    ),
                }
            )
        if (
            len(payload["records"]) > 5000
            or len(json.dumps(payload)) + len(json.dumps(self.raw_pages)) > 16000000
        ):
            raise OcrFailure(
                "ocr_output_limit", "OCR extraction exceeds document limits. Select fewer pages."
            )
        # Preserve original page order in mixed documents.
        locators = {e["record_id"]: e["locator"] for e in payload["evidence"]}
        payload["records"].sort(
            key=lambda r: (
                locators[r["record_id"]]["page"],
                int(locators[r["record_id"]]["table"]),
                locators[r["record_id"]]["row"],
            )
        )
        return ExtractionResult.from_payload(payload)
