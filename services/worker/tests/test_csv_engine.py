"""Trust invariants for direct CSV ingestion, reconciliation and export."""

import csv
import io
from collections import Counter
from dataclasses import replace
from decimal import Inexact, localcontext
from pathlib import Path

import pytest

from stockshift_worker.domain.csv_engine import (
    CsvOptions,
    export_changed,
    parse_csv,
    reconcile,
)

OLD_ID = "11111111-1111-4111-8111-111111111111"
NEW_ID = "22222222-2222-4222-8222-222222222222"
OPTIONS = CsvOptions(
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


def catalogue(rows, *, incoming=False, options=OPTIONS, extra_headers=()):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, delimiter=options.delimiter)
    writer.writerow(("SKU", "Price", "Description", *extra_headers))
    writer.writerows(rows)
    return parse_csv(
        stream.getvalue().encode(options.encoding),
        source_file_id=NEW_ID if incoming else OLD_ID,
        source_name="new.csv" if incoming else "old.csv",
        options=options,
    )


def pair(old_rows, new_rows, *, old_options=OPTIONS, new_options=OPTIONS, extra_headers=()):
    old = catalogue(old_rows, options=old_options, extra_headers=extra_headers)
    new = catalogue(new_rows, incoming=True, options=new_options, extra_headers=extra_headers)
    return old, new, reconcile(old, new)


@pytest.mark.parametrize(
    ("before", "after", "category", "flags", "delta", "percent"),
    [
        ("6.4000", "6.40", "unchanged", [], "0.0000", "0.000000"),
        ("6.40", "7.10", "changed", ["price_increase"], "0.70", "10.937500"),
        ("10", "9", "changed", ["price_decrease"], "-1", "-10.000000"),
        ("0", "1.25", "changed", ["price_increase"], "1.25", None),
        ("0", "0", "unchanged", [], "0", None),
    ],
)
def test_exact_prices(before, after, category, flags, delta, percent):
    old, new, results = pair([["001821", before, "Breaker"]], [["001821", after, "Breaker"]])
    assert len(results) == 1
    result = results[0]
    assert (result["outcome"], result["change_flags"]) == (category, flags)
    assert (result["cost_delta"], result["cost_change_percent"]) == (delta, percent)
    assert result["old_record_id"] == old.products[0]["record_id"]
    assert result["new_record_id"] == new.products[0]["record_id"]
    assert old.products[0]["supplier_sku"] == "001821"
    assert old.products[0]["cost_price"] == before
    assert "matching_score" not in result


def test_new_absent_and_description_change():
    _, _, results = pair(
        [["1", "5", "Old"], ["2", "4", "Absent"]], [["1", "5", "Renamed"], ["3", "7", "New"]]
    )
    assert Counter(r["outcome"] for r in results) == {"changed": 1, "new": 1, "absent": 1}
    assert results[0]["change_flags"] == ["description"]


@pytest.mark.parametrize("bad", ["", "garbage", "NaN", "Infinity", "1e3", "-1", "1,234"])
def test_invalid_price_never_matches_or_exports(bad):
    old, new, results = pair([["1", "2", "Good"]], [["1", bad, "Bad"]])
    assert [r["outcome"] for r in results] == ["needs_review", "needs_review"]
    assert all(r["cost_delta"] is None and r["review_state"] == "pending" for r in results)
    assert new.products[0]["cost_price"] is None
    assert len(list(csv.reader(io.StringIO(export_changed(old, new, results).decode())))) == 1


@pytest.mark.parametrize("sku", ["", " ", " 001", "001 "])
def test_missing_or_whitespace_sku_requires_review(sku):
    _, _, results = pair([], [[sku, "2", "Product"]])
    assert results[0]["outcome"] == "needs_review"


@pytest.mark.parametrize("duplicate_side", ["old", "new"])
def test_duplicate_groups_are_not_overwritten_or_reused(duplicate_side):
    rows = [["1", "2", "A"], ["1", "3", "B"]]
    old_rows, new_rows = (rows, rows[:1]) if duplicate_side == "old" else (rows[:1], rows)
    old, new, results = pair(old_rows, new_rows)
    assert len(results) == 3
    assert all(r["outcome"] == "needs_review" for r in results)
    linked = [
        r[f"{side}_record_id"] for r in results for side in ("old", "new") if r[f"{side}_record_id"]
    ]
    assert len(linked) == len(set(linked)) == len(old.products) + len(new.products)


