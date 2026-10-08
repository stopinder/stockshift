"""Bounded embedded-text table extraction. No OCR, inferred fields or row stitching."""

import io
import json
from copy import deepcopy
from hashlib import sha256
from uuid import UUID, uuid5

import pdfplumber
from pdfminer.pdfdocument import PDFPasswordIncorrect

from stockshift_worker.contracts import validate_contract
from stockshift_worker.domain.csv_engine import Catalogue, CsvOptions, normalize_rows, parse_decimal
from stockshift_worker.extraction.base import ExtractionResult


class PdfError(ValueError):
    """Actionable input errors safe to show to users."""


def open_pdf(data):
    if not 1 <= len(data) <= 10485760 or not data.startswith(b"%PDF-"):
        raise PdfError("Invalid PDF. Upload a digitally generated PDF up to 10 MiB.")
    try:
        pdf = pdfplumber.open(io.BytesIO(data))
        if pdf.doc.encryption:
            pdf.close()
            raise PdfError("Password-protected PDF. Export an unencrypted digital PDF and retry.")
        if not pdf.pages:
            pdf.close()
            raise PdfError("PDF has no pages. Export a valid digital PDF and retry.")
        return pdf
    except PDFPasswordIncorrect as exc:
        raise PdfError(
            "Password-protected PDF. Export an unencrypted digital PDF and retry."
        ) from exc
    except PdfError:
        raise
    except Exception as exc:
        if any(isinstance(arg, PDFPasswordIncorrect) for arg in exc.args):
            raise PdfError(
                "Password-protected PDF. Export an unencrypted digital PDF and retry."
            ) from exc
        raise PdfError("Corrupt or unsupported PDF. Export a new digital PDF and retry.") from exc


def inspect_pdf(data):
    with open_pdf(data) as pdf:
        return {"pages": len(pdf.pages)}


