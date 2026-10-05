"""Real embedded-text PDF extraction, immutable corrections and shared engine behavior."""

from copy import deepcopy
from dataclasses import asdict
from hashlib import sha256
from uuid import uuid4

import pytest
from pdf_fixture import HEADERS, pdf_bytes

from stockshift_worker.domain.csv_engine import CsvOptions, reconcile
from stockshift_worker.extraction.base import ExtractionRequest
from stockshift_worker.extraction.digital_pdf import (
    DigitalPdfExtractor,
    PdfError,
    inspect_pdf,
    normalize_pdf,
)


class Context:
    def __init__(self, cancelled=False):
        self.cancelled, self.progress = cancelled, []

    def is_cancelled(self):
        return self.cancelled

    def report_progress(self, **progress):
        self.progress.append(progress)


def extract(data=None, *, first=1, last=2, strategy="lines", context=None):
    data = pdf_bytes() if data is None else data
    file, tenant, job = (str(uuid4()) for _ in range(3))
    obj = {"bucket": "catalogue-uploads", "object_key": f"{tenant}/{file}/original"}
    req = ExtractionRequest.from_payload(
        {
            "schema_version": "v1",
            "tenant_id": tenant,
            "file_id": file,
            "job_id": job,
            "object": obj,
            "sha256": sha256(data).hexdigest(),
            "media_type": "application/pdf",
            "page_selection": list(range(first, last + 1)),
            "sheet_selection": [],
            "mapping_profile_id": None,
            "config": obj,
        }
    )
    provider = DigitalPdfExtractor(
        data, {"first_page": first, "last_page": last, "strategy": strategy}
    )
    ctx = context or Context()
    return provider.extract(req, ctx).to_payload(), provider.raw_pages, ctx


def revision(payload, **configuration):
    return {
        "id": str(uuid4()),
        "source_file_id": payload["file_id"],
        "tenant_id": payload["tenant_id"],
        "confirmed": True,
        "extraction": payload,
        "corrections": {},
        "configuration": {
            **asdict(
                CsvOptions(
                    encoding="utf-8-sig",
                    delimiter=",",
                    decimal_separator=".",
                    columns={
                        "supplier_sku": "SKU",
                        "cost_price": "Price",
                        "description": "Description",
                        "currency": "Currency",
                        "pack_quantity": "Pack",
                        "unit": "UOM",
                    },
                    price_basis="unit",
                    tax_basis="net",
                )
            ),
            "table_index": 1,
            "header_row": 1,
            "repeat_headers": True,
            "structure_confirmed": True,
            **configuration,
        },
    }


def normalize(v):
    return normalize_pdf(v, source_file_id=v["source_file_id"], source_name="catalogue.pdf")


def test_simple_multi_page_and_real_progress():
    payload, pages, context = extract()
    assert payload["completion"]["state"] == "complete"
    assert len(payload["records"]) == 5
    assert [p["page"] for p in pages] == [1, 2]
    assert context.progress == [
        {"completed_units": 0, "total_units": 2},
        {"completed_units": 1, "total_units": 2},
        {"completed_units": 2, "total_units": 2},
    ]
    assert "00123" in pages[0]["text"]


def test_leading_zero_decimal_and_page_provenance():
    payload, _, _ = extract()
    catalogue = normalize(revision(payload))
    assert [p["supplier_sku"] for p in catalogue.products] == ["00123", "REVIEW", "00042"]
    assert catalogue.products[0]["cost_price"] == "1.001000000000000000"
    e = next(e for e in catalogue.evidence if e["field_name"] == "cost_price")
    assert e["raw_text"] == "1.001000000000000000"
    assert e["locator"]["page"] == 1 and e["locator"]["row"] == 2
    assert e["locator"]["column"] == "Price" and e["locator"]["table"] == "1"
    assert len(e["locator"]["bounding_polygon"]) == 4
    assert e["locator"]["coordinate_system"] == "page_points"