def test_normalization_collision_does_not_create_a_match():
    _, _, results = pair([["ABC", "2", "A"]], [["abc", "3", "A"]])
    assert len(results) == 2
    assert all(r["outcome"] == "needs_review" for r in results)


@pytest.mark.parametrize(
    ("field", "header", "old_value", "new_value"),
    [
        ("gtin", "GTIN", "001", "002"),
        ("manufacturer_part_number", "MPN", "00017", "00018"),
        ("manufacturer", "Maker", "A", "B"),
    ],
)
def test_conflicting_identifier_vetoes_exact_match(field, header, old_value, new_value):
    opts = replace(OPTIONS, columns={**OPTIONS.columns, field: header})
    _, _, results = pair(
        [["1", "2", "A", old_value]],
        [["1", "3", "A", new_value]],
        old_options=opts,
        new_options=opts,
        extra_headers=(header,),
    )
    assert results[0]["outcome"] == "needs_review"
    assert results[0]["cost_delta"] is None
    assert results[0]["calculation_issues"][0]["code"] == "conflicting_identifier"


@pytest.mark.parametrize("kind", ["gtin", "manufacturer_part_number"])
def test_shared_identifier_across_different_skus_is_reviewed(kind):
    opts = replace(OPTIONS, columns={**OPTIONS.columns, kind: "Code", "manufacturer": "Maker"})
    _, _, results = pair(
        [["old", "2", "A", "001", "Maker"]],
        [["new", "3", "A", "001", "Maker"]],
        old_options=opts,
        new_options=opts,
        extra_headers=("Code", "Maker"),
    )
    assert all(r["outcome"] == "needs_review" for r in results)


@pytest.mark.parametrize(
    ("field", "value", "flag"),
    [
        ("currency", "EUR", None),
        ("pack_quantity", "2", "pack_quantity"),
        ("unit", "box", "unit"),
        ("price_basis", "pack", None),
        ("tax_basis", "gross", None),
        ("currency", None, None),
        ("pack_quantity", None, "pack_quantity"),
        ("unit", None, "unit"),
        ("price_basis", None, None),
        ("tax_basis", None, None),
    ],
)
def test_incompatible_or_missing_basis_suppresses_arithmetic(field, value, flag):
    _, _, results = pair(
        [["1", "2", "A"]], [["1", "3", "A"]], new_options=replace(OPTIONS, **{field: value})
    )
    result = results[0]
    assert result["outcome"] == "needs_review"
    assert result["cost_delta"] is None and result["cost_change_percent"] is None
    assert "price_increase" not in result["change_flags"]
    if flag:
        assert flag in result["change_flags"]


def test_explicit_decimal_comma_grouping_symbol_and_encoding():
    opts = replace(
        OPTIONS,
        encoding="cp1252",
        delimiter=";",
        decimal_separator=",",
        thousands_separator=".",
        currency_symbol="£",
    )
    result = catalogue([["00001", "£1.234,5000", "Café"]], options=opts)
    assert result.products[0]["cost_price"] == "1234.5000"
    assert result.products[0]["description"] == "Café"
    assert result.evidence[1]["raw_text"] == "£1.234,5000"


def test_provenance_including_multiline_and_blank_cells():
    imported = catalogue([["001", "2", "Line one\nLine two"], ["002", "", "Other"]])
    assert imported.source_name == "old.csv"
    assert imported.evidence[0]["source_file_id"] == OLD_ID
    assert imported.evidence[0]["locator"]["row"] == 2
    assert imported.evidence[0]["locator"]["column"] == "SKU"
    assert imported.evidence[3]["locator"]["row"] == 4
    assert imported.evidence[4]["raw_text"] == ""
    assert imported.products[1]["cost_price"] is None
    assert all("extraction_score" not in e for e in imported.evidence)
    assert set(imported.products[0]["evidence_ids"]) == {
        e["evidence_id"] for e in imported.evidence[:3]
    }


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"SKU,SKU,Description\n",
        b"SKU,Wrong,Description\n",
        b"SKU,Price,Description\n1,2\n",
        b'SKU,Price,Description\n1,2,"unterminated',
        b"SKU,Price,Description\n1,2,\xff\n",
    ],
)
def test_bad_file_fails_closed(data):
    with pytest.raises((ValueError, csv.Error, UnicodeError)):
        parse_csv(data, source_file_id=OLD_ID, source_name="bad.csv", options=OPTIONS)


