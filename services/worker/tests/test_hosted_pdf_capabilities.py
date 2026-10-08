"""Hosted policy without external networking or OCR execution."""

import json
import os
import subprocess
import sys
from threading import Event

import pytest

from stockshift_worker.jobs.capabilities import hosted_pdf_capabilities
from stockshift_worker.jobs.gateway import HostedGateway
from stockshift_worker.jobs.inspection import inspect_job
from stockshift_worker.jobs.pdf import extract_job
from stockshift_worker.jobs.runner import verified_catalogue


def test_missing_capabilities_are_off():
    assert hosted_pdf_capabilities({}) == {"inspection": False, "extraction": False}


@pytest.mark.parametrize("configuration", [{"provider": "auto"}, {"layout_association": {"x": 1}}])
def test_cpu_subprocess_rejects_routing_before_provider_initialization(configuration):
    result = subprocess.run(
        [sys.executable, "-I", "-m", "stockshift_worker.entrypoints.pdf"],
        input=json.dumps({"operation": "extract", "data": "", "configuration": configuration}),
        text=True,
        capture_output=True,
        env={**os.environ, "STOCKSHIFT_CPU_PDF_ONLY": "1"},
        timeout=10,
    )
    assert "CPU PDF extraction cannot invoke OCR" in json.loads(result.stdout)["error"]


@pytest.mark.parametrize("inspection,extraction", [("0", "0"), ("1", "0"), ("1", "1")])
def test_supported_profiles(inspection, extraction):
    assert hosted_pdf_capabilities(
        {
            "STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED": inspection,
            "STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED": extraction,
        }
    ) == {"inspection": inspection == "1", "extraction": extraction == "1"}


@pytest.mark.parametrize(
    "env",
    [
        {"STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED": "1"},
        {"STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED": "true"},
        {"STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED": "1", "STOCKSHIFT_CSV_ONLY": "1"},
        {"STOCKSHIFT_OCR_ENABLED": "1"},
    ],
)
def test_inconsistent_configuration_rejected(env):
    with pytest.raises(ValueError):
        hosted_pdf_capabilities(env)


def test_disabled_jobs_fail_before_load_download_or_subprocess(monkeypatch):
    monkeypatch.setenv("STOCKSHIFT_SUPABASE_MODE", "hosted")
    monkeypatch.delenv("STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED", raising=False)
    monkeypatch.delenv("STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED", raising=False)
    for operation in (inspect_job, extract_job):
        with pytest.raises(ValueError, match="disabled"):
            operation(None, {}, {}, Event())


@pytest.mark.parametrize(
    "configuration", [{"provider": "auto"}, {"provider": "digital", "layout_association": {"x": 1}}]
)
def test_hosted_rejects_provider_fallback_before_download(monkeypatch, configuration):
    monkeypatch.setenv("STOCKSHIFT_SUPABASE_MODE", "hosted")
    monkeypatch.setenv("STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED", "1")
    monkeypatch.setenv("STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED", "1")

    class Gateway:
        def rpc(self, *args, **kwargs):
            if args[0] == "cpu_pdf_workers_agree":
                return True
            return {"extraction": {"configuration": configuration}, "file": {}}

        def download(self, *args):
            pytest.fail("Non-digital job downloaded bytes")

    with pytest.raises(ValueError, match="OCR is disabled"):
        extract_job(Gateway(), {}, {}, Event())


def test_hosted_gateway_forbids_ocr_rpc_without_network():
    gateway = HostedGateway("https://fixture.supabase.co", "sb_secret_fixture")
    with pytest.raises(ValueError, match="cannot request"):
        gateway.rpc("record_ocr_page")


def test_mixed_worker_profiles_prevent_cpu_load(monkeypatch):
    monkeypatch.setenv("STOCKSHIFT_SUPABASE_MODE", "hosted")
    monkeypatch.setenv("STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED", "1")
    monkeypatch.setenv("STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED", "1")

    class Gateway:
        def rpc(self, name, **kwargs):
            assert name == "cpu_pdf_workers_agree"
            return False

    with pytest.raises(ValueError, match="disagree"):
        inspect_job(Gateway(), {}, {}, Event())


def test_inspection_only_cannot_compare_pdf(monkeypatch):
    monkeypatch.setenv("STOCKSHIFT_SUPABASE_MODE", "hosted")
    monkeypatch.setenv("STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED", "1")
    monkeypatch.setenv("STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED", "0")
    with pytest.raises(ValueError, match="disabled"):
        verified_catalogue(None, {"verified_mime": "application/pdf"}, "tenant", {})