def test_correction_feeds_reconciliation_without_overwriting_original():
    a, _, _ = extract()
    b, _, _ = extract(pdf_bytes(incoming=True))
    v = revision(b)
    original = deepcopy(v)
    row = b["records"][1]["record_id"]
    v["corrections"] = {
        row: {"cost_price": "1.002000000000000001", "description": "Corrected description"}
    }
    output = reconcile(normalize(revision(a)), normalize(v))
    assert output[0]["outcome"] == "changed"
    assert output[0]["cost_delta"] == "0.001000000000000001"
    assert v["extraction"] == original["extraction"]
    assert (
        next(e for e in normalize(v).evidence if e["field_name"] == "cost_price")["raw_text"]
        == "1.2O"
    )
    assert len([r for r in output if r["outcome"] == "needs_review"]) == 2


def test_explicit_header_row_and_mapping():
    rows = [
        ["Intro", "Note", "Heading", "Currency", "Pack", "UOM"],
        HEADERS,
        ["001", "2.10", "Part", "GBP", "1", "each"],
    ]
    p, _, _ = extract(pdf_bytes(pages=[rows]), last=1)
    assert normalize(revision(p, header_row=2)).products[0]["supplier_sku"] == "001"


def test_exact_repeated_headers_skipped():
    p, _, _ = extract(
        pdf_bytes(
            pages=[
                [
                    HEADERS,
                    ["001", "2", "Part", "GBP", "1", "each"],
                    HEADERS,
                    ["002", "3", "Part", "GBP", "1", "each"],
                ]
            ]
        ),
        last=1,
    )
    assert len(normalize(revision(p)).products) == 2
    assert len(normalize(revision(p, repeat_headers=False)).products) == 3
    assert normalize(revision(p, repeat_headers=False)).products[1]["cost_price"] is None


def test_page_break_fragments_never_merged_or_approved():
    p, _, _ = extract(
        pdf_bytes(
            pages=[
                [HEADERS, ["BREAK", "", "Start", "GBP", "1", "each"]],
                [HEADERS, ["", "4.5", "Continuation", "GBP", "1", "each"]],
            ]
        )
    )
    c = normalize(revision(p))
    assert len(c.products) == 2 and c.products[0]["cost_price"] is None
    assert c.products[1]["supplier_sku"] is None
    other, _, _ = extract()
    assert all(
        r["outcome"] == "needs_review"
        for r in reconcile(c, normalize(revision(other)))
        if r["old_record_id"]
    )


@pytest.mark.parametrize("image_only", [True, False])
def test_no_usable_table_returns_ocr_required(image_only):
    data = pdf_bytes(image_only=True) if image_only else pdf_bytes(pages=[[[]]])
    p, _, _ = extract(data, last=2 if image_only else 1)
    assert p["completion"]["state"] == "incomplete"
    assert any(w["code"] == "ocr_required" for w in p["warnings"])
    with pytest.raises(PdfError, match="OCR required"):
        normalize(revision(p))


def test_merged_header_is_rejected_as_unsupported():
    p, _, _ = extract(pdf_bytes(merged=True))
    assert p["completion"]["state"] == "incomplete"
    assert any(w["code"] == "unsupported_layout" for w in p["warnings"])


@pytest.mark.parametrize(
    "data,message",
    [
        (b"not pdf", "Invalid PDF"),
        (b"%PDF-1.7 corrupted", "Corrupt"),
        (pdf_bytes(encrypted=True), "Password-protected"),
    ],
)
def test_corrupt_encrypted_errors_are_actionable(data, message):
    with pytest.raises(PdfError, match=message):
        inspect_pdf(data)


@pytest.mark.parametrize(
    "config,message",
    [
        ({"columns": {"supplier_sku": "Absent", "cost_price": "Price"}}, "missing"),
        ({"header_row": 50}, "Header row"),
        ({"structure_confirmed": False}, "Confirm"),
        ({"table_index": 2}, "absent"),
    ],
)
def test_explicit_invalid_mapping_rejected(config, message):
    p, _, _ = extract()
    with pytest.raises(PdfError, match=message):
        normalize(revision(p, **config))


