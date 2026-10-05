"""Fenced durable PDF extraction with isolated, time-bounded parser execution."""

import base64
import json
import os
import subprocess
import sys
import time
from hashlib import sha256
from queue import Empty, Queue
from threading import Thread

from stockshift_worker.extraction.base import ExtractionResult
from stockshift_worker.extraction.digital_pdf import PdfError
from stockshift_worker.extraction.paddleocr import OcrFailure
from stockshift_worker.jobs.gateway import LeaseLost


def extract_job(gateway, job, lease, lost, *, timeout=60):
    loaded = gateway.rpc("load_pdf_extraction", **lease)
    e, file = loaded["extraction"], loaded["file"]
    if (
        e["id"] != job["extraction_run_id"]
        or e["tenant_id"] != job["tenant_id"]
        or file["tenant_id"] != job["tenant_id"]
        or e["source_file_id"] != file["id"]
        or file["status"] != "ready"
        or file["verified_mime"] != "application/pdf"
        or not 1 <= file["byte_count"] <= 10485760
    ):
        raise PdfError("PDF metadata outside job/source. Upload the source again.")
    data = gateway.download(file)
    if len(data) != file["byte_count"] or sha256(data).hexdigest() != file["sha256"]:
        raise PdfError("PDF integrity verification failed. Upload the source again.")
    cfg = e["configuration"]
    obj = {"bucket": file["bucket_id"], "object_key": file["object_name"]}
    request = {
        "schema_version": "v1",
        "tenant_id": job["tenant_id"],
        "file_id": file["id"],
        "job_id": job["id"],
        "object": obj,
        "sha256": file["sha256"],
        "media_type": "application/pdf",
        "page_selection": list(range(cfg["first_page"], cfg["last_page"] + 1)),
        "sheet_selection": [],
        "mapping_profile_id": None,
        "config": obj,
    }
    env = {
        k: v
        for k, v in os.environ.items()
        if k.upper() in {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"}
    }
    if cfg.get("provider") == "auto":
        env.update(
            {
                k: v
                for k, v in os.environ.items()
                if k
                in {
                    "STOCKSHIFT_OCR_ENDPOINT",
                    "STOCKSHIFT_OCR_TOKEN",
                    "STOCKSHIFT_OCR_MODEL",
                    "STOCKSHIFT_OCR_TIMEOUT",
                    "STOCKSHIFT_OCR_MAX_PAGES",
                    "STOCKSHIFT_OCR_MAX_DOCUMENT_PAGES",
                }
            }
        )
        timeout = 180
    child = subprocess.Popen(
        [sys.executable, "-I", "-m", "stockshift_worker.entrypoints.pdf"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    queue = Queue()

    def read():
        try:
            for line in iter(lambda: child.stdout.readline(17000000), b""):
                if len(line) >= 17000000:
                    queue.put(PdfError("PDF output too large. Select fewer pages."))
                    return
                queue.put(line)
        finally:
            queue.put(None)

    thread = Thread(target=read, daemon=True)
    thread.start()
    try:
        input_payload = (
            json.dumps(
                {
                    "operation": "extract",
                    "data": base64.b64encode(data).decode(),
                    "configuration": cfg,
                    "request": request,
                    "ocr_cache": loaded.get("ocr_cache", {}),
                }
            ).encode()
            + b"\n"
        )
        if len(input_payload) >= 48000000:
            raise PdfError("PDF/cache input exceeds supported size. Select fewer pages.")
        child.stdin.write(input_payload)
        child.stdin.flush()
        if cfg.get("provider") != "auto":
            child.stdin.close()
        deadline = time.monotonic() + timeout
        result = None
        while True:
            if lost.is_set():
                raise LeaseLost("Heartbeat failed")
            if time.monotonic() >= deadline:
                raise TimeoutError("PDF extraction timed out. Select fewer pages and retry.")
            try:
                line = queue.get(timeout=0.1)
            except Empty:
                continue
            if isinstance(line, Exception):
                raise line
            if line is None:
                break
            output = json.loads(line)
            if "progress" in output:
                progress = output["progress"]
                gateway.rpc(
                    "pdf_extraction_progress",
                    **lease,
                    p_completed=progress["completed"],
                    p_total=progress["total"],
                )
            elif "ocr_request" in output:
                gateway.rpc(
                    "record_ocr_page",
                    **lease,
                    p_event="request",
                    p_page=output["ocr_request"]["page"],
                    p_hash=output["ocr_request"]["request_hash"],
                    p_value={},
                )
                child.stdin.write(b'{"ok":true}\n')
                child.stdin.flush()
            elif "ocr_page" in output:
                gateway.rpc(
                    "record_ocr_page",
                    **lease,
                    p_event="ready",
                    p_page=output["ocr_page"]["page"],
                    p_hash=output["ocr_page"]["request_hash"],
                    p_value=output["ocr_page"]["response"],
                )
                child.stdin.write(b'{"ok":true}\n')
                child.stdin.flush()
            elif "ocr_failure" in output:
                gateway.rpc(
                    "record_ocr_page",
                    **lease,
                    p_event="failed",
                    p_page=output["ocr_failure"]["page"],
                    p_hash=output["ocr_failure"]["request_hash"],
                    p_value=output["ocr_failure"]["failure"],
                )
                child.stdin.write(b'{"ok":true}\n')
                child.stdin.flush()
            elif "error" in output and "code" in output:
                raise OcrFailure(output["code"], output["error"], retryable=output["retryable"])
            elif "error" in output:
                raise PdfError(output["error"])
            elif "value" in output:
                result = output["value"]
        if not result:
            raise PdfError("PDF extraction failed. Export a new digital PDF or CSV/XLSX and retry.")
        payload = ExtractionResult.from_payload(result["payload"]).to_payload()
        if lost.is_set():
            raise LeaseLost("Heartbeat failed")
        gateway.rpc("complete_pdf_extraction", **lease, p_payload=payload, p_pages=result["pages"])
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        child.stdout.close()
        if not child.stdin.closed:
            child.stdin.close()
        thread.join(timeout=5)
