"""Daemon shutdown, explicit hosted credentials and CSV preview execution boundaries."""

import base64
import json
import signal
import sys
from threading import Event

import pytest
from test_job_runner import Gateway

from stockshift_worker.entrypoints import cli
from stockshift_worker.jobs import gateway, runner


def jwt(role):
    claims = base64.urlsafe_b64encode(json.dumps({"role": role}).encode()).decode().rstrip("=")
    return "e30." + claims + ".signature"


@pytest.mark.parametrize("key", ["sb_secret_test", jwt("service_role")])
def test_hosted_headers_and_response(key):
    client = gateway.HostedGateway("https://preview.supabase.co", key)
    captured = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self, limit):
            return b"null"

    class Opener:
        def open(self, request, timeout):
            captured.append(request)
            assert timeout == 30
            return Response()

    client.opener = Opener()
    assert client.rpc("claim_csv_job", p_worker="worker") is None
    assert captured[0].get_header("Apikey") == key
    assert captured[0].get_header("Authorization") == (
        None if key.startswith("sb_secret_") else "Bearer " + key
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://preview.supabase.co",
        "https://evil.test",
        "https://preview.supabase.co@evil.test",
        "https://preview.supabase.co/rest",
        "https://preview.supabase.co?key=x",
        "https://preview.supabase.co:444",
        "https://user:password@preview.supabase.co",
    ],
)
def test_reject_hosted_origins(url):
    with pytest.raises(ValueError):
        gateway.HostedGateway(url, "sb_secret_test")


@pytest.mark.parametrize("key", ["", "sb_publishable_test", jwt("anon"), "not-a-key"])
def test_reject_nonprivileged_keys(key):
    with pytest.raises(ValueError):
        gateway.HostedGateway("https://preview.supabase.co", key)


def test_local_and_hosted_do_not_fall_back(monkeypatch):
    monkeypatch.setenv("STOCKSHIFT_SUPABASE_URL", "https://preview.supabase.co")
    monkeypatch.setenv("STOCKSHIFT_SUPABASE_SECRET_KEY", "sb_secret_test")
    monkeypatch.delenv("STOCKSHIFT_SUPABASE_MODE", raising=False)
    monkeypatch.delenv("STOCKSHIFT_LOCAL_SUPABASE_URL", raising=False)
    with pytest.raises(ValueError):
        gateway.gateway_from_env()
    monkeypatch.setenv("STOCKSHIFT_SUPABASE_MODE", "hosted")
    assert isinstance(gateway.gateway_from_env(), gateway.HostedGateway)
    monkeypatch.setenv("STOCKSHIFT_SUPABASE_MODE", "invalid")
    with pytest.raises(ValueError):
        gateway.gateway_from_env()


def test_default_daemon_drains_on_sigterm(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["stockshift-worker"])
    monkeypatch.setattr(gateway, "gateway_from_env", lambda: object())
    calls = []

    def process(client, worker):
        calls.append("claim")
        signal.raise_signal(signal.SIGTERM)
        calls.append("complete current job")
        return True

    previous = signal.getsignal(signal.SIGTERM)
    monkeypatch.setattr(runner, "run_once", process)
    assert cli.main() == 0
    assert calls == ["claim", "complete current job"]
    assert signal.getsignal(signal.SIGTERM) == previous


def test_idle_shutdown_interrupts_poll_wait(monkeypatch):
    stop = Event()

    def empty(client, worker):
        stop.set()
        return False

    monkeypatch.setattr(runner, "run_once", empty)
    assert cli.serve(object(), "worker", stop, interval=60) == 0


def test_transient_claim_failure_retries_without_exiting(monkeypatch):
    stop, attempts = Event(), []

    def process(client, worker):
        attempts.append(1)
        if len(attempts) == 1:
            raise gateway.TransportError("unavailable")
        stop.set()
        return True

    monkeypatch.setattr(runner, "run_once", process)
    assert cli.serve(object(), "worker", stop, interval=0.001) == 0
    assert len(attempts) == 2


def test_once_and_check_are_bounded(monkeypatch):
    monkeypatch.setattr(runner, "run_once", lambda client, worker: False)
    assert cli.serve(object(), "worker", Event(), once=True) == 0
    monkeypatch.setattr(sys, "argv", ["stockshift-worker", "--check"])
    monkeypatch.setattr(gateway, "gateway_from_env", lambda: pytest.fail("no credentials/network"))
    assert cli.main() == 0


@pytest.mark.parametrize("kind", ["extract_pdf", "xlsx"])
def test_hosted_csv_preview_cannot_run_other_formats(monkeypatch, kind):
    monkeypatch.setenv("STOCKSHIFT_SUPABASE_MODE", "hosted")
    client = Gateway()
    if kind == "extract_pdf":
        client.job["kind"] = kind
    else:
        client.context["incoming"]["verified_mime"] = (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
    monkeypatch.setattr(runner, "extract_job", lambda *args: pytest.fail("must not call OCR"))
    assert runner.run_once(client, "worker")
    assert client.completed is None
    assert client.failed["p_retryable"] is False


def test_csv_preview_retains_decimal_provenance_and_review(monkeypatch):
    monkeypatch.setenv("STOCKSHIFT_SUPABASE_MODE", "hosted")
    client = Gateway(new=b"SKU,Price,Description\n001,19.995,A\n,1,Uncertain\n")
    runner.run_once(client, "worker")
    matched = next(row for row in client.completed if row["outcome"] == "changed")
    assert matched["new_values"]["supplier_sku"] == "001"
    assert matched["new_values"]["cost_price"] == "19.995"
    assert len(matched["provenance"]) == 6
    assert any(row["review_state"] == "pending" for row in client.completed)


def test_failure_write_transport_error_leaves_lease_recoverable():
    client = Gateway(new=b"Wrong,Price,Description\n001,1,A\n")
    client.error = ("fail_csv_job", gateway.TransportError("unavailable"))
    assert runner.run_once(client, "worker")
    assert client.completed is None