class DigitalPdfExtractor:
    """DocumentExtractor implementation; raw cells remain separate from business mapping."""

    def __init__(self, data, configuration):
        self.data, self.configuration = data, deepcopy(configuration)
        self.raw_pages = []

    def extract(self, request, context):
        req = request.to_payload()
        cfg = self.configuration
        if req["media_type"] != "application/pdf" or sha256(self.data).hexdigest() != req["sha256"]:
            raise PdfError("PDF integrity verification failed. Upload the source again.")
        first, last = cfg.get("first_page"), cfg.get("last_page")
        if (
            type(first) is not int
            or type(last) is not int
            or not 1 <= first <= last
            or last - first >= 50
            or cfg.get("strategy") not in ("lines", "text")
        ):
            raise PdfError("Select an explicit page range of at most 50 pages and table strategy.")
        if req["page_selection"] != list(range(first, last + 1)):
            raise PdfError("PDF page selection differs from extraction configuration.")
        records, evidence, failed, warnings = [], [], [], []
        self.raw_pages = []
        namespace = UUID(req["file_id"])
        strategy = cfg["strategy"]
        with open_pdf(self.data) as pdf:
            if last > len(pdf.pages):
                raise PdfError(
                    f"PDF has {len(pdf.pages)} pages. Select a page range within the file."
                )
            total = last - first + 1
            context.report_progress(completed_units=0, total_units=total)
            for completed, number in enumerate(range(first, last + 1), 1):
                if context.is_cancelled():
                    raise PdfError("Extraction cancelled. Retry when processing is available.")
                page = pdf.pages[number - 1]
                text = page.extract_text() or ""
                tables = (
                    page.find_tables(
                        {"vertical_strategy": strategy, "horizontal_strategy": strategy}
                    )
                    if text.strip()
                    else []
                )
                usable = False
                for table_index, table in enumerate(tables, 1):
                    rows = table.extract()
                    if len(rows) < 2 or max(map(len, rows), default=0) < 2:
                        continue
                    if len(rows) > 2000 or max(map(len, rows)) > 32:
                        raise PdfError(
                            "PDF table exceeds 2000 rows or 32 columns. Split the catalogue."
                        )
                    # Reject absent geometry; never invent cells or join row fragments.
                    if any(
                        len(row) != len(rows[0]) or any(box is None for box in geometry.cells)
                        for row, geometry in zip(rows, table.rows, strict=True)
                    ):
                        warnings.append(
                            {
                                "code": "unsupported_layout",
                                "field": None,
                                "message": (
                                    f"Page {number}, table {table_index} has merged or "
                                    "missing cells. OCR required or export CSV/XLSX."
                                ),
                            }
                        )
                        failed.append(number)
                        continue
                    usable = True
                    for row_index, (row, geometry) in enumerate(
                        zip(rows, table.rows, strict=True), 1
                    ):
                        record_id = str(
                            uuid5(namespace, f"page:{number}:table:{table_index}:row:{row_index}")
                        )
                        cells = []
                        for col, (value, box) in enumerate(
                            zip(row, geometry.cells, strict=True), 1
                        ):
                            if value is not None and len(value) > 10000:
                                raise PdfError(
                                    "PDF cell exceeds the supported size. Split the catalogue."
                                )
                            eid = str(uuid5(UUID(record_id), f"column:{col}"))
                            label = f"Column {col}"
                            x0, top, x1, bottom = box
                            cells.append({"column_name": label, "value": value, "evidence_id": eid})
                            evidence.append(
                                {
                                    "schema_version": "v1",
                                    "evidence_id": eid,
                                    "record_id": record_id,
                                    "source_file_id": req["file_id"],
                                    "field_name": label,
                                    "raw_text": value,
                                    "artifact": req["object"],
                                    "locator": {
                                        "page": number,
                                        "sheet": None,
                                        "row": row_index,
                                        "column": label,
                                        "table": str(table_index),
                                        "cell": f"{row_index}:{col}",
                                        "bounding_polygon": [
                                            [x0, top],
                                            [x1, top],
                                            [x1, bottom],
                                            [x0, bottom],
                                        ],
                                        "coordinate_system": "page_points",
                                    },
                                }
                            )
                        records.append(
                            {"record_id": record_id, "raw_cells": cells, "semantic_candidates": {}}
                        )
                        if len(records) > 5000:
                            raise PdfError("PDF extraction exceeds 5000 rows. Select fewer pages.")
                if not usable:
                    failed.append(number)
                    warnings.append(
                        {
                            "code": "ocr_required",
                            "field": None,
                            "message": (
                                f"Page {number} lacks usable embedded text/table "
                                "structure. OCR required; use CSV/XLSX or a ruled digital PDF."
                            ),
                        }
                    )
                self.raw_pages.append(
                    {
                        "page": number,
                        "text": text[:50000],
                        "width": page.width,
                        "height": page.height,
                        "table_count": len(tables),
                    }
                )
                context.report_progress(completed_units=completed, total_units=total)
                page.close()
        if strategy == "text":
            warnings.append(
                {
                    "code": "structure_review",
                    "field": None,
                    "message": (
                        "Text-aligned columns need manual row/column "
                        "confirmation; no automatic business mapping."
                    ),
                }
            )
        payload = {
            "schema_version": "v1",
            "tenant_id": req["tenant_id"],
            "file_id": req["file_id"],
            "job_id": req["job_id"],
            "provider": {
                "provider": "pdfplumber",
                "sdk_version": pdfplumber.__version__,
                "model_version": None,
                "config_hash": sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest(),
            },
            "raw_artifact": req["object"],
            "completion": {
                "state": "incomplete" if failed else "complete",
                "total_units": total,
                "completed_units": total,
                "pending_units": [],
                "failed_units": sorted(set(failed)),
            },
            "records": records,
            "evidence": evidence,
            "warnings": warnings,
        }
        if len(json.dumps(payload)) + len(json.dumps(self.raw_pages)) > 16000000:
            raise PdfError("PDF extraction exceeds the supported size. Select fewer pages.")
        return ExtractionResult.from_payload(payload)


