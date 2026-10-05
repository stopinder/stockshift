"""The exact same payload corpus is used by the TypeScript contract tests."""

import json
from pathlib import Path

import pytest

from stockshift_worker.contracts import ContractValidationError, validate_contract
from stockshift_worker.extraction.base import ExtractionRequest, ExtractionResult

ROOT = Path(__file__).resolve().parents[3]
CASES = json.loads((ROOT / "tests/fixtures/contracts/cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_shared_contracts(case):
    value = case["payload"]
    before = json.dumps(value, sort_keys=True)
    if case["valid"]:
        assert validate_contract(case["contract"], value) is value
    else:
        with pytest.raises(ContractValidationError):
            validate_contract(case["contract"], value)
    assert json.dumps(value, sort_keys=True) == before


def test_preserves_identifiers_scale_and_null():
    case = next(case for case in CASES if case["name"] == "normalized-product: valid v1")
    product = validate_contract("normalized-product", json.loads(json.dumps(case["payload"])))
    assert product["supplier_sku"] == "001821"
    assert product["manufacturer_part_number"] == "00017"
    assert product["cost_price"] == "6.4000"
    assert product["retail_price"] is None


def test_does_not_invent_confidence():
    case = next(case for case in CASES if case["name"] == "confidence: absent stays absent")
    assert "extraction_score" not in validate_contract("field-evidence", case["payload"])


@pytest.mark.parametrize(
    ("contract", "envelope"),
    [("extraction-request", ExtractionRequest), ("extraction-result", ExtractionResult)],
)
def test_provider_envelopes_validate_and_isolate_payloads(contract, envelope):
    case = next(case for case in CASES if case["contract"] == contract and case["valid"])
    payload = json.loads(json.dumps(case["payload"]))
    request_or_result = envelope.from_payload(payload)
    payload["schema_version"] = "v2"
    exported = request_or_result.to_payload()
    assert exported["schema_version"] == "v1"
    exported["schema_version"] = "v2"
    assert request_or_result.to_payload()["schema_version"] == "v1"
    with pytest.raises(ContractValidationError):
        envelope(payload)