def test_duplicate_header_rejected():
    p, _, _ = extract(
        pdf_bytes(
            pages=[
                [
                    ["SKU", "SKU", "Description", "Currency", "Pack", "UOM"],
                    ["1", "2", "part", "GBP", "1", "each"],
                ]
            ]
        ),
        last=1,
    )
    with pytest.raises(PdfError, match="unique"):
        normalize(revision(p))


def test_page_header_change_is_not_silently_combined():
    p, _, _ = extract(
        pdf_bytes(
            pages=[
                [HEADERS, ["1", "2", "part", "GBP", "1", "each"]],
                [["Code", *HEADERS[1:]], ["2", "3", "part", "GBP", "1", "each"]],
            ]
        )
    )
    with pytest.raises(PdfError, match="differ"):
        normalize(revision(p))


@pytest.mark.parametrize("value", ["1.2O", "-1", "1e5", "NaN"])
def test_invalid_price_remains_null_and_reviewable(value):
    p, _, _ = extract(
        pdf_bytes(pages=[[HEADERS, ["1", value, "part", "GBP", "1", "each"]]]), last=1
    )
    product = normalize(revision(p)).products[0]
    assert product["cost_price"] is None
    assert any(i["code"] == "invalid_decimal" for i in product["validation_issues"])


@pytest.mark.parametrize("value", ["-1", "NaN", "1e3", "1.2O"])
def test_invalid_correction_rejected(value):
    p, _, _ = extract()
    v = revision(p)
    v["corrections"] = {p["records"][1]["record_id"]: {"cost_price": value}}
    with pytest.raises(ValueError):
        normalize(v)


def test_clear_price_preserves_original_and_requires_review():
    p, _, _ = extract()
    v = revision(p)
    v["corrections"] = {p["records"][1]["record_id"]: {"cost_price": None}}
    c = normalize(v)
    assert c.products[0]["cost_price"] is None
    assert c.evidence[1]["raw_text"] == "1.001000000000000000"


def test_corrections_outside_selected_rows_rejected():
    p, _, _ = extract()
    v = revision(p)
    v["corrections"] = {str(uuid4()): {"cost_price": "2"}}
    with pytest.raises(PdfError, match="unselected"):
        normalize(v)


def test_cancelled_extraction_and_invalid_page_range():
    with pytest.raises(PdfError, match="cancelled"):
        extract(context=Context(True))
    with pytest.raises(PdfError, match="pages"):
        extract(last=3)
    with pytest.raises(PdfError, match="range"):
        extract(last=51)


def test_single_explicit_page_selection():
    p, pages, _ = extract(first=2, last=2)
    assert [e["locator"]["page"] for e in p["evidence"]] == [2] * 12
    assert [p["page"] for p in pages] == [2]
    assert normalize(revision(p)).products[0]["supplier_sku"] == "00042"


def test_text_strategy_never_auto_approves_uncertain_structure():
    rows = [HEADERS, *[[str(i), "2.10", "Part", "GBP", "1", "each"] for i in range(1, 4)]]
    p, _, _ = extract(pdf_bytes(pages=[rows]), last=1, strategy="text")
    assert p["completion"]["state"] == "complete"
    c = normalize(revision(p))
    assert len(c.products) == 3
    assert all(
        any(i["code"] == "pdf_structure_review" for i in r["validation_issues"]) for r in c.products
    )


def test_multiline_identifier_cannot_be_automatically_approved():
    rows = [HEADERS, ["00\n123", "2.10", "Part", "GBP", "1", "each"]]
    p, _, _ = extract(pdf_bytes(pages=[rows]), last=1)
    c = normalize(revision(p))
    assert "\n" in c.products[0]["supplier_sku"]
    assert any(i["code"] == "pdf_row_continuation" for i in c.products[0]["validation_issues"])
