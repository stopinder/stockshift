"""Credential-free PDF inspection/extraction subprocess; bounded stdin/NDJSON output."""

import base64
import json
import sys

from stockshift_worker.extraction.base import ExtractionRequest
from stockshift_worker.extraction.digital_pdf import DigitalPdfExtractor, PdfError, inspect_pdf


class Context:
    def is_cancelled(self):
        return False

    def report_progress(self, *, completed_units, total_units):
        print(
            json.dumps({"progress": {"completed": completed_units, "total": total_units}}),
            flush=True,
        )


def main():
    try:
        raw = sys.stdin.buffer.read(15000000)
        value = json.loads(raw)
        data = base64.b64decode(value["data"], validate=True)
        if value.get("operation") == "extract":
            provider = DigitalPdfExtractor(data, value["configuration"])
            result = provider.extract(ExtractionRequest.from_payload(value["request"]), Context())
            output = {"value": {"payload": result.to_payload(), "pages": provider.raw_pages}}
        else:
            output = {"value": inspect_pdf(data)}
    except PdfError as exc:
        output = {"error": str(exc)}
    except Exception:
        output = {
            "error": "Unsupported PDF structure. Export a new digital PDF or CSV/XLSX and retry."
        }
    print(json.dumps(output, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
