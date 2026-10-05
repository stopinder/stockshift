"""LOCAL SYNTHETIC STUB, not OCR. Official PaddleOCR-VL serving response shape.
Only recognizes rendered hashes of the repository's synthetic catalogue fixtures.
Never use this service for customer documents or inference accuracy measurements.
"""

import base64
import io
import json
import sys
from contextlib import contextmanager
from hashlib import sha256
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

from ocr_fixture import scanned_pdf
from pdf_fixture import HEADERS
from PIL import Image

from stockshift_worker.extraction.paddleocr import render_page


def fixtures():
    known = {}
    for incoming in (False, True):
        data = scanned_pdf(incoming=incoming)
        for page in (1, 2):
            png, w, h = render_page(data, page, 144)
            rows = (
                [
                    HEADERS,
                    [
                        "00123",
                        "1.2O" if incoming else "1.001000000000000000",
                        "Precision component",
                        "GBP",
                        "1",
                        "each",
                    ],
                    ["REVIEW", "", "Missing price", "GBP", "1", "each"],
                ]
                if page == 1
                else [HEADERS, ["00042", "5.25", "Second page component", "GBP", "1", "each"]]
            )
            html = (
                "<table>"
                + "".join(
                    "<tr>" + "".join("<td>" + escape(v) + "</td>" for v in row) + "</tr>"
                    for row in rows
                )
                + "</table>"
            )
            known[sha256(png).hexdigest()] = {
                "errorCode": 0,
                "result": {
                    "layoutParsingResults": [
                        {
                            "prunedResult": {
                                "parsing_res_list": [
                                    {
                                        "block_label": "table",
                                        "block_content": html,
                                        "block_bbox": [60, 160, 1330, 450],
                                        "confidence": 0.4,
                                    }
                                ]
                            }
                        }
                    ]
                },
            }
    return known


def server(port=0, mode="ok"):
    known = fixtures()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            try:
                if self.path != "/layout-parsing":
                    raise ValueError
                size = int(self.headers.get("Content-Length", "0"))
                if not 1 <= size <= 15000000:
                    raise ValueError
                value = json.loads(self.rfile.read(size))
                png = base64.b64decode(value["file"], validate=True)
                if (
                    value["fileType"] != 1
                    or not png.startswith(b"\x89PNG")
                    or not self.headers.get("Idempotency-Key")
                ):
                    raise ValueError
                with Image.open(io.BytesIO(png)) as img:
                    img.verify()
                key = self.headers["Idempotency-Key"]
                self.server.calls.append(key)
                first = key not in self.server.seen
                self.server.seen.add(key)
                if mode == "rate_once" and first:
                    self.send_response(429)
                    self.end_headers()
                    return
                if mode == "unavailable":
                    self.send_response(503)
                    self.end_headers()
                    return
                result = known[sha256(png).hexdigest()]
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({} if mode == "malformed" else result).encode())
            except (ValueError, KeyError):
                self.send_response(422)
                self.end_headers()

    service = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    service.calls = []
    service.seen = set()
    return service


@contextmanager
def running(mode="ok"):
    service = server(mode=mode)
    thread = Thread(target=service.serve_forever, daemon=True)
    thread.start()
    try:
        yield service
    finally:
        service.shutdown()
        service.server_close()
        thread.join()


if __name__ == "__main__":
    service = server(
        int(sys.argv[1]) if len(sys.argv) > 1 else 8771, sys.argv[2] if len(sys.argv) > 2 else "ok"
    )
    print("SYNTHETIC STUB READY (no model inference)", flush=True)
    service.serve_forever()
