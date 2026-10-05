"""Installed-runtime smoke: real scanned page rendering with synthetic provider output.
No model inference, endpoint, development fixture writers or network required.
"""

import base64
import json
import sys
from dataclasses import asdict
from hashlib import sha256
from uuid import uuid4

from stockshift_worker.domain.csv_engine import CsvOptions
from stockshift_worker.extraction.base import ExtractionRequest
from stockshift_worker.extraction.digital_pdf import normalize_pdf
from stockshift_worker.extraction.paddleocr import RoutedPdfExtractor


class Context:
    def is_cancelled(self):
        return False

    def report_progress(self, **progress):
        pass


class Stub:
    def __init__(self):
        self.calls = 0

    def predict(self, png, key):
        assert png.startswith(b"\x89PNG")
        self.calls += 1
        price = "1.2O" if self.calls == 1 else "5.25"
        sku = "00123" if self.calls == 1 else "00042"
        html = (
            "<table><tr><td>SKU</td><td>Price</td></tr>"
            f"<tr><td>{sku}</td><td>{price}</td></tr></table>"
        )
        return {
            "errorCode": 0,
            "result": {
                "layoutParsingResults": [
                    {
                        "prunedResult": {
                            "parsing_res_list": [
                                {"block_label": "table", "block_content": html, "block_bbox": None}
                            ]
                        }
                    }
                ]
            },
        }


def main():
    data = base64.b64decode(sys.stdin.buffer.read(), validate=False)
    tenant, file, job = [str(uuid4()) for _ in range(3)]
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
    stub = Stub()
    provider = RoutedPdfExtractor(
        data,
        {
            "first_page": 1,
            "last_page": 2,
            "strategy": "lines",
            "provider": "auto",
            "model_version": "PaddleOCR-VL-1.6",
            "dpi": 144,
            "ocr_version": "1",
        },
        client=stub,
    )
    payload = provider.extract(req, Context()).to_payload()
    assert stub.calls == 2 and payload["completion"]["state"] == "complete"
    options = asdict(
        CsvOptions(
            encoding="utf-8-sig",
            delimiter=",",
            decimal_separator=".",
            columns={"supplier_sku": "SKU", "cost_price": "Price"},
            currency="GBP",
            unit="each",
            pack_quantity="1",
            price_basis="unit",
            tax_basis="net",
        )
    )
    ids = [w["field"] for w in payload["warnings"] if w["code"] == "ocr_verification_required"]
    product = payload["records"][1]["record_id"]
    rev = {
        "id": str(uuid4()),
        "source_file_id": file,
        "tenant_id": tenant,
        "confirmed": True,
        "extraction": payload,
        "configuration": {
            **options,
            "table_index": 1,
            "header_row": 1,
            "repeat_headers": True,
            "structure_confirmed": True,
            "ocr_verified_rows": ids,
        },
        "corrections": {product: {"cost_price": "1.002000000000000001"}},
    }
    catalogue = normalize_pdf(rev, source_file_id=file, source_name="scan.pdf")
    assert len(catalogue.products) == 2 and catalogue.products[0]["supplier_sku"] == "00123"
    assert catalogue.products[0]["cost_price"] == "1.002000000000000001"
    assert any(e["raw_text"] == "1.2O" for e in catalogue.evidence)
    print(
        json.dumps(
            {
                "mocked_inference": True,
                "real_rendered_pages": stub.calls,
                "products": len(catalogue.products),
                "correction_exact_decimal": True,
                "provenance_preserved": True,
            }
        )
    )


if __name__ == "__main__":
    main()
