"""Private-object integrity and lease-fenced CPU inspection in a killable subprocess."""

import base64
import json
import os
import subprocess
import sys
import time
from hashlib import sha256
from queue import Empty, Queue
from threading import Thread

from stockshift_worker.extraction.digital_pdf import PdfError
from stockshift_worker.jobs.capabilities import require_pdf_capability, require_pdf_worker_agreement
from stockshift_worker.jobs.gateway import LeaseLost


def inspect_job(gateway, job, lease, lost, *, timeout=60):
    require_pdf_capability("inspection")
    require_pdf_worker_agreement(gateway)
    loaded = gateway.rpc("load_pdf_inspection", **lease)
    inspection, file = loaded["inspection"], loaded["file"]
    if (
        job.get("kind") != "inspect_pdf"
        or inspection["id"] != job["inspection_run_id"]
        or inspection["tenant_id"] != job["tenant_id"]
        or file["tenant_id"] != job["tenant_id"]
        or inspection["source_file_id"] != file["id"]
        or file["status"] != "ready"
        or file["verified_mime"] != "application/pdf"
        or type(file["byte_count"]) is not int
        or not 1 <= file["byte_count"] <= 10485760
        or file["bucket_id"] != "catalogue-uploads"
        or file["object_name"] != f"{job['tenant_id']}/{file['id']}/original"
    ):
        raise PdfError("PDF inspection metadata outside job/source. Upload the source again.")
    data = gateway.download(file)
    if len(data) != file["byte_count"] or sha256(data).hexdigest() != file["sha256"]:
        raise PdfError("PDF integrity verification failed. Upload the source again.")
    if lost.is_set():
        raise LeaseLost("Heartbeat failed")
    env = {
        k: v
        for k, v in os.environ.items()
        if k.upper() in {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"}
    }
    child = subprocess.Popen(
        [sys.executable, "-I", "-m", "stockshift_worker.entrypoints.pdf_inspection"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    queue = Queue(maxsize=2)

    def read():
        queue.put(child.stdout.read(65537))

    def write():
        try:
            child.stdin.write(
                json.dumps(
                    {"operation": "inspect_pdf", "data": base64.b64encode(data).decode()}
                ).encode()
                + b"\n"
            )
        except OSError:
            queue.put(PdfError("PDF inspection process failed. Split the PDF and retry."))
        finally:
            try:
                child.stdin.close()
            except OSError:
                pass  # A timed-out child may exit before its input pipe finishes flushing.

    thread = Thread(target=read, daemon=True)
    writer = Thread(target=write, daemon=True)
    deadline = time.monotonic() + timeout
    thread.start()
    writer.start()
    try:
        while True:
            if lost.is_set():
                raise LeaseLost("Heartbeat failed")
            if time.monotonic() >= deadline:
                raise TimeoutError("PDF inspection timed out. Split the PDF and retry.")
            try:
                raw = queue.get(timeout=0.1)
                if isinstance(raw, Exception):
                    raise raw
                break
            except Empty:
                continue
        if len(raw) > 65536:
            raise PdfError("PDF inspection output exceeds safety limits.")
        output = json.loads(raw)
        if "error" in output:
            raise PdfError(output["error"])
        if lost.is_set():
            raise LeaseLost("Heartbeat failed")
        gateway.rpc("heartbeat_csv_job", **lease)
        gateway.rpc("complete_pdf_inspection", **lease, p_result=output["value"])
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        writer.join(timeout=5)
        if not child.stdin.closed:
            child.stdin.close()
        child.stdout.close()
        thread.join(timeout=5)