def normalize_pdf(revision, *, source_file_id, source_name):
    """Apply a confirmed immutable snapshot, retaining original page evidence."""
    if (
        not revision
        or not revision.get("confirmed")
        or revision.get("source_file_id") != source_file_id
    ):
        raise PdfError("Confirm a correction revision for this PDF before comparison.")
    payload = ExtractionResult.from_payload(revision["extraction"]).to_payload()
    if (
        payload["file_id"] != source_file_id
        or payload["tenant_id"] != revision["tenant_id"]
        or payload["completion"]["state"] != "complete"
    ):
        raise PdfError(
            "PDF extraction is incomplete or outside the source. OCR required "
            "for unsupported pages."
        )
    cfg, corrections = deepcopy(revision["configuration"]), revision["corrections"]
    verified_ocr = cfg.pop("ocr_verified_rows", [])
    table, header, repeat, confirmed = (
        cfg.pop(k, None)
        for k in ("table_index", "header_row", "repeat_headers", "structure_confirmed")
    )
    if (
        type(table) is not int
        or type(header) is not int
        or table < 1
        or header < 1
        or confirmed is not True
        or type(repeat) is not bool
    ):
        raise PdfError("Confirm table, header and page continuation settings explicitly.")
    options = CsvOptions(**cfg)
    raw_evidence = {e["evidence_id"]: e for e in payload["evidence"]}
    groups = {}
    for r in payload["records"]:
        loc = raw_evidence[r["raw_cells"][0]["evidence_id"]]["locator"]
        grid_table = r["semantic_candidates"].get("layout_grid_table", loc["table"])
        if grid_table == str(table):
            groups.setdefault(loc["page"], []).append(r)
    if len(groups) != payload["completion"]["total_units"]:
        raise PdfError(
            "Selected table is absent on a page. Choose a smaller page range or another table."
        )
    headers = None
    products, evidence = [], []
    consumed = set()
    for records in groups.values():
        if header > len(records):
            raise PdfError("Header row is outside the selected table.")
        page_headers = [c["value"] or "" for c in records[header - 1]["raw_cells"]]
        if any(not h.strip() for h in page_headers) or len(set(page_headers)) != len(page_headers):
            raise PdfError(
                "PDF headers must be nonblank and unique. Select a different "
                "header/table or export CSV/XLSX."
            )
        if headers is not None and page_headers != headers:
            raise PdfError(
                "Table headers differ across pages. Extract a smaller page range; "
                "rows are never silently stitched."
            )
        headers = page_headers
        if not set(options.columns.values()) <= set(headers):
            raise PdfError("Mapped field is missing. Map SKU and price to exact detected headers.")
        for r in records[header:]:
            candidates = r["semantic_candidates"]
            if candidates.get("pricing_basis_unresolved") == "true":
                if r["record_id"] not in verified_ocr:
                    raise PdfError(
                        "Verify each OCR product row against its source before comparison."
                    )
                raise PdfError(
                    "Supplier pricing basis is unresolved; cost comparison/export is blocked."
                )
            if candidates.get("price_role") == "retail_guidance":
                if r["record_id"] not in verified_ocr:
                    raise PdfError(
                        "Verify each OCR product row against its source before comparison."
                    )
                raise PdfError("Retail guidance cannot be mapped to wholesale cost.")
            cells = [c["value"] or "" for c in r["raw_cells"]]
            if repeat and cells == headers:
                continue
            if not any(c.strip() for c in cells):
                continue
            changes = corrections.get(r["record_id"], {})
            if not set(changes) <= {
                "supplier_sku",
                "description",
                "cost_price",
                "currency",
                "pack_quantity",
                "unit",
            }:
                raise PdfError("Unsupported correction field.")
            for field, value in changes.items():
                if field not in options.columns or (
                    value is not None and not isinstance(value, str)
                ):
                    raise PdfError("Map each corrected field to its original source column.")
                if field == "supplier_sku" and (not value or value != value.strip()):
                    raise PdfError(
                        "Corrected SKU must be a nonblank identifier without surrounding spaces."
                    )
                if field in ("cost_price", "pack_quantity") and value is not None:
                    parse_decimal(value, options, money=field != "pack_quantity")
                cells[headers.index(options.columns[field])] = value or ""
            consumed.add(r["record_id"])
            loc = raw_evidence[r["raw_cells"][0]["evidence_id"]]["locator"]
            one = normalize_rows(
                source_file_id, source_name, options, headers, [(loc["row"], cells)]
            )
            product = deepcopy(one.products[0])
            product["record_id"], product["evidence_ids"] = r["record_id"], []
            if (
                any(
                    w["code"] == "ocr_verification_required" and w["field"] == r["record_id"]
                    for w in payload["warnings"]
                )
                and r["record_id"] not in verified_ocr
            ):
                raise PdfError("Verify each OCR product row against its source before comparison.")
            if any(w["code"] == "structure_review" for w in payload["warnings"]):
                product["validation_issues"].append(
                    {
                        "code": "pdf_structure_review",
                        "field": None,
                        "message": (
                            "Text-aligned PDF row requires review; extraction "
                            "structure is uncertain."
                        ),
                    }
                )
            if any(
                "\n" in cells[headers.index(options.columns[field])]
                for field in ("supplier_sku", "cost_price")
            ):
                product["validation_issues"].append(
                    {
                        "code": "pdf_row_continuation",
                        "field": None,
                        "message": (
                            "Multiline identifier/price needs review; fragments stay separate."
                        ),
                    }
                )
            for field, column in options.columns.items():
                cell = r["raw_cells"][headers.index(column)]
                e = deepcopy(raw_evidence[cell["evidence_id"]])
                e["field_name"], e["locator"]["column"] = field, column
                evidence.append(validate_contract("field-evidence", e))
                product["evidence_ids"].append(e["evidence_id"])
            products.append(validate_contract("normalized-product", product))
    if not set(corrections) <= consumed:
        raise PdfError(
            "Corrections refer to unselected/header rows. Refresh and correct "
            "only selected product rows."
        )
    if not products:
        raise PdfError("Selected PDF table contains no product rows.")
    return Catalogue(source_file_id, source_name, tuple(products), tuple(evidence))
