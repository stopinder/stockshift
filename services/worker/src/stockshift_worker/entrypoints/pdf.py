"""Credential-free PDF inspection/extraction subprocess; bounded stdin/NDJSON output."""

import base64
import json
import os
import sys

from stockshift_worker.extraction.base import ExtractionRequest
from stockshift_worker.extraction.digital_pdf import DigitalPdfExtractor, PdfError, inspect_pdf
from stockshift_worker.extraction.mapped_pdf import MappedPdfExtractor
from stockshift_worker.extraction.paddleocr import OcrFailure, RoutedPdfExtractor


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
        # Original bytes plus bounded persisted page-cache responses on retry.
        raw = sys.stdin.buffer.readline(48000000)
        value = json.loads(raw)
        data = base64.b64decode(value["data"], validate=True)
        if value.get("operation") == "extract":
            cfg = value["configuration"]
            cpu_only = os.environ.get("STOCKSHIFT_CPU_PDF_ONLY") == "1"
            if cpu_only and (
                cfg.get("provider", "digital") != "digital" or cfg.get("layout_association")
            ):
                raise PdfError("CPU PDF extraction cannot invoke OCR")

            def event(v):
                print(json.dumps(v), flush=True)
                if json.loads(sys.stdin.buffer.readline(1024)).get("ok") is not True:
                    raise PdfError("OCR lease or usage authorization was rejected.")

            provider = (
                DigitalPdfExtractor(data, cfg)
                if cpu_only
                else MappedPdfExtractor(data, cfg, cache=value.get("ocr_cache"), event=event)
                if cfg.get("layout_association")
                else RoutedPdfExtractor(data, cfg, cache=value.get("ocr_cache"), event=event)
                if cfg.get("provider") == "auto"
                else DigitalPdfExtractor(data, cfg)
            )
            result = provider.extract(ExtractionRequest.from_payload(value["request"]), Context())
            output = {"value": {"payload": result.to_payload(), "pages": provider.raw_pages}}
        else:
            output = {"value": inspect_pdf(data)}
    except OcrFailure as exc:
        output = {"error": str(exc), "code": exc.code, "retryable": exc.retryable}
    except PdfError as exc:
        output = {"error": str(exc)}
    except Exception:
        output = {
            "error": "Unsupported PDF structure. Export a new digital PDF or CSV/XLSX and retry."
        }
    print(json.dumps(output, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
