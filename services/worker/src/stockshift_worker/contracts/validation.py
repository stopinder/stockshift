"""Offline, non-coercing contract validation shared with the TypeScript runtime."""

import json
from functools import lru_cache
from importlib.resources import files
from typing import Any, Literal

from jsonschema import Draft7Validator, FormatChecker
from referencing import Registry, Resource

ContractName = Literal[
    "normalized-product",
    "field-evidence",
    "extraction-request",
    "extraction-result",
    "job-status",
    "comparison-outcome",
]
CONTRACT_NAMES = (
    "normalized-product",
    "field-evidence",
    "extraction-request",
    "extraction-result",
    "job-status",
    "comparison-outcome",
)


class ContractValidationError(ValueError):
    """A payload violates its versioned contract."""

    def __init__(self, contract: str, issues: tuple[str, ...]) -> None:
        super().__init__(f"Invalid {contract} contract")
        self.contract = contract
        self.issues = issues


@lru_cache(maxsize=1)
def _validators() -> dict[str, Draft7Validator]:
    directory = files("stockshift_worker.contracts").joinpath("schemas", "v1")
    schemas = [
        json.loads(item.read_text(encoding="utf-8"))
        for item in directory.iterdir()
        if item.name.endswith(".schema.json")
    ]
    registry = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema)) for schema in schemas
    )
    validators = {}
    for schema in schemas:
        Draft7Validator.check_schema(schema)
        name = schema["$id"].rsplit("/", 1)[-1].removesuffix(".schema.json")
        if name in CONTRACT_NAMES:
            validators[name] = Draft7Validator(
                schema, registry=registry, format_checker=FormatChecker()
            )
    return validators


def validate_contract(name: ContractName, value: Any) -> Any:
    """Return the same valid value; never add defaults, coerce, or mutate it."""
    if name not in CONTRACT_NAMES:
        raise ValueError(f"Unknown contract: {name}")
    errors = tuple(_validators()[name].iter_errors(value))
    if errors:
        issues = tuple(
            f"/{'/'.join(str(part) for part in error.absolute_path)}: {error.message}"
            for error in errors
        )
        raise ContractValidationError(name, issues)
    # Draft 7 cannot compare sibling properties; keep these guards in parity with TS.
    counters = (
        value["completion"]
        if name == "extraction-result"
        else (value if name == "job-status" else None)
    )
    if counters is not None and counters["total_units"] is not None:
        exceeds_total = counters["completed_units"] > counters["total_units"]
        incomplete_claim = (
            name == "extraction-result"
            and counters["state"] == "complete"
            and counters["completed_units"] != counters["total_units"]
        )
        if exceeds_total or incomplete_claim:
            raise ContractValidationError(
                name,
                ("completed units must not exceed total; complete extraction must equal total",),
            )
    return value