@pytest.mark.parametrize(
    "settings",
    [
        {"delimiter": "::"},
        {"decimal_separator": ":"},
        {"thousands_separator": "."},
        {"encoding": "unknown-codec"},
        {"columns": {"supplier_sku": "SKU"}},
        {"columns": {"supplier_sku": "SKU", "cost_price": "SKU"}},
        {"currency": "gbp"},
        {"pack_quantity": "0"},
        {"price_basis": "unknown"},
    ],
)
def test_invalid_config_fails_early(settings):
    with pytest.raises((ValueError, LookupError)):
        replace(OPTIONS, **settings)


def test_same_source_ids_rejected():
    imported = catalogue([["1", "2", "A"]])
    with pytest.raises(ValueError, match="distinct"):
        reconcile(imported, imported)


def test_exact_arithmetic_ignores_ambient_decimal_context():
    with localcontext() as context:
        context.prec = 2
        _, _, results = pair(
            [["1", "123456789012345678901234567890.000001", "A"]],
            [["1", "123456789012345678901234567890.000002", "A"]],
        )
    assert results[0]["cost_delta"] == "0.000001"


def test_percent_rounding_policy_and_ambient_traps():
    with localcontext() as context:
        context.traps[Inexact] = True
        _, _, results = pair([["1", "3", "A"]], [["1", "4", "A"]])
    assert results[0]["cost_change_percent"] == "33.333333"


@pytest.mark.parametrize(
    "text",
    ["=SUM(1,2)", "+cmd", "-cmd", "@SUM(A1)", " \t=1+1", "\r=1+1", "\ufeff=1+1", "\u00a0=1+1"],
)
def test_export_precision_and_formula_safety(text):
    # Surrounding whitespace on an SKU independently requires review. Exercise
    # whitespace-prefixed formulas in descriptions using a valid exact SKU.
    sku = text if text == text.strip() else "001"
    old, new, results = pair([[sku, "1.00000000", text]], [[sku, "0.99999999", text]])
    exported = list(csv.DictReader(io.StringIO(export_changed(old, new, results).decode())))
    assert len(exported) == 1
    row = exported[0]
    assert row["supplier_sku"] == ("001" if sku == "001" else "'" + text)
    assert row["description"] == "'" + text
    assert row["cost_price"] == "0.99999999"
    assert row["cost_delta"] == "-0.00000001"


def test_pending_rejected_and_review_results_never_export():
    old, new, results = pair([["1", "1", "A"]], [["1", "2", "A"]])
    for state in ("pending", "rejected"):
        payload = ({**results[0], "review_state": state},)
        assert len(export_changed(old, new, payload).decode().splitlines()) == 1


def test_relabeling_review_as_approved_does_not_export():
    old, new, results = pair(
        [["1", "1", "A"]], [["1", "2", "A"]], new_options=replace(OPTIONS, unit="box")
    )
    forged = ({**results[0], "outcome": "changed", "review_state": "approved"},)
    assert len(export_changed(old, new, forged).decode().splitlines()) == 1


def test_export_rejects_altered_calculations_and_deduplicates_rows():
    old, new, results = pair([["1", "1", "A"]], [["1", "2", "A"]])
    with pytest.raises(ValueError, match="differs"):
        export_changed(old, new, ({**results[0], "cost_delta": "999"},))
    assert len(export_changed(old, new, results + results).decode().splitlines()) == 2


def test_golden_100_outcomes_and_deterministic_ids():
    root = Path(__file__).resolve().parents[3] / "tests/fixtures/csv"
    old = parse_csv(
        (root / "old_catalogue.csv").read_bytes(),
        source_file_id=OLD_ID,
        source_name="old_catalogue.csv",
        options=OPTIONS,
    )
    new = parse_csv(
        (root / "new_supplier_catalogue.csv").read_bytes(),
        source_file_id=NEW_ID,
        source_name="new_supplier_catalogue.csv",
        options=OPTIONS,
    )
    results = reconcile(old, new)
    assert results == reconcile(old, new)
    assert len(results) == 100
    assert Counter(r["outcome"] for r in results) == {
        "unchanged": 50,
        "changed": 30,
        "new": 10,
        "absent": 8,
        "needs_review": 2,
    }
    assert Counter(flag for r in results for flag in r["change_flags"]) == {
        "price_increase": 15,
        "price_decrease": 10,
        "description": 5,
    }
    assert len(list(csv.DictReader(io.StringIO(export_changed(old, new, results).decode())))) == 30
    ids = [
        r[f"{side}_record_id"] for r in results for side in ("old", "new") if r[f"{side}_record_id"]
    ]
    assert len(ids) == len(set(ids)) == len(old.products) + len(new.products)
