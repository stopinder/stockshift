"""Deterministic stub PaddleOCR output; real PDF rendering, routing and normalization."""

from copy import deepcopy
from hashlib import sha256
from html import escape
from uuid import uuid4

import pytest
from ocr_fixture import scanned_pdf
from pdf_fixture import HEADERS, pdf_bytes
from test_pdf import Context, revision

from stockshift_worker.extraction.base import ExtractionRequest
from stockshift_worker.extraction.digital_pdf import PdfError, normalize_pdf
from stockshift_worker.extraction.paddleocr import (
    OcrFailure,
    PaddleClient,
    RoutedPdfExtractor,
    response_tables,
)


def response(rows=None, score=None):
    rows = rows or [
        HEADERS,
        ["00123", "1.001000000000000000", "Precision component", "GBP", "1", "each"],
        ["00042", "5.25", "Second component", "GBP", "1", "each"],
    ]
    html = (
        "<table>"
        + "".join("<tr>" + "".join("<td>" + escape(v) + "</td>" for v in r) + "</tr>" for r in rows)
        + "</table>"
    )
    return {
        "errorCode": 0,
        "result": {
            "layoutParsingResults": [
                {
                    "prunedResult": {
                        "parsing_res_list": [
                            {
                                "block_label": "table",
                                "block_content": html,
                                "block_bbox": [10, 10, 100, 100],
                                "confidence": score,
                            }
                        ]
                    }
                }
            ]
        },
    }


class Stub:
    def __init__(self, failure=None):
        self.calls = []
        self.failure = failure

    def predict(self, png, key):
        assert png.startswith(b"\x89PNG")
        self.calls.append(key)
        if self.failure:
            raise self.failure
        return response()


def run(data=None, *, cache=None, stub=None, events=None, model="PaddleOCR-VL-1.6", ids=None):
    data = scanned_pdf() if data is None else data
    file, tenant, job = ids or [str(uuid4()) for _ in range(3)]
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
            "page_selection": [1, 2],
            "sheet_selection": [],
            "mapping_profile_id": None,
            "config": obj,
        }
    )
    provider = RoutedPdfExtractor(
        data,
        {
            "first_page": 1,
            "last_page": 2,
            "strategy": "lines",
            "provider": "auto",
            "model_version": model,
            "dpi": 144,
            "ocr_version": "1",
        },
        client=stub or Stub(),
        cache=cache,
        event=(events.append if events is not None else None),
    )
    return provider.extract(req, Context()).to_payload(), provider


def test_scanned_routes_only_scanned_pages():
    stub = Stub()
    payload, provider = run(stub=stub)
    assert len(stub.calls) == 2
    assert payload["completion"]["state"] == "complete"
    assert [p["provider"] for p in provider.raw_pages] == ["paddleocr-vl"] * 2
    assert all(
        e["locator"]["page"] in (1, 2) and e["locator"]["coordinate_system"] == "page_pixels"
        for e in payload["evidence"]
    )


def test_digital_does_not_call_ocr():
    stub = Stub()
    payload, provider = run(pdf_bytes(), stub=stub)
    assert not stub.calls
    assert payload["provider"]["provider"] == "pdfplumber"


def test_unusable_merged_digital_tables_route_to_ocr():
    stub = Stub()
    payload, provider = run(pdf_bytes(merged=True), stub=stub)
    assert len(stub.calls) == 2
    assert payload["completion"]["state"] == "complete"
    assert all(page["provider"] == "paddleocr-vl" for page in provider.raw_pages)


def test_mixed_preserves_order_and_uses_one_ocr_page():
    stub = Stub()
    payload, provider = run(scanned_pdf(mixed=True), stub=stub)
    assert len(stub.calls) == 1
    assert [p["provider"] for p in provider.raw_pages] == ["pdfplumber", "paddleocr-vl"]
    loc = {e["record_id"]: e["locator"]["page"] for e in payload["evidence"]}
    assert [loc[r["record_id"]] for r in payload["records"]] == sorted(
        loc[r["record_id"]] for r in payload["records"]
    )


