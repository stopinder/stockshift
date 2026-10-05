"""Local CSV import, exact reconciliation and approved-change export.

Wire objects are validated v1 dictionaries. Decimal arithmetic uses a local context
large enough for exact subtraction; percentages round to six places, half even.
No source price is rounded. CSV row locators are physical starting line numbers.
"""

import codecs
import csv
import io
import re
from collections import defaultdict
from dataclasses import dataclass
from decimal import ROUND_HALF_EVEN, Context, Decimal, localcontext
from typing import Any
from uuid import UUID, uuid5

from stockshift_worker.contracts import validate_contract

FIELDS = (
    "supplier_sku",
    "description",
    "manufacturer",
    "manufacturer_part_number",
    "gtin",
    "pack_quantity",
    "unit",
    "cost_price",
    "retail_price",
    "rrp",
    "currency",
    "price_basis",
    "tax_basis",
    "availability",
)
DECIMALS = {"cost_price", "retail_price", "rrp", "pack_quantity"}


def issue(code: str, field: str | None, message: str) -> dict[str, Any]:
    return {"code": code, "field": field, "message": message}


@dataclass(frozen=True)
class CsvOptions:
    """All syntax and commercial assumptions are caller supplied, never detected."""

    encoding: str
    delimiter: str
    columns: dict[str, str]
    decimal_separator: str
    thousands_separator: str | None = None
    currency: str | None = None
    unit: str | None = None
    pack_quantity: str | None = None
    price_basis: str | None = None
    tax_basis: str | None = None
    currency_symbol: str | None = None

    def __post_init__(self) -> None:
        codecs.lookup(self.encoding)
        if len(self.delimiter) != 1 or self.delimiter in '\r\n"':
            raise ValueError("delimiter must be one character other than quote or newline")
        if self.decimal_separator not in (".", ","):
            raise ValueError("decimal_separator must be '.' or ','")
        if self.thousands_separator not in (None, ".", ",", " "):
            raise ValueError("unsupported thousands_separator")
        if self.thousands_separator == self.decimal_separator:
            raise ValueError("decimal and thousands separators must differ")
        if not {"supplier_sku", "cost_price"} <= self.columns.keys():
            raise ValueError("map supplier_sku and cost_price headers explicitly")
        if not self.columns.keys() <= set(FIELDS):
            raise ValueError("unknown mapped field")
        if len(set(self.columns.values())) != len(self.columns):
            raise ValueError("each mapped field requires a distinct header")
        if any(not header for header in self.columns.values()):
            raise ValueError("mapped headers cannot be blank")
        if self.currency is not None and not re.fullmatch(r"[A-Z]{3}", self.currency):
            raise ValueError("currency must be a three-letter uppercase code")
        if self.price_basis not in (None, "unit", "pack"):
            raise ValueError("invalid price_basis")
        if self.tax_basis not in (None, "net", "gross"):
            raise ValueError("invalid tax_basis")
        if self.unit is not None and not self.unit.strip():
            raise ValueError("unit cannot be blank")
        if self.currency_symbol is not None and not self.currency_symbol:
            raise ValueError("currency_symbol cannot be empty")
        if self.pack_quantity is not None:
            if len(self.pack_quantity) > 128:
                raise ValueError("default pack_quantity exceeds 128 characters")
            if not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", self.pack_quantity):
                raise ValueError("default pack_quantity must be canonical decimal text")
            if Decimal(self.pack_quantity) <= 0:
                raise ValueError("default pack_quantity must be positive")


@dataclass(frozen=True)
class Catalogue:
    source_file_id: str
    source_name: str
    products: tuple[dict[str, Any], ...]
    evidence: tuple[dict[str, Any], ...]


def parse_decimal(raw: str, options: CsvOptions, *, money: bool = True) -> str:
    token = raw.strip()
    if money and options.currency_symbol and token.startswith(options.currency_symbol):
        token = token[len(options.currency_symbol) :].strip()
    separator = re.escape(options.decimal_separator)
    grouping = options.thousands_separator
    integer = r"[0-9]+"
    if grouping:
        integer = rf"(?:[0-9]+|[0-9]{{1,3}}(?:{re.escape(grouping)}[0-9]{{3}})+)"
    if not re.fullmatch(rf"-?{integer}(?:{separator}[0-9]+)?", token):
        raise ValueError("price/quantity violates the configured numeric convention")
    if grouping:
        token = token.replace(grouping, "")
    token = token.replace(options.decimal_separator, ".")
    # Bound input precision, not value through rounding; reject excessive tokens.
    if len(token) > 128:
        raise ValueError("decimal token exceeds 128 characters")
    value = Decimal(token)
    if value < 0 or (not money and value == 0):
        raise ValueError("prices must be nonnegative and pack quantity must be positive")
    return format(value, "f")


