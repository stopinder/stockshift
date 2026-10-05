"""Validated wire envelopes for the provider-neutral DocumentExtractor protocol."""

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Protocol

from stockshift_worker.contracts import validate_contract


@dataclass(frozen=True)
class ExtractionRequest:
    """A request validated on entry, with an isolated copy of its JSON payload."""

    _payload: dict[str, Any]

    def __post_init__(self) -> None:
        validate_contract("extraction-request", self._payload)
        object.__setattr__(self, "_payload", deepcopy(self._payload))

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "ExtractionRequest":
        return cls(payload)

    def to_payload(self) -> dict[str, Any]:
        return deepcopy(self._payload)


@dataclass(frozen=True)
class ExtractionResult:
    """An extraction result validated before leaving a provider boundary."""

    _payload: dict[str, Any]

    def __post_init__(self) -> None:
        validate_contract("extraction-result", self._payload)
        object.__setattr__(self, "_payload", deepcopy(self._payload))

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "ExtractionResult":
        return cls(payload)

    def to_payload(self) -> dict[str, Any]:
        return deepcopy(self._payload)


class JobContext(Protocol):
    """Runtime-owned cancellation and measured progress hooks."""

    def is_cancelled(self) -> bool: ...

    def report_progress(self, *, completed_units: int, total_units: int | None) -> None: ...


class DocumentExtractor(Protocol):
    """Extract records/evidence; never reconcile, calculate margins, or approve matches."""

    def extract(self, request: ExtractionRequest, context: JobContext) -> ExtractionResult: ...
