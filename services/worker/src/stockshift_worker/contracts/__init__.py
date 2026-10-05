"""Validation against packaged copies of the canonical JSON Schemas."""

from .validation import ContractValidationError, validate_contract

__all__ = ["ContractValidationError", "validate_contract"]