def parse_csv(
    data: bytes, *, source_file_id: str, source_name: str, options: CsvOptions
) -> Catalogue:
    """Fail closed for invalid syntax/encoding/mapping; retain invalid cell records."""
    namespace = UUID(source_file_id)
    if str(namespace) != source_file_id:
        raise ValueError("source_file_id must be a canonical lowercase UUID")
    if not source_name:
        raise ValueError("source_name is required")
    text = data.decode(options.encoding, errors="strict")
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=options.delimiter, strict=True)
    try:
        headers = next(reader)
    except StopIteration as exc:
        raise ValueError("CSV has no header") from exc
    if len(set(headers)) != len(headers) or any(not header.strip() for header in headers):
        raise ValueError("CSV headers must be nonblank and unique")
    if not set(options.columns.values()) <= set(headers):
        raise ValueError("mapped header is absent from CSV; check delimiter and header mapping")

    def rows():
        while True:
            row_number = reader.line_num + 1
            try:
                cells = next(reader)
            except StopIteration:
                break
            if not cells:
                continue
            if len(cells) != len(headers):
                raise ValueError(f"CSV row starting at line {row_number} has wrong column count")
            yield row_number, cells

    return normalize_rows(source_file_id, source_name, options, headers, rows())


def normalize_rows(source_file_id, source_name, options, headers, rows, *, sheet=None):
    """Shared CSV/XLSX normalization; syntax readers supply explicit row locators."""
    namespace = UUID(source_file_id)
    indexes = {field: headers.index(header) for field, header in options.columns.items()}
    products, evidence = [], []
    prefix = f"sheet:{sheet}:" if sheet is not None else ""
    for row_number, cells in rows:
        record_id = str(uuid5(namespace, f"{prefix}row:{row_number}"))
        product = dict.fromkeys(FIELDS)
        product.update(
            schema_version="v1",
            record_id=record_id,
            source_file_id=source_file_id,
            normalized_supplier_sku=None,
            validation_issues=[],
            evidence_ids=[],
        )
        for field in ("currency", "unit", "pack_quantity", "price_basis", "tax_basis"):
            product[field] = getattr(options, field)
        for field, index in indexes.items():
            raw = cells[index]
            evidence_id = str(uuid5(namespace, f"{prefix}row:{row_number}:column:{index}"))
            locator = dict.fromkeys(
                (
                    "page",
                    "sheet",
                    "row",
                    "column",
                    "table",
                    "cell",
                    "bounding_polygon",
                    "coordinate_system",
                )
            )
            locator.update(row=row_number, column=headers[index], sheet=sheet)
            item = {
                "schema_version": "v1",
                "evidence_id": evidence_id,
                "record_id": record_id,
                "source_file_id": source_file_id,
                "field_name": field,
                "raw_text": raw,
                "locator": locator,
                "artifact": None,
            }
            evidence.append(validate_contract("field-evidence", item))
            product["evidence_ids"].append(evidence_id)
            value = raw if raw.strip() else None
            if field in DECIMALS and value is not None:
                try:
                    value = parse_decimal(raw, options, money=field != "pack_quantity")
                except ValueError as exc:
                    product["validation_issues"].append(issue("invalid_decimal", field, str(exc)))
                    value = None
            if field == "currency" and value is not None:
                if not re.fullmatch(r"[A-Z]{3}", value):
                    product["validation_issues"].append(
                        issue("invalid_currency", field, "Use an uppercase three-letter currency")
                    )
                    value = None
            if field in ("price_basis", "tax_basis") and value is not None:
                allowed = ("unit", "pack") if field == "price_basis" else ("net", "gross")
                if value not in allowed:
                    product["validation_issues"].append(
                        issue("invalid_basis", field, "Unknown price/tax basis")
                    )
                    value = None
            product[field] = value
        for field in ("supplier_sku", "cost_price"):
            if product[field] is None:
                product["validation_issues"].append(
                    issue("missing_value", field, "Required comparison value is missing")
                )
        sku = product["supplier_sku"]
        if sku and sku != sku.strip():
            product["validation_issues"].append(
                issue("identifier_whitespace", "supplier_sku", "SKU has surrounding whitespace")
            )
        # No identifier normalization for matching in this increment.
        products.append(validate_contract("normalized-product", product))
    return Catalogue(source_file_id, source_name, tuple(products), tuple(evidence))


