"""Installed-wheel/container smoke; reads a synthetic PDF from stdin, no test-only imports."""

import base64
import json
import sys
from dataclasses import asdict
from hashlib import sha256
from uuid import uuid4

import pdfplumber

from stockshift_worker.domain.csv_engine import CsvOptions
from stockshift_worker.extraction.base import ExtractionRequest
from stockshift_worker.extraction.digital_pdf import DigitalPdfExtractor, inspect_pdf, normalize_pdf


class Context:
    def is_cancelled(self):
        return False

    def report_progress(self, **progress):
        pass


def main():
    data = base64.b64decode(sys.stdin.buffer.read(), validate=False)
    assert inspect_pdf(data) == {"pages": 2}
    tenant, file, job = (str(uuid4()) for _ in range(3))
    obj = {"bucket": "catalogue-uploads", "object_key": f"{tenant}/{file}/original"}
    request = ExtractionRequest.from_payload(
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
    provider = DigitalPdfExtractor(data, {"first_page": 1, "last_page": 2, "strategy": "lines"})
    result = provider.extract(request, Context()).to_payload()
    options = asdict(
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
    )
    revision = {
        "source_file_id": file,
        "tenant_id": tenant,
        "confirmed": True,
        "extraction": result,
        "corrections": {},
        "configuration": {
            **options,
            "table_index": 1,
            "header_row": 1,
            "repeat_headers": True,
            "structure_confirmed": True,
        },
    }
    catalogue = normalize_pdf(revision, source_file_id=file, source_name="synthetic.pdf")
    assert len(catalogue.products) == 3
    assert catalogue.products[0]["supplier_sku"] == "00123"
    assert catalogue.products[0]["cost_price"] == "1.001000000000000000"
    assert catalogue.products[1]["cost_price"] is None
    assert catalogue.evidence[0]["locator"]["page"] == 1
    print(
        json.dumps(
            {
                "pdfplumber": pdfplumber.__version__,
                "pages": 2,
                "products": 3,
                "exact_decimal": True,
                "leading_zero": True,
                "packaged_contracts": True,
            }
        )
    )


if __name__ == "__main__":
    main()
