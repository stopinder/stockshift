"""Worker integrity, deterministic publication and safe failure/lease behavior."""

from contextlib import contextmanager
from dataclasses import asdict
from hashlib import sha256
from threading import Event
from uuid import uuid4

import pytest

from stockshift_worker.domain.csv_engine import CsvOptions
from stockshift_worker.jobs.gateway import LeaseLost, LocalGateway, TransportError
from stockshift_worker.jobs.runner import heartbeat, run_once

OPTIONS = asdict(
    CsvOptions(
        encoding="utf-8-sig",
        delimiter=",",
        decimal_separator=".",
        columns={"supplier_sku": "SKU", "cost_price": "Price", "description": "Description"},
        currency="GBP",
        pack_quantity="1",
        unit="each",
        price_basis="unit",
        tax_basis="net",
    )
)


class Gateway:
    def __init__(
        self, old=b"SKU,Price,Description\n001,0,A\n", new=b"SKU,Price,Description\n001,1,A\n"
    ):
        self.calls, self.completed, self.failed = [], None, None
        self.error = None
        tenant, run = str(uuid4()), str(uuid4())
        self.job = {
            "kind": "reconcile_csv",
            "id": str(uuid4()),
            "tenant_id": tenant,
            "comparison_run_id": run,
            "lease_token": str(uuid4()),
        }
        files = []
        self.blobs = {}
        for name, content in (("old.csv", old), ("new.csv", new)):
            id_ = str(uuid4())
            self.blobs[id_] = content
            files.append(
                {
                    "id": id_,
                    "tenant_id": tenant,
                    "status": "ready",
                    "original_filename": name,
                    "verified_mime": "text/csv",
                    "byte_count": len(content),
                    "sha256": sha256(content).hexdigest(),
                }
            )
        self.context = {
            "run": {
                "id": run,
                "tenant_id": tenant,
                "current_file_id": files[0]["id"],
                "incoming_file_id": files[1]["id"],
                "configuration": {"current": OPTIONS, "incoming": OPTIONS},
            },
            "current": files[0],
            "incoming": files[1],
        }

    def rpc(self, name, **payload):
        self.calls.append(name)
        if self.error and name == self.error[0]:
            raise self.error[1]
        if name == "claim_csv_job":
            return self.job
        if name == "load_csv_job":
            return self.context
        if name == "complete_csv_job":
            self.completed = payload["p_results"]
        if name == "fail_csv_job":
            self.failed = payload

    def download(self, file):
        return self.blobs[file["id"]]


def test_worker_persists_zero_percentage_state_exact_money_and_provenance():
    gateway = Gateway()
    assert run_once(gateway, str(uuid4()))
    row = gateway.completed[0]
    assert row["cost_delta"] == "1"
    assert row["cost_change_percent"] is None
    assert row["percentage_state"] == "zero_old_cost"
    assert row["old_values"]["supplier_sku"] == "001"
    assert row["old_values"]["cost_price"] == "0"
    assert len(row["provenance"]) == 6
    assert any(i["code"] == "zero_old_cost" for i in row["reasons"])
    assert gateway.failed is None


def test_duplicate_execution_builds_identical_result_ids_and_payload():
    gateway = Gateway()
    run_once(gateway, str(uuid4()))
    first = gateway.completed
    run_once(gateway, str(uuid4()))
    assert gateway.completed == first


def test_review_remains_pending_and_has_no_invented_match_score():
    gateway = Gateway(new=b"SKU,Price,Description\n,1,A\n")
    run_once(gateway, str(uuid4()))
    review = next(row for row in gateway.completed if row["outcome"] == "needs_review")
    assert review["review_state"] == "pending"
    assert review["cost_delta"] is None
    assert review["percentage_state"] == "not_comparable"
    assert "matching_score" not in review


@pytest.mark.parametrize(
    "field,value",
    [
        ("tenant_id", str(uuid4())),
        ("status", "pending"),
        ("byte_count", 1),
        ("verified_mime", "application/pdf"),
        ("sha256", "a" * 64),
    ],
)
def test_worker_rejects_unready_cross_tenant_or_tampered_sources(field, value):
    gateway = Gateway()
    gateway.context["current"][field] = value
    run_once(gateway, str(uuid4()))
    assert gateway.completed is None
    assert gateway.failed["p_retryable"] is False
    assert gateway.failed["p_failure"]["code"] == (
        "invalid_pdf_job"
        if field == "verified_mime" and value == "application/pdf"
        else "invalid_csv_job"
    )


def test_invalid_mapping_preserves_structured_failure_without_source_contents():
    gateway = Gateway(old=b"WRONG,Price,Description\nPRIVATE-SECRET,2,A\n")
    run_once(gateway, str(uuid4()))
    assert gateway.completed is None
    assert gateway.failed["p_failure"]["stage"] == "parse"
    assert "PRIVATE-SECRET" not in str(gateway.failed)


def test_transport_failure_schedules_retry():
    gateway = Gateway()
    gateway.error = ("load_csv_job", TransportError("secret response body"))
    run_once(gateway, str(uuid4()))
    assert gateway.failed["p_retryable"] is True
    assert gateway.failed["p_failure"]["code"] == "transport_unavailable"
    assert "secret" not in str(gateway.failed)


def test_stale_worker_never_completes_or_marks_replacement_failed():
    gateway = Gateway()
    gateway.error = ("load_csv_job", LeaseLost())
    run_once(gateway, str(uuid4()))
    assert gateway.completed is gateway.failed is None


def test_failed_heartbeat_prevents_publication(monkeypatch):
    @contextmanager
    def lost(*args):
        event = Event()
        event.set()
        yield event

    monkeypatch.setattr("stockshift_worker.jobs.runner.heartbeat", lost)
    gateway = Gateway()
    run_once(gateway, str(uuid4()))
    assert gateway.completed is gateway.failed is None


def test_idle_poll_does_not_load_inputs():
    gateway = Gateway()
    gateway.job = None
    assert run_once(gateway, str(uuid4())) is False
    assert gateway.calls == ["claim_csv_job"]


@pytest.mark.parametrize(
    "url",
    [
        "https://example.supabase.co",
        "http://example.test:54321",
        "http://127.0.0.1:54322",
        "http://user:pass@localhost:54321",
        "http://localhost:54321/other",
    ],
)
def test_gateway_rejects_hosted_or_nonlocal_urls(url):
    with pytest.raises(ValueError):
        LocalGateway(url, "synthetic-local-key")


def test_standard_hosted_environment_is_never_used(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "hosted-secret")
    monkeypatch.delenv("STOCKSHIFT_LOCAL_SUPABASE_URL", raising=False)
    monkeypatch.delenv("STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY", raising=False)
    with pytest.raises(ValueError):
        LocalGateway.from_env()


def test_unknown_encoding_is_terminal_configuration_failure():
    gateway = Gateway()
    gateway.context["run"]["configuration"] = {
        "current": {**OPTIONS, "encoding": "does-not-exist"},
        "incoming": OPTIONS,
    }
    run_once(gateway, str(uuid4()))
    assert gateway.failed["p_retryable"] is False
    assert gateway.completed is None


def test_background_heartbeat_renews_and_stops_on_lost_authorization():
    called = Event()

    class HeartbeatGateway:
        def rpc(self, name, **lease):
            assert name == "heartbeat_csv_job"
            assert lease["p_token"] == "test-token"
            called.set()
            raise LeaseLost()

    with heartbeat(HeartbeatGateway(), {"p_token": "test-token"}, interval=0.01) as lost:
        assert called.wait(1)
        assert lost.wait(1)
