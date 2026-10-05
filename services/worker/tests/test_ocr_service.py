"""Real local HTTP, rendering, isolated worker protocol; mocked inference only."""

from threading import Event

import pytest
from ocr_fixture import scanned_pdf
from ocr_stub import running
from test_pdf_jobs import Gateway as BaseGateway

from stockshift_worker.extraction.paddleocr import OcrFailure, PaddleClient
from stockshift_worker.jobs.pdf import extract_job


class Gateway(BaseGateway):
    def __init__(self, *args):
        super().__init__(*args)
        self.calls = []

    def rpc(self, name, **args):
        self.calls.append((name, args))
        return super().rpc(name, **args)


CFG = {
    "first_page": 1,
    "last_page": 2,
    "strategy": "lines",
    "provider": "auto",
    "model_version": "PaddleOCR-VL-1.6",
    "dpi": 144,
    "ocr_version": "1",
}


@pytest.mark.parametrize("mixed,calls", [(False, 2), (True, 1)])
def test_isolated_worker_with_real_http_stub(monkeypatch, mixed, calls):
    with running() as service:
        monkeypatch.setenv(
            "STOCKSHIFT_OCR_ENDPOINT", f"http://127.0.0.1:{service.server_port}/layout-parsing"
        )
        gateway = Gateway(scanned_pdf(mixed=mixed), CFG)
        extract_job(gateway, gateway.job, gateway.lease, Event())
        assert len(service.calls) == calls
        complete = [v for name, v in gateway.calls if name == "complete_pdf_extraction"][0]
        assert complete["p_payload"]["completion"]["state"] == "complete"
        assert len(complete["p_payload"]["records"]) == 5
        assert sum(name == "record_ocr_page" for name, v in gateway.calls) == calls * 2


@pytest.mark.parametrize(
    "mode,code",
    [
        ("rate_once", "ocr_rate_limit"),
        ("unavailable", "ocr_unavailable"),
        ("malformed", "ocr_structure"),
    ],
)
def test_endpoint_failure_is_structured_and_retryable(monkeypatch, mode, code):
    with running(mode) as service:
        monkeypatch.setenv(
            "STOCKSHIFT_OCR_ENDPOINT", f"http://127.0.0.1:{service.server_port}/layout-parsing"
        )
        gateway = Gateway(scanned_pdf(), CFG)
        if mode == "malformed":
            extract_job(gateway, gateway.job, gateway.lease, Event())
            result = [v for name, v in gateway.calls if name == "complete_pdf_extraction"][0]
            assert result["p_payload"]["completion"]["state"] == "incomplete"
        else:
            with pytest.raises(OcrFailure) as error:
                extract_job(gateway, gateway.job, gateway.lease, Event())
            assert error.value.code == code and error.value.retryable
        failed = [
            v for name, v in gateway.calls if name == "record_ocr_page" and v["p_event"] == "failed"
        ]
        assert len(failed) == 2
        assert failed[0]["p_value"]["code"] == code


def test_http_adapter_timeout_has_safe_retryable_message(monkeypatch):
    monkeypatch.setenv("STOCKSHIFT_OCR_ENDPOINT", "http://127.0.0.1:8779/layout-parsing")
    client = PaddleClient("PaddleOCR-VL-1.6")

    class Timeout:
        def open(self, *args, **kwargs):
            raise TimeoutError("secret internal address")

    client.opener = Timeout()
    with pytest.raises(OcrFailure) as error:
        client.predict(b"png", "a" * 64)
    assert error.value.retryable and "secret" not in str(error.value)


def test_fencing_rejection_prevents_http_request(monkeypatch):
    from stockshift_worker.jobs.gateway import LeaseLost

    with running() as service:
        monkeypatch.setenv(
            "STOCKSHIFT_OCR_ENDPOINT", f"http://127.0.0.1:{service.server_port}/layout-parsing"
        )
        gateway = Gateway(scanned_pdf(), CFG)
        original = gateway.rpc

        def rpc(name, **args):
            if name == "record_ocr_page":
                raise LeaseLost("expired")
            return original(name, **args)

        gateway.rpc = rpc
        with pytest.raises(LeaseLost):
            extract_job(gateway, gateway.job, gateway.lease, Event())
        assert not service.calls