def _collision_keys(product: dict[str, Any]) -> list[tuple[str, ...]]:
    keys = []
    if product["supplier_sku"]:
        keys.append(("sku", product["supplier_sku"].strip().casefold()))
    if product["gtin"]:
        keys.append(("gtin", product["gtin"]))
    if product["manufacturer"] and product["manufacturer_part_number"]:
        keys.append(("mpn", product["manufacturer"], product["manufacturer_part_number"]))
    return keys


def reconcile(old: Catalogue, new: Catalogue) -> tuple[dict[str, Any], ...]:
    """Reserve every input once; ambiguous groups become individual review rows."""
    if old.source_file_id == new.source_file_id:
        raise ValueError("comparison sides require distinct source_file_id values")
    groups: dict[str, list[list[dict[str, Any]]]] = {}
    blocked: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for side, catalogue in enumerate((old, new)):
        for product in catalogue.products:
            validate_contract("normalized-product", product)
            blocked[product["record_id"]].extend(product["validation_issues"])
            if product["supplier_sku"] is not None:
                groups.setdefault(product["supplier_sku"], [[], []])[side].append(product)
    for sides in groups.values():
        if any(len(side) > 1 for side in sides):
            for product in sides[0] + sides[1]:
                blocked[product["record_id"]].append(
                    issue("duplicate_sku", "supplier_sku", "SKU is not unique in an input")
                )
    # Corroborating identifiers never create matches, but can veto a conflicting SKU match.
    keys: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for product in old.products + new.products:
        for key in _collision_keys(product):
            keys[key].append(product)
    for entries in keys.values():
        if len({p["supplier_sku"] for p in entries}) > 1:
            for product in entries:
                blocked[product["record_id"]].append(
                    issue(
                        "identifier_collision",
                        "supplier_sku",
                        "Another raw SKU shares an identifier or normalized spelling",
                    )
                )
    results = []
    consumed = set()

    def emit(
        a: dict[str, Any] | None,
        b: dict[str, Any] | None,
        outcome: str,
        flags: list[str],
        issues: list[dict[str, Any]],
        delta: str | None = None,
        percent: str | None = None,
    ) -> None:
        a_id, b_id = a["record_id"] if a else None, b["record_id"] if b else None
        payload = {
            "schema_version": "v1",
            "result_id": str(uuid5(UUID(old.source_file_id), f"{a_id}:{b_id}")),
            "old_record_id": a_id,
            "new_record_id": b_id,
            "outcome": outcome,
            "review_state": "pending" if outcome == "needs_review" else "not_required",
            "change_flags": flags,
            "cost_delta": delta,
            "cost_change_percent": percent,
            "old_margin_percent": None,
            "new_margin_percent": None,
            "margin_point_delta": None,
            "calculation_issues": issues,
        }
        results.append(validate_contract("comparison-outcome", payload))
        consumed.update(identifier for identifier in (a_id, b_id) if identifier)

    for sides in groups.values():
        if len(sides[0]) != 1 or len(sides[1]) != 1:
            continue
        a, b = sides[0][0], sides[1][0]
        if blocked[a["record_id"]] or blocked[b["record_id"]]:
            for product in (a, b):
                blocked[product["record_id"]].append(
                    issue(
                        "invalid_counterpart", "supplier_sku", "Exact-SKU counterpart needs review"
                    )
                )
            continue
        issues, flags = [], []
        for field in ("manufacturer", "manufacturer_part_number", "gtin"):
            if a[field] is not None and b[field] is not None and a[field] != b[field]:
                issues.append(
                    issue(
                        "conflicting_identifier",
                        field,
                        "Exact SKU has conflicting corroborating identifiers",
                    )
                )
        for field in (
            "description",
            "pack_quantity",
            "unit",
            "retail_price",
            "rrp",
            "availability",
        ):
            equal = a[field] == b[field]
            if field in DECIMALS and a[field] is not None and b[field] is not None:
                equal = Decimal(a[field]) == Decimal(b[field])
            if not equal:
                flags.append(field)
        for field in ("currency", "pack_quantity", "unit", "price_basis", "tax_basis"):
            equal = a[field] == b[field]
            if field == "pack_quantity" and a[field] is not None and b[field] is not None:
                equal = Decimal(a[field]) == Decimal(b[field])
            if a[field] is None or b[field] is None or not equal:
                issues.append(
                    issue(
                        "incompatible_basis", field, "Comparison basis is missing or incompatible"
                    )
                )
        if issues:
            emit(a, b, "needs_review", flags, issues)
            continue
        x, y = Decimal(a["cost_price"]), Decimal(b["cost_price"])
        with localcontext(Context(prec=300, rounding=ROUND_HALF_EVEN)):
            difference = y - x
            delta = format(difference, "f")
            percent = (
                None
                if x == 0
                else format(
                    (difference / x * 100).quantize(Decimal("0.000001"), rounding=ROUND_HALF_EVEN),
                    "f",
                )
            )
        if difference != 0:
            flags.insert(0, "price_increase" if difference > 0 else "price_decrease")
        calc_issues = (
            [issue("zero_old_cost", "cost_price", "Percentage is undefined for zero old cost")]
            if x == 0
            else []
        )
        emit(a, b, "changed" if flags else "unchanged", flags, calc_issues, delta, percent)
    for side, catalogue in enumerate((old, new)):
        for product in catalogue.products:
            if product["record_id"] in consumed:
                continue
            issues = blocked[product["record_id"]]
            emit(
                product if side == 0 else None,
                product if side == 1 else None,
                "needs_review" if issues else "absent" if side == 0 else "new",
                [],
                issues,
            )
    return tuple(results)


