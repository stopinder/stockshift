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
        child.stdin.write(
            json.dumps(
                {
                    "operation": "extract",
                    "data": base64.b64encode(data).decode(),
                    "configuration": cfg,
                    "request": request,
                }
            ).encode()
        )
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
