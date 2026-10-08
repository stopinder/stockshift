"""Real CPU subprocess and benchmark documents, without OCR or external services."""

import json
import subprocess
import sys
from copy import deepcopy
from pathlib import Path
from threading import Event
from uuid import uuid4

import pytest
from pdf_fixture import pdf_bytes
from test_pdf_jobs import Gateway as ExtractionGateway

from stockshift_worker.extraction.digital_pdf import PdfError
from stockshift_worker.extraction.pdf_inspection import inspect_document
from stockshift_worker.jobs import inspection, runner
from stockshift_worker.jobs.gateway import LeaseLost, TransportError

ROOT = Path(__file__).resolve().parents[3]
BENCHMARK = ROOT / "tests/fixtures/catalogue-benchmark/synthetic"
BLINDTEX = ROOT / "services/worker/tests/fixtures/catalogue_layout/remaining/awkward-catalogue.pdf"


class Gateway(ExtractionGateway):
    def __init__(self, data=None):
        super().__init__(data)
        self.calls = []
        self.job["kind"] = "inspect_pdf"
        self.job["inspection_run_id"] = self.job.pop("extraction_run_id")
        self.context["inspection"] = self.context.pop("extraction")

    def rpc(self, name, **payload):
        self.calls.append(name)
        if name == "cpu_pdf_workers_agree":
            return True
        if name == "load_pdf_inspection":
            return deepcopy(self.context)
        if name == "complete_pdf_inspection":
            if self.lose:
                raise LeaseLost("Expired")
            self.published = payload["p_result"]
            return
        if name in ("load_csv_job", "load_pdf_extraction", "record_ocr_page"):
            pytest.fail("Inspection must never reconcile/extract/request OCR")
        return super().rpc(name, **payload)


@pytest.mark.parametrize(
    "path,pages,state",
    [
        (BENCHMARK / "old-catalogue.pdf", 1, "inspected"),
        (BENCHMARK / "new-catalogue.pdf", 1, "inspected"),
        (BLINDTEX, 1, "ocr_required"),
    ],
)
def test_real_benchmark_cpu_worker(path, pages, state, monkeypatch):
    # Hosted restriction must still allow explicit CPU inspection, never PDF extraction.
    monkeypatch.setenv("STOCKSHIFT_SUPABASE_MODE", "hosted")
    monkeypatch.setenv("STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED", "1")
    monkeypatch.setenv("STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED", "0")
    monkeypatch.setenv("STOCKSHIFT_OCR_ENDPOINT", "https://must-not-be-called.invalid")
    monkeypatch.setattr(runner, "extract_job", lambda *a: pytest.fail("No extraction/OCR"))
    g = Gateway(path.read_bytes())
    assert runner.run_once(g, g.lease["p_worker"])
    assert g.failed is None
    assert g.published["page_count"] == pages
    assert g.published["state"] == state
    assert len(g.published["diagnostics"]) == pages
    assert set(g.calls) <= {
        "register_cpu_pdf_worker",
        "cpu_pdf_workers_agree",
        "claim_csv_job",
        "load_pdf_inspection",
        "heartbeat_csv_job",
        "complete_pdf_inspection",
    }
    assert "records" not in g.published


@pytest.mark.parametrize("data", [b"%PDF-1.7 corrupt", pdf_bytes(encrypted=True)])
def test_corrupt_and_encrypted_terminal(data):
    g = Gateway(data)
    runner.run_once(g, g.lease["p_worker"])
    assert g.published is None and g.failed["p_retryable"] is False
    assert g.failed["p_failure"]["code"] == "invalid_pdf_job"


