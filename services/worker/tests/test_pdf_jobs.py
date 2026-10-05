"""Real isolated PDF subprocess plus durable worker dispatch, failure and lease behavior."""

from copy import deepcopy
from hashlib import sha256
from threading import Event
from uuid import uuid4

import pytest
from pdf_fixture import pdf_bytes

from stockshift_worker.jobs.gateway import LeaseLost
from stockshift_worker.jobs.pdf import extract_job
from stockshift_worker.jobs.runner import run_once


class Gateway:
    def __init__(self, data=None, configuration=None):
        self.data = pdf_bytes() if data is None else data
        tenant, file, extraction, job, token = (str(uuid4()) for _ in range(5))
        self.job = {
            "id": job,
            "tenant_id": tenant,
            "kind": "extract_pdf",
            "extraction_run_id": extraction,
            "comparison_run_id": None,
            "lease_token": token,
        }
        self.lease = {"p_tenant": tenant, "p_job": job, "p_worker": str(uuid4()), "p_token": token}
        self.context = {
            "extraction": {
                "id": extraction,
                "tenant_id": tenant,
                "source_file_id": file,
                "configuration": configuration
                or {"first_page": 1, "last_page": 2, "strategy": "lines"},
            },
            "file": {
                "id": file,
                "tenant_id": tenant,
                "status": "ready",
                "verified_mime": "application/pdf",
                "byte_count": len(self.data),
                "sha256": sha256(self.data).hexdigest(),
                "bucket_id": "catalogue-uploads",
                "object_name": f"{tenant}/{file}/original",
            },
        }
        self.progress, self.published, self.failed = [], None, None
        self.lose = False

    def rpc(self, name, **payload):
        if name == "claim_csv_job":
            return self.job
        if name == "load_pdf_extraction":
            return deepcopy(self.context)
        if name == "pdf_extraction_progress":
            if self.lose:
                raise LeaseLost("Reclaimed")
            self.progress.append((payload["p_completed"], payload["p_total"]))
        if name == "complete_pdf_extraction":
            self.published = payload
        if name == "fail_csv_job":
            self.failed = payload

    def download(self, file):
        return self.data


def test_real_pdf_subprocess_progress_and_completion():
    g = Gateway()
    assert run_once(g, g.lease["p_worker"])
    assert g.progress == [(0, 2), (1, 2), (2, 2)]
    assert g.published["p_payload"]["file_id"] == g.context["file"]["id"]
    assert g.published["p_payload"]["completion"]["state"] == "complete"
    assert len(g.published["p_pages"]) == 2
    assert g.failed is None


def test_scanned_pdf_completes_as_incomplete_not_retrying_forever():
    g = Gateway(pdf_bytes(image_only=True))
    run_once(g, g.lease["p_worker"])
    assert g.published["p_payload"]["completion"]["state"] == "incomplete"
    assert g.failed is None


@pytest.mark.parametrize("data", [b"%PDF-1.7 corrupted", pdf_bytes(encrypted=True)])
def test_parser_safe_failure_is_structured_and_terminal(data):
    g = Gateway(data)
    run_once(g, g.lease["p_worker"])
    assert g.published is None
    assert g.failed["p_failure"]["code"] == "invalid_pdf_job"
    assert g.failed["p_retryable"] is False
    assert "Traceback" not in g.failed["p_failure"]["message"]


def test_extraction_deadline_terminates_subprocess_without_publication():
    g = Gateway()
    with pytest.raises(TimeoutError, match="Select fewer pages"):
        extract_job(g, g.job, g.lease, Event(), timeout=0)
    assert g.published is None


def test_lost_lease_terminates_extraction_and_never_reports_failure():
    g = Gateway()
    g.lose = True
    run_once(g, g.lease["p_worker"])
    assert g.published is None and g.failed is None


def test_cancellation_after_heartbeat_loss_never_publishes():
    g, lost = Gateway(), Event()
    lost.set()
    with pytest.raises(LeaseLost):
        extract_job(g, g.job, g.lease, lost)
    assert g.published is None


@pytest.mark.parametrize(
    "field,value",
    [
        ("tenant_id", str(uuid4())),
        ("status", "pending"),
        ("verified_mime", "text/csv"),
        ("byte_count", 0),
        ("sha256", "a" * 64),
    ],
)
def test_pdf_metadata_integrity_and_tenant_fail_closed(field, value):
    g = Gateway()
    g.context["file"][field] = value
    run_once(g, g.lease["p_worker"])
    assert g.published is None
    assert g.failed["p_failure"]["code"] == "invalid_pdf_job"
    assert g.failed["p_retryable"] is False


def test_timeout_is_retryable_and_safe_in_worker(monkeypatch):
    def timeout(*args, **kwargs):
        raise TimeoutError("PDF extraction timed out. Select fewer pages and retry.")

    monkeypatch.setattr("stockshift_worker.jobs.runner.extract_job", timeout)
    g = Gateway()
    run_once(g, g.lease["p_worker"])
    assert g.failed["p_failure"]["code"] == "pdf_timeout"
    assert g.failed["p_retryable"] is True
    assert g.published is None