def test_cached_pages_do_not_call_provider_again():
    events = []
    ids = [str(uuid4()) for _ in range(3)]
    payload, first = run(events=events, ids=ids)
    cache = {
        str(e["ocr_page"]["page"]): {
            "status": "ready",
            "request_count": 1,
            "request_hash": e["ocr_page"]["request_hash"],
            "response": e["ocr_page"]["response"],
        }
        for e in events
        if "ocr_page" in e
    }
    stub = Stub()
    again, second = run(cache=cache, stub=stub, ids=ids)
    assert not stub.calls
    assert first.raw_pages == second.raw_pages


def test_correction_requires_verification_and_preserves_raw():
    payload, provider = run(scanned_pdf(mixed=True))
    rev = revision(payload)
    with pytest.raises(PdfError, match="Verify each OCR"):
        normalize_pdf(rev, source_file_id=payload["file_id"], source_name="mixed.pdf")
    ids = [w["field"] for w in payload["warnings"] if w["code"] == "ocr_verification_required"]
    rev["configuration"]["ocr_verified_rows"] = ids
    row = payload["records"][-2]["record_id"]
    rev["corrections"][row] = {"cost_price": "1.002000000000000001"}
    catalogue = normalize_pdf(rev, source_file_id=payload["file_id"], source_name="mixed.pdf")
    p = next(p for p in catalogue.products if p["record_id"] == row)
    assert p["cost_price"] == "1.002000000000000001"
    assert (
        next(
            e
            for e in catalogue.evidence
            if e["record_id"] == row and e["field_name"] == "cost_price"
        )["raw_text"]
        == "1.001000000000000000"
    )


@pytest.mark.parametrize("score", [None, 0.2, 0.99])
def test_no_score_auto_approves_rows(score):
    class Score(Stub):
        def predict(self, png, key):
            return response(score=score)

    payload, provider = run(stub=Score())
    assert len([w for w in payload["warnings"] if w["code"] == "ocr_verification_required"]) == len(
        payload["records"]
    )
    assert all(p["confidence"] == score for p in provider.raw_pages)


@pytest.mark.parametrize(
    "raw",
    [
        {},
        {"errorCode": 500},
        {"errorCode": 0, "result": {"layoutParsingResults": []}},
        response([["SKU", "Price"], ["one"]]),
        response([["SKU", "Price"], ["a", "1"]]),
    ],
)
def test_malformed_or_merged_provider_response(raw):
    raw = deepcopy(raw)
    if raw == response([["SKU", "Price"], ["a", "1"]]):
        raw["result"]["layoutParsingResults"][0]["prunedResult"]["parsing_res_list"][0][
            "block_content"
        ] = '<table><tr><td colspan="2">SKU</td></tr><tr><td>a</td><td>1</td></tr></table>'
    with pytest.raises(OcrFailure):
        response_tables(raw, 200, 200)


@pytest.mark.parametrize(
    "code,retryable",
    [
        ("ocr_timeout", True),
        ("ocr_rate_limit", True),
        ("ocr_unavailable", True),
        ("ocr_structure", False),
    ],
)
def test_failure_retryability_and_partial_page_state(code, retryable):
    stub = Stub(OcrFailure(code, "Safe failure", retryable=retryable))
    events = []
    if retryable:
        with pytest.raises(OcrFailure) as error:
            run(scanned_pdf(mixed=True), stub=stub, events=events)
        assert error.value.retryable
    else:
        payload, provider = run(scanned_pdf(mixed=True), stub=stub, events=events)
        assert payload["completion"]["state"] == "incomplete"
        assert payload["completion"]["failed_units"] == [2]
        assert provider.raw_pages[1]["status"] == "failed"
        assert payload["records"]
    assert events[-1]["ocr_failure"]["failure"]["code"] == code


def test_page_budget_blocks_before_any_provider_call(monkeypatch):
    monkeypatch.setenv("STOCKSHIFT_OCR_MAX_PAGES", "1")
    stub = Stub()
    with pytest.raises(OcrFailure, match="limit"):
        run(stub=stub)
    assert not stub.calls


@pytest.mark.parametrize(
    "url",
    [
        "http://remote.test/layout-parsing",
        "https://user:secret@remote.test/layout-parsing",
        "https://remote.test/layout-parsing?token=x",
        "http://127.0.0.1:8888/other",
        "",
    ],
)
def test_endpoint_configuration_is_worker_only_and_restricted(monkeypatch, url):
    monkeypatch.setenv("STOCKSHIFT_OCR_ENDPOINT", url)
    with pytest.raises(OcrFailure):
        PaddleClient("PaddleOCR-VL-1.6")
