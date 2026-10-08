"""Explicit, offline layout interpretation; never relax the OCR grid validator."""

import json
import math
import re
from copy import deepcopy
from decimal import Decimal
from hashlib import sha256
from html import escape
from html.parser import HTMLParser
from uuid import UUID, uuid5

from stockshift_worker.extraction.base import ExtractionResult
from stockshift_worker.extraction.digital_pdf import PdfError
from stockshift_worker.extraction.paddleocr import response_tables


class LayoutFailure(PdfError):
    """Actionable, content-free reason for an unsupported layout."""


def require(condition, reason):
    if not condition:
        raise LayoutFailure(reason)


def response_digest(raw):
    return sha256(json.dumps(raw, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def retail_decimal(text):
    """This explicit GBP source format only; no rounding or locale inference."""
    require(
        re.fullmatch(r"£(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\.[0-9]+", text) is not None,
        "Price does not match the verified GBP decimal format; correct against source.",
    )
    return str(Decimal(text[1:].replace(",", "")))


class LayoutTable(HTMLParser):
    """Record physical cells/spans without expanding them; images remain opaque."""

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.rows, self.row, self.cell, self.tables = [], None, None, 0
        self.closed = False
        self.feed(html)
        self.close()
        require(
            self.tables == 1 and self.closed and self.row is None and self.cell is None,
            "Close exactly one layout table and all rows/cells.",
        )

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.tables += 1
            require(
                self.tables == 1 and not attrs, "Nested/attributed layout tables are unsupported."
            )
        elif tag == "tr":
            require(
                self.tables == 1 and not self.closed and self.row is None and not attrs,
                "Nested/outside/attributed layout rows are unsupported.",
            )
            self.row = []
        elif tag in ("td", "th"):
            require(self.row is not None and self.cell is None, "Invalid layout cell boundary.")
            require(
                len(dict(attrs)) == len(attrs)
                and all(
                    k in ("rowspan", "colspan")
                    and isinstance(v, str)
                    and v.isdigit()
                    and 1 <= int(v) <= 2000
                    for k, v in attrs
                ),
                "Unsupported cell attributes or span size.",
            )
            self.cell = {"text": "", "attrs": dict(attrs), "images": []}
        elif tag == "img":
            require(self.cell is not None, "Image outside a layout cell.")
            # Never evaluate, fetch or normalize markup. Even malformed image attributes
            # can only be retained as explicitly attested, excluded illustration evidence.
            self.cell["images"].append(self.get_starttag_text())
        elif tag == "br":
            require(self.cell is not None, "Line break outside a cell.")
            self.cell["text"] += "\n"
        else:
            require(tag in ("thead", "tbody", "tfoot") and not attrs, "Unsupported layout HTML.")

    def handle_startendtag(self, tag, attrs):
        require(tag in ("img", "br"), "Unsupported self-closing layout element.")
        self.handle_starttag(tag, attrs)

    def handle_data(self, data):
        if self.cell is not None:
            self.cell["text"] += data
            require(len(self.cell["text"]) <= 10000, "Layout cell exceeds text limit.")
        else:
            require(not data.strip(), "Unexplained text outside layout cells.")

    def handle_endtag(self, tag):
        if tag in ("td", "th"):
            require(self.row is not None and self.cell is not None, "Invalid layout cell end.")
            self.row.append(self.cell)
            require(len(self.row) <= 33, "Layout row exceeds column limit.")
            self.cell = None
        elif tag == "tr":
            require(self.row is not None and self.cell is None, "Invalid layout row end.")
            self.rows.append(self.row)
            require(len(self.rows) <= 2000, "Layout table exceeds row limit.")
            self.row = None
        elif tag == "table":
            require(
                self.tables == 1 and not self.closed and self.row is None and self.cell is None,
                "Invalid layout table boundary.",
            )
            self.closed = True
        else:
            require(tag in ("thead", "tbody", "tfoot"), "Unsupported layout end tag.")

    def handle_comment(self, data):
        raise LayoutFailure("Unexplained HTML comments block layout acceptance.")

    def handle_decl(self, decl):
        raise LayoutFailure("Unsupported HTML declaration in layout table.")


def interpret_layout(raw, association):
    """Return a proposed plain grid and exact origins, not accepted product records."""
    require(len(json.dumps(raw).encode()) <= 2_000_000, "Layout response exceeds page limit.")
    require(
        association.get("source_verified") is True,
        "Verify header/product association against the original source first.",
    )
    require(
        association.get("response_sha256") == response_digest(raw),
        "Response changed; re-verify the layout association.",
    )
    require(raw.get("errorCode") == 0, "Provider response is not successful.")
    metadata = raw["metadata"]
    require(
        metadata["model"] == "PaddleOCR-VL-1.6"
        and metadata["model_revision"] == association["model_revision"],
        "Provider/model revision differs from the source-verified association.",
    )
    pages = raw["result"]["layoutParsingResults"]
    require(len(pages) == 1, "Interpret one source page at a time.")
    identity = pages[0]["page"]
    require(
        identity["sha256"] == association["page_sha256"] and identity["index"] == 0,
        "Source page identity differs.",
    )
    width, height = identity["width"], identity["height"]
    blocks = pages[0]["prunedResult"]["parsing_res_list"]
    require(isinstance(blocks, list) and 1 <= len(blocks) <= 100, "Invalid layout block count.")
    for block in blocks:
        box = block.get("block_bbox")
        score = block.get("confidence")
        require(
            score is None
            or type(score) in (int, float)
            and math.isfinite(score)
            and 0 <= score <= 1,
            "Invalid layout confidence value.",
        )
        require(
            isinstance(block["block_content"], str) and len(block["block_content"]) <= 500000,
            "Invalid layout block content.",
        )
        require(
            isinstance(box, list)
            and len(box) == 4
            and all(type(v) in (int, float) and math.isfinite(v) for v in box)
            and 0 <= box[0] < box[2] <= width
            and 0 <= box[1] < box[3] <= height,
            "Invalid layout geometry.",
        )
    if association.get("layout_kind") == "physical_catalogue":
        return interpret_physical_catalogue(raw, association, blocks, width, height)
    hi, bi = association["header_block"], association["product_block"]
    require(
        type(hi) is int and type(bi) is int and 0 <= hi < bi < len(blocks),
        "Select distinct ordered header and product blocks.",
    )
    context = association["context_blocks"]
    require(
        set(context) == {str(i) for i in range(len(blocks)) if i not in (hi, bi)},
        "Classify every remaining block; unexplained content blocks acceptance.",
    )
    require(
        all(
            context[str(i)] in ("section_title", "source_annotation")
            and blocks[i]["block_label"] in ("paragraph_title", "vision_footnote")
            for i in range(len(blocks))
            if i not in (hi, bi)
        ),
        "Unexpected context block; verify its role explicitly.",
    )
    require(
        blocks[hi]["block_label"] == blocks[bi]["block_label"] == "table",
        "Selected header/body blocks must be tables.",
    )
    header = LayoutTable(blocks[hi]["block_content"]).rows
    body = LayoutTable(blocks[bi]["block_content"]).rows
    require(
        len(header) == 1 and all(not c["attrs"] and not c["images"] for c in header[0]),
        "Select one unmerged plain-text header row.",
    )
    columns = association["columns"]
    require(len(columns) == len(header[0]) == 5, "Map all five source columns explicitly.")
    require(
        [c["field"] for c in columns]
        == [
            "description",
            "supplier_sku",
            "dispatch_code",
            "retail_price_ex_vat",
            "retail_price_inc_vat",
        ],
        "Explicit description/code/retail price roles are required; no cost inference.",
    )
    require(
        [h["text"] for h in header[0]]
        == ["", "Product Code", "Dispatch Code", "Price (ex. VAT)", "Price (inc. VAT)"],
        "Unsupported/missing price headers; re-verify the source association.",
    )
    require(
        all(
            c.get("source_verified") is True
            and c["source_header"] == h["text"]
            and isinstance(c["label"], str)
            and c["label"].strip()
            for c, h in zip(columns, header[0], strict=True)
        ),
        "Headers changed or ambiguous; source-verify every column association.",
    )
    labels = [c["label"] for c in columns]
    require(
        len(set(labels)) == len(labels) and len({h["text"] for h in header[0]}) == 5,
        "Duplicate/ambiguous headers block acceptance.",
    )
    require(
        association["price_role"] == "retail_guidance", "Price basis must remain retail guidance."
    )
    require(
        association.get("currency") == "GBP",
        "Verify the currency/decimal format explicitly; no inferred price basis.",
    )
    section = association["section"]
    require(
        len(body) >= 3
        and section["row"] == 1
        and len(body[0]) == 2
        and [c["text"] for c in body[0]] == section["texts"]
        and body[0][0]["attrs"] == {}
        and body[0][1]["attrs"] == {"colspan": "5"}
        and all(not c["images"] for c in body[0]),
        "Section heading changed; unsupported section layout.",
    )
    illustration = association["illustration"]
    image = body[1][0]
    require(
        illustration["row"] == 2
        and illustration["column"] == 1
        and image["attrs"] == {"rowspan": str(len(body) - 1)}
        and len(image["images"]) == 1
        and not image["text"].strip()
        and sha256(image["images"][0].encode()).hexdigest() == illustration["markup_sha256"],
        "Illustration placement/extent changed; do not expand product spans.",
    )
    grid, origins = [labels], [[{"block": hi, "row": 1, "column": i + 1} for i in range(5)]]
    for ri, physical in enumerate(body[1:], 2):
        # Remove only the explicitly attested opaque illustration, never pad/expand rows.
        offset = 1 if ri == 2 else 0
        cells = physical[offset:]
        require(
            len(cells) == 5 and all(not c["attrs"] and not c["images"] for c in cells),
            "Product grid contains spans, images or unexplained cells.",
        )
        values = [c["text"] for c in cells]
        require(
            all(values[i].strip() for i in (0, 1, 3, 4)),
            "Product description/code/price is missing; source correction required.",
        )
        retail_decimal(values[3])
        retail_decimal(values[4])
        grid.append(values)
        origins.append([{"block": bi, "row": ri, "column": ci + offset + 1} for ci in range(5)])
    return {
        "grid": grid,
        "origins": origins,
        "original": deepcopy(raw),
        "association": deepcopy(association),
        "width": width,
        "height": height,
        "product_bbox": deepcopy(blocks[bi]["block_bbox"]),
        "confidence": blocks[bi].get("confidence"),
    }


def interpret_physical_catalogue(raw, plan, blocks, width, height):
    """Project explicitly attested physical rows; never expand spans or guess units."""
    bi = plan["product_block"]
    require(type(bi) is int and 0 <= bi < len(blocks), "Select an existing product block.")
    require(blocks[bi]["block_label"] == "table", "Product block must be a table.")
    context = plan["context_blocks"]
    require(
        set(context) == {str(i) for i in range(len(blocks)) if i != bi},
        "Classify every remaining block; unexplained content blocks acceptance.",
    )
    for index, role in context.items():
        require(
            role in ("section_title", "source_annotation")
            and blocks[int(index)]["block_label"]
            == ("paragraph_title" if role == "section_title" else "vision_footnote"),
            "Unexpected context block; verify its role explicitly.",
        )
    rows = LayoutTable(blocks[bi]["block_content"]).rows
    columns = plan["columns"]
    require(2 <= len(columns) <= 32, "Map every physical column explicitly.")
    require(
        all(c.get("source_verified") is True for c in columns),
        "Source-verify every column association.",
    )
    require(
        len({c["source_header"] for c in columns}) == len(columns)
        and len({c["field"] for c in columns}) == len(columns)
        and all(c["source_header"].strip() and c["label"].strip() for c in columns),
        "Missing or duplicate headers/roles block acceptance.",
    )
    require(
        all(
            c["field"]
            in {
                "supplier_sku",
                "description",
                "cost_price",
                "illustration",
                "serial",
                "colour",
                "uom_raw",
                "box_qty_pcs",
                "box_qty_mts",
                "length_raw",
                "quantity_raw",
                "finish",
            }
            for c in columns
        ),
        "Unsupported column role; reserved review metadata cannot be mapped.",
    )
    kept = [i for i, c in enumerate(columns) if c["field"] != "illustration"]
    labels = [columns[i]["label"] for i in kept]
    fields = [columns[i]["field"] for i in kept]
    require(len(set(labels)) == len(labels), "Duplicate projected labels block acceptance.")
    require(
        {"supplier_sku", "description", "cost_price"} <= set(fields),
        "Explicit code, description and supplier price columns required.",
    )
    require(
        plan["price_role"] == "supplier_price"
        and plan["currency"] == "GBP"
        and plan["price_basis"] is None
        and plan["pack_quantity"] is None
        and plan["tax_basis"] in (None, "net"),
        "This layout requires unresolved source pricing basis; no pack/unit inference.",
    )
    section = plan["section"]
    source = section["source_evidence"]
    require(
        section.get("source_verified") is True
        and section["text"].strip()
        and re.fullmatch(r"[0-9a-f]{64}", source["sha256"]) is not None
        and source["page"] == plan["original_source_page"]
        and source["text"] == section["text"],
        "Verify section context against the original source page.",
    )
    require(
        plan["row_roles"]
        and len(plan["row_roles"]) == len(rows)
        and plan["row_roles"][0]["kind"] == "header",
        "Classify every physical row; no discarded or unexplained content.",
    )
    grid, origins = [], []
    for ri, (cells, role) in enumerate(zip(rows, plan["row_roles"], strict=True), 1):
        kind = role["kind"]
        require(role.get("source_verified") is True, "Source-verify each row association.")
        if kind == "section":
            require(
                len(cells) == 1
                and cells[0]["attrs"] == {"colspan": str(len(columns))}
                and not cells[0]["images"]
                and cells[0]["text"] == role["text"] == section["text"],
                "Section heading differs; never expand a merged product cell.",
            )
            continue
        require(
            len(cells) == len(columns) and all(not c["attrs"] for c in cells),
            "Physical product/header rows must be rectangular and unmerged.",
        )
        if kind == "blank_separator":
            require(
                all(not c["text"].strip() and not c["images"] for c in cells),
                "Verified separator contains unexplained content.",
            )
            continue
        require(kind in ("header", "product"), "Unsupported row role.")
        require((kind == "header") == (ri == 1), "Select the first plain header explicitly.")
        for ci, (cell, column) in enumerate(zip(cells, columns, strict=True), 1):
            if kind == "header":
                require(
                    not cell["images"] and cell["text"] == column["source_header"],
                    "Headers changed/missing; source-verify column associations again.",
                )
            elif column["field"] == "illustration":
                require(
                    not cell["text"].strip()
                    and len(cell["images"]) == 1
                    and role["illustrations"].get(str(ci))
                    == sha256(cell["images"][0].encode()).hexdigest(),
                    "Image-only cell differs from verified illustration evidence.",
                )
            else:
                require(not cell["images"], "Image inside a product field blocks acceptance.")
        values = [cells[i]["text"] for i in kept]
        if kind == "product":
            require(
                all(
                    values[fields.index(f)].strip()
                    for f in ("supplier_sku", "description", "cost_price")
                ),
                "Product code/description/price is missing; verify against source.",
            )
            price = values[fields.index("cost_price")]
            require(
                plan["price_format"] in (r"[0-9]+\.[0-9]+", r"£[0-9]+\.[0-9]+")
                and re.fullmatch(plan["price_format"], price) is not None,
                "Price differs from the explicitly verified GBP decimal format.",
            )
        grid.append(values)
        origins.append([{"block": bi, "row": ri, "column": i + 1} for i in kept])
    require(len(grid) > 1, "No reliably associated product rows.")
    return {
        "grid": grid,
        "origins": origins,
        "original": deepcopy(raw),
        "association": deepcopy(plan),
        "width": width,
        "height": height,
        "product_bbox": deepcopy(blocks[bi]["block_bbox"]),
        "confidence": blocks[bi].get("confidence"),
        "columns": [columns[i] for i in kept],
    }


def validate_product_grid(layout):
    """Use the existing rectangular validator unchanged on the explicit projection."""
    html = (
        "<table>"
        + "".join(
            "<tr>" + "".join("<td>" + escape(v) + "</td>" for v in row) + "</tr>"
            for row in layout["grid"]
        )
        + "</table>"
    )
    raw = {
        "errorCode": 0,
        "result": {
            "layoutParsingResults": [
                {
                    "prunedResult": {
                        "parsing_res_list": [
                            {
                                "block_label": "table",
                                "block_content": html,
                                "block_bbox": layout["product_bbox"],
                                "confidence": layout["confidence"],
                            }
                        ]
                    }
                }
            ]
        },
    }
    tables, _ = response_tables(raw, layout["width"], layout["height"])
    require(
        tables[0]["rows"] == layout["grid"],
        "Product values require correction; never silently trim or alter source strings.",
    )
    return tables


class CatalogueLayoutExtractor:
    """Offline review envelope plus immutable layout sidecar; not auto-enabled for live jobs."""

    def __init__(self, response, association):
        self.response, self.association = deepcopy(response), deepcopy(association)
        self.layout = None

    def extract(self, request, context):
        req = request.to_payload()
        page = self.association.get("page", 1)
        payload = {
            "schema_version": "v1",
            "tenant_id": req["tenant_id"],
            "file_id": req["file_id"],
            "job_id": req["job_id"],
            "provider": {
                "provider": "paddleocr-vl-layout",
                "sdk_version": "1",
                "model_version": "PaddleOCR-VL-1.6",
                "config_hash": response_digest(self.association),
            },
            "raw_artifact": req["object"],
            "completion": {
                "state": "complete",
                "total_units": 1,
                "completed_units": 1,
                "pending_units": [],
                "failed_units": [],
            },
            "records": [],
            "evidence": [],
            "warnings": [],
        }
        try:
            require(not context.is_cancelled(), "Layout review was cancelled.")
            require(req["page_selection"] == [page], "Choose exactly the associated source page.")
            require(
                req["media_type"] == "application/pdf", "Layout source must be the verified PDF."
            )
            require(
                req["sha256"] == self.association["source_sha256"],
                "Source file differs; re-verify association.",
            )
            self.layout = interpret_layout(self.response, self.association)
            validate_product_grid(self.layout)
            columns = self.layout.get("columns", self.association["columns"])
            for ri, row in enumerate(self.layout["grid"], 1):
                rid = str(
                    uuid5(UUID(req["file_id"]), f"layout:{response_digest(self.response)}:{ri}")
                )
                cells = []
                for ci, value in enumerate(row):
                    origin = self.layout["origins"][ri - 1][ci]
                    block = self.response["result"]["layoutParsingResults"][0]["prunedResult"][
                        "parsing_res_list"
                    ][origin["block"]]
                    x1, y1, x2, y2 = block["block_bbox"]
                    eid = str(uuid5(UUID(rid), f"column:{ci}"))
                    cells.append(
                        {"column_name": columns[ci]["label"], "value": value, "evidence_id": eid}
                    )
                    payload["evidence"].append(
                        {
                            "schema_version": "v1",
                            "evidence_id": eid,
                            "record_id": rid,
                            "source_file_id": req["file_id"],
                            "field_name": columns[ci]["field"],
                            "raw_text": columns[ci]["source_header"] if ri == 1 else value,
                            "artifact": req["object"],
                            "locator": {
                                "page": page,
                                "sheet": None,
                                "row": origin["row"],
                                "column": str(origin["column"]),
                                "table": str(origin["block"] + 1),
                                "cell": f"{origin['row']}:{origin['column']}",
                                "bounding_polygon": [[x1, y1], [x2, y1], [x2, y2], [x1, y2]],
                                "coordinate_system": "page_pixels",
                            },
                        }
                    )
                if self.association.get("layout_kind") == "physical_catalogue":
                    candidates = {
                        "price_role": "supplier_price",
                        "pricing_basis_unresolved": "true",
                        "section": self.association["section"]["text"],
                        "source_url": self.association["source_url"],
                        "original_source_page": str(self.association["original_source_page"]),
                        "layout_grid_row": str(ri),
                        "layout_grid_table": "1",
                        "currency": "GBP",
                        "tax_basis": self.association["tax_basis"],
                        "price_basis": None,
                        "pack_quantity": None,
                        "unit": None,
                    }
                    if ri > 1:
                        candidates.update(
                            {c["field"]: value for c, value in zip(columns, row, strict=True)}
                        )
                        candidates["cost_price"] = str(
                            Decimal(candidates["cost_price"].removeprefix("£"))
                        )
                        # Literal UOM is an attribute, not an inferred price denominator.
                        candidates["unit"] = None
                else:
                    candidates = {
                        "price_role": "retail_guidance",
                        "retail_price_columns": json.dumps(
                            [columns[3]["label"], columns[4]["label"]]
                        ),
                        "section": " | ".join(self.association["section"]["texts"]),
                        "layout_grid_row": str(ri),
                        "layout_grid_table": "1",
                    }
                    if ri > 1:
                        candidates.update(
                            supplier_sku=row[1],
                            description=row[0],
                            retail_price_ex_vat=retail_decimal(row[3]),
                            retail_price_inc_vat=retail_decimal(row[4]),
                            cost_price=None,
                            currency="GBP",
                            pack_quantity=None,
                            unit=None,
                            price_basis=None,
                        )
                payload["records"].append(
                    {"record_id": rid, "raw_cells": cells, "semantic_candidates": candidates}
                )
                payload["warnings"].append(
                    {
                        "code": "ocr_verification_required",
                        "field": rid,
                        "message": (
                            "Verify OCR against source; geometry refers to original layout blocks."
                        ),
                    }
                )
            payload["warnings"].append(
                {
                    "code": "pricing_basis_unresolved"
                    if self.association.get("layout_kind") == "physical_catalogue"
                    else "retail_guidance_only",
                    "field": None,
                    "message": (
                        "Supplier pricing basis is unresolved; verify price denominator, "
                        "pack and tax basis before cost updates."
                        if self.association.get("layout_kind") == "physical_catalogue"
                        else "Retail guidance is not wholesale cost; no import-ready cost updates."
                    ),
                }
            )
        except (LayoutFailure, KeyError, TypeError, IndexError, AttributeError, ValueError) as exc:
            payload["records"], payload["evidence"] = [], []
            payload["completion"].update(state="incomplete", failed_units=[page])
            payload["warnings"] = [
                {
                    "code": "unsupported_layout",
                    "field": None,
                    "message": str(exc)
                    if isinstance(exc, LayoutFailure)
                    else "Unsupported layout/association shape; verify source mapping.",
                }
            ]
            self.layout = {
                "original": deepcopy(self.response),
                "association": deepcopy(self.association),
            }
        context.report_progress(completed_units=1, total_units=1)
        return ExtractionResult.from_payload(payload)
