"""Isolated inspection entrypoint: no OCR imports, credentials or extraction operations."""

import base64
import json
import sys

from stockshift_worker.extraction.digital_pdf import PdfError
from stockshift_worker.extraction.pdf_inspection import inspect_document


def main():
    try:
        raw = sys.stdin.buffer.readline(14000000)
        if len(raw) >= 14000000:
            raise PdfError("PDF inspection input exceeds 10 MiB.")
        value = json.loads(raw)
        if set(value) != {"operation", "data"} or value["operation"] != "inspect_pdf":
            raise PdfError("Only inspect_pdf is supported by the CPU inspector.")
        result = inspect_document(base64.b64decode(value["data"], validate=True))
        output = {"value": result}
    except PdfError as exc:
        output = {"error": str(exc)}
    except Exception:
        output = {"error": "Corrupt or unsupported PDF. Export an unencrypted digital PDF."}
    print(json.dumps(output, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