@pytest.mark.parametrize(
    "field,value",
    [
        ("tenant_id", str(uuid4())),
        ("status", "pending"),
        ("verified_mime", "text/csv"),
        ("byte_count", 0),
        ("byte_count", 10485761),
        ("byte_count", 1),
        ("sha256", "a" * 64),
        ("bucket_id", "public"),
        ("object_name", "other/object"),
    ],
)
def test_registered_metadata_and_integrity_fail_closed(field, value):
    g = Gateway()
    g.context["file"][field] = value
    runner.run_once(g, g.lease["p_worker"])
    assert g.published is None and g.failed["p_retryable"] is False


def test_inspection_identity_is_same_tenant_source():
    g = Gateway()
    g.context["inspection"]["source_file_id"] = str(uuid4())
    runner.run_once(g, g.lease["p_worker"])
    assert g.published is None and not g.failed["p_retryable"]


def test_timeout_kills_child_without_publication():
    g = Gateway()
    with pytest.raises(TimeoutError, match="inspection timed out"):
        inspection.inspect_job(g, g.job, g.lease, Event(), timeout=0)
    assert g.published is None


def test_heartbeat_loss_never_publishes():
    g, lost = Gateway(), Event()
    lost.set()
    with pytest.raises(LeaseLost):
        inspection.inspect_job(g, g.job, g.lease, lost)
    assert g.published is None


def test_stale_completion_does_not_fail_replacement():
    g = Gateway()
    g.lose = True
    runner.run_once(g, g.lease["p_worker"])
    assert g.published is None and g.failed is None


def test_transient_download_retries():
    g = Gateway()

    def unavailable(file):
        raise TransportError("Unavailable")

    g.download = unavailable
    runner.run_once(g, g.lease["p_worker"])
    assert g.published is None and g.failed["p_retryable"]
    assert g.failed["p_failure"]["code"] == "transport_unavailable"


def test_unknown_job_kind_does_not_fall_through_to_comparison():
    g = Gateway()
    g.job["kind"] = "unknown"
    runner.run_once(g, g.lease["p_worker"])
    assert g.published is None and not g.failed["p_retryable"]
    assert "load_csv_job" not in g.calls


def test_all_pages_are_probed_and_merged_tables_require_ocr():
    result = inspect_document(pdf_bytes(image_only=True))
    assert result["page_count"] == 2
    assert all(row["state"] == "ocr_required" for row in result["diagnostics"])
    assert inspect_document(pdf_bytes(merged=True))["state"] == "ocr_required"


def test_document_page_cap():
    with pytest.raises(PdfError, match="at most 50"):
        inspect_document(pdf_bytes(pages=[[["SKU", "Price"], ["001", "1"]]] * 51))


def test_child_has_no_secrets_or_ocr_imports(monkeypatch):
    monkeypatch.setenv("STOCKSHIFT_SUPABASE_SECRET_KEY", "secret")
    monkeypatch.setenv("STOCKSHIFT_OCR_TOKEN", "secret")
    original, seen = subprocess.Popen, []

    def start(args, **kwargs):
        seen.append(kwargs["env"])
        assert args[-1] == "stockshift_worker.entrypoints.pdf_inspection"
        return original(args, **kwargs)

    monkeypatch.setattr(inspection.subprocess, "Popen", start)
    g = Gateway()
    runner.run_once(g, g.lease["p_worker"])
    assert g.published
    assert set(seen[0]) <= {"SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP"}
    monkeypatch.setattr(inspection.subprocess, "Popen", original)
    check = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            "import sys; import stockshift_worker.entrypoints.pdf_inspection; "
            "assert not any('paddleocr' in m or 'mapped_pdf' in m for m in sys.modules)",
        ],
        capture_output=True,
    )
    assert check.returncode == 0, check.stderr


def test_inspection_entrypoint_rejects_extraction_operation():
    result = subprocess.run(
        [sys.executable, "-I", "-m", "stockshift_worker.entrypoints.pdf_inspection"],
        input=json.dumps({"operation": "extract", "data": ""}).encode(),
        capture_output=True,
    )
    assert "Only inspect_pdf" in json.loads(result.stdout)["error"]