def safe_text(value: str | None) -> str:
    """Escape formula-like text after leading whitespace/control characters.

    CSV quoting alone is not a spreadsheet security boundary. An apostrophe is
    intentionally added to dangerous text; numeric columns retain decimal text.
    """
    text = value or ""
    start = 0
    while start < len(text) and (
        text[start].isspace() or ord(text[start]) < 33 or text[start] == "\ufeff"
    ):
        start += 1
    probe = text[start:]
    return "'" + text if probe.startswith(("=", "+", "-", "@")) else text


def export_changed(old: Catalogue, new: Catalogue, outcomes: tuple[dict[str, Any], ...]) -> bytes:
    """Export deterministic approved changes only, with no implicit human approval."""
    eligible = {r["result_id"]: r for r in reconcile(old, new) if r["outcome"] == "changed"}
    exported = set()
    records = {p["record_id"]: p for p in old.products + new.products}
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow(
        (
            "supplier_sku",
            "description",
            "old_cost_price",
            "cost_price",
            "currency",
            "cost_delta",
            "cost_change_percent",
            "change_flags",
        )
    )
    for result in outcomes:
        validate_contract("comparison-outcome", result)
        if result["outcome"] != "changed" or result["review_state"] not in (
            "not_required",
            "approved",
        ):
            continue
        # A caller relabeling a review row cannot create an approved update.
        expected = eligible.get(result["result_id"])
        if expected is None or result["result_id"] in exported:
            continue
        for field in (
            "old_record_id",
            "new_record_id",
            "change_flags",
            "cost_delta",
            "cost_change_percent",
            "calculation_issues",
        ):
            if result[field] != expected[field]:
                raise ValueError("Export outcome differs from deterministic reconciliation")
        a, b = records[result["old_record_id"]], records[result["new_record_id"]]
        if a["validation_issues"] or b["validation_issues"]:
            continue
        writer.writerow(
            (
                safe_text(b["supplier_sku"]),
                safe_text(b["description"]),
                a["cost_price"],
                b["cost_price"],
                safe_text(b["currency"]),
                result["cost_delta"],
                result["cost_change_percent"],
                "|".join(result["change_flags"]),
            )
        )
        exported.add(result["result_id"])
    return stream.getvalue().encode("utf-8")
