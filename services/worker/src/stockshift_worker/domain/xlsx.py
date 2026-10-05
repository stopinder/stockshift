"""Bounded OOXML ingestion. Numeric XML tokens never pass through binary floats."""

import io
import posixpath
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from zipfile import ZipFile

from defusedxml.ElementTree import fromstring

from stockshift_worker.domain.csv_engine import CsvOptions, normalize_rows

MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


class WorkbookError(ValueError):
    """Safe, actionable input errors, suitable for browser/structured job failures."""


@dataclass(frozen=True)
class Cell:
    raw: str
    kind: str
    style: int
    formula: bool


class Workbook:
    def __init__(self, data: bytes):
        if data.startswith(bytes.fromhex("d0cf11e0a1b11ae1")):
            raise WorkbookError(
                "Password-protected or legacy workbook. Save an unencrypted .xlsx copy."
            )
        if not 1 <= len(data) <= 10485760:
            raise WorkbookError("Workbook must be between 1 byte and 10 MiB.")
        try:
            with ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                if len(entries) > 1000 or sum(e.file_size for e in entries) > 40 * 1024 * 1024:
                    raise WorkbookError(
                        "Workbook is too large when expanded. Split it into smaller files."
                    )
                names = [e.filename for e in entries]
                if len(set(names)) != len(names) or any(
                    e.flag_bits & 1
                    or e.compress_type not in (0, 8)
                    or e.filename.startswith("/")
                    or ".." in e.filename.split("/")
                    or "\\" in e.filename
                    for e in entries
                ):
                    raise WorkbookError(
                        "Encrypted or ambiguous workbook archive. Save a plain .xlsx copy."
                    )
                self.parts = {e.filename: archive.read(e) for e in entries}
            if any(
                "vbaproject" in name.lower() or name.startswith("xl/externalLinks/")
                for name in self.parts
            ):
                raise WorkbookError(
                    "Macros or external links are unsupported. Save a values-only .xlsx copy."
                )
            content = self.xml("[Content_Types].xml")
            if not any(
                e.get("PartName") == "/xl/workbook.xml"
                and e.get("ContentType")
                == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
                for e in content
            ):
                raise WorkbookError("Use an ordinary .xlsx workbook, without macros or templates.")
            relationships = self.xml("xl/_rels/workbook.xml.rels")
            targets = {}
            for relation in relationships:
                if not relation.get("Id") or relation.get("Id") in targets:
                    raise WorkbookError(
                        "Ambiguous workbook relationships. Save a fresh .xlsx copy."
                    )
                if relation.get("TargetMode") == "External":
                    raise WorkbookError(
                        "External workbook links are unsupported. Save a values-only copy."
                    )
                target = relation.get("Target", "")
                path = posixpath.normpath(
                    target.lstrip("/") if target.startswith("/") else "xl/" + target
                )
                if not path.startswith("xl/"):
                    raise WorkbookError(
                        "Unsupported workbook relationship. Save a plain .xlsx copy."
                    )
                targets[relation.get("Id")] = (path, relation.get("Type", ""))
            self.sheets = []
            for sheet in self.xml("xl/workbook.xml").findall(f"{NS}sheets/{NS}sheet"):
                name = sheet.get("name", "")
                path, kind = targets.get(sheet.get(f"{REL}id"), ("", ""))
                if (
                    not name
                    or any(s["name"] == name or s["path"] == path for s in self.sheets)
                    or not kind.endswith("/worksheet")
                ):
                    raise WorkbookError(
                        "Unsupported or ambiguous worksheet. Save ordinary data worksheets."
                    )
                self.sheets.append(
                    {"name": name, "state": sheet.get("state", "visible"), "path": path}
                )
            if not self.sheets:
                raise WorkbookError("Workbook has no worksheets. Add a visible data worksheet.")
            if len(self.sheets) > 50:
                raise WorkbookError("Workbook has too many worksheets. Keep at most 50.")
            if not any(s["state"] == "visible" for s in self.sheets):
                raise WorkbookError("Workbook has no visible worksheets. Unhide a data worksheet.")
            self.strings = []
            if "xl/sharedStrings.xml" in self.parts:
                self.strings = [
                    self.text(si) for si in self.xml("xl/sharedStrings.xml").findall(f"{NS}si")
                ]
            self.formats = ["General"]
            self.date_styles = set()
            if "xl/styles.xml" in self.parts:
                styles = self.xml("xl/styles.xml")
                custom = {
                    int(e.get("numFmtId")): e.get("formatCode", "")
                    for e in styles.findall(f"{NS}numFmts/{NS}numFmt")
                }
                self.formats = []
                for index, xf in enumerate(styles.findall(f"{NS}cellXfs/{NS}xf")):
                    number = int(xf.get("numFmtId", "0"))
                    fmt = custom.get(
                        number, "General" if number == 0 else "0" if number == 1 else "unsupported"
                    )
                    self.formats.append(fmt)
                    if number in {
                        *range(14, 23),
                        *range(27, 37),
                        *range(45, 48),
                        *range(50, 59),
                    } or (
                        number in custom
                        and re.search(r"[ymdhis]", re.sub(r'"[^"]*"|\\.|\[[^\]]*\]', "", fmt), re.I)
                    ):
                        self.date_styles.add(index)
            if not self.formats:
                self.formats = ["General"]
        except WorkbookError:
            raise
        except Exception as exc:
            raise WorkbookError(
                "Corrupt or unsupported workbook. Open it in Excel and save a fresh .xlsx copy."
            ) from exc

    def xml(self, name):
        return fromstring(self.parts[name])

    @staticmethod
    def text(element):
        return "".join(
            t.text or "" for t in element.findall(f"{NS}t") + element.findall(f"{NS}r/{NS}t")
        )

    def rows(self, worksheet):
        sheet = next((s for s in self.sheets if s["name"] == worksheet), None)
        if sheet is None:
            raise WorkbookError(
                "Selected worksheet is missing. Choose a worksheet from this workbook."
            )
        if sheet["state"] != "visible":
            raise WorkbookError("Selected worksheet is hidden. Unhide it and upload a new copy.")
        try:
            root = self.xml(sheet["path"])
            if root.find(f"{NS}mergeCells") is not None:
                raise WorkbookError(
                    "Merged cells unsupported. Unmerge this worksheet and repeat header labels."
                )
            output, count = {}, 0
            for row in root.findall(f"{NS}sheetData/{NS}row"):
                r = int(row.get("r", "0"))
                if not 1 <= r <= 20200 or r in output:
                    raise WorkbookError(
                        "Worksheet row layout is unsupported or exceeds 20,200 rows."
                    )
                cells = {}
                for cell in row.findall(f"{NS}c"):
                    match = re.fullmatch(r"([A-Z]{1,3})([1-9][0-9]*)", cell.get("r", ""))
                    if not match or int(match[2]) != r:
                        raise WorkbookError(
                            "Worksheet cell coordinates are invalid. Save a fresh workbook."
                        )
                    index = 0
                    for letter in match[1]:
                        index = index * 26 + ord(letter) - 64
                    if index > 256 or index in cells:
                        raise WorkbookError("Worksheet exceeds 256 columns or has duplicate cells.")
                    kind, style = cell.get("t", "n"), int(cell.get("s", "0"))
                    value = cell.findtext(f"{NS}v", "")
                    if kind == "s":
                        if not re.fullmatch(r"[0-9]+", value) or int(value) >= len(self.strings):
                            raise WorkbookError(
                                "Invalid shared text reference. Save a fresh workbook."
                            )
                        value = self.strings[int(value)]
                    elif kind == "inlineStr":
                        value = self.text(cell.find(f"{NS}is"))
                    if len(value) > 10000 or style >= len(self.formats) or style < 0:
                        raise WorkbookError(
                            "Unsupported cell value/style. Shorten text or save a fresh workbook."
                        )
                    cells[index] = Cell(value, kind, style, cell.find(f"{NS}f") is not None)
                    count += 1
                    if count > 200000:
                        raise WorkbookError(
                            "Worksheet has too many cells. Split it into smaller files."
                        )
                output[r] = cells
            if not any(c.raw or c.formula for cells in output.values() for c in cells.values()):
                raise WorkbookError("Selected worksheet is empty. Choose a populated worksheet.")
            return output
        except WorkbookError:
            raise
        except Exception as exc:
            raise WorkbookError("Worksheet data is corrupt. Save a fresh .xlsx copy.") from exc

    def headers(self, rows, header_row):
        if type(header_row) is not int or not 1 <= header_row <= 200:
            raise WorkbookError("Header row must be a whole number from 1 to 200.")
        cells = rows.get(header_row, {})
        if not cells:
            raise WorkbookError("Header row is empty. Select the row containing column labels.")
        headers = []
        for column in range(1, max(cells) + 1):
            cell = cells.get(column)
            if (
                cell is None
                or cell.formula
                or cell.kind not in ("s", "inlineStr", "str")
                or not cell.raw.strip()
            ):
                raise WorkbookError("Headers must be plain, nonblank text in consecutive columns.")
            headers.append(cell.raw)
        if len(set(headers)) != len(headers):
            raise WorkbookError("Duplicate header names. Give each column a unique label.")
        return headers

    def value(self, cell, field, row):
        if cell is None:
            return ""
        if cell.formula:
            raise WorkbookError(
                f"Row {row}: formula in mapped column. Replace formulas with saved values."
            )
        if not cell.raw:
            return ""
        if cell.kind == "d" or cell.style in self.date_styles:
            raise WorkbookError(
                f"Row {row}: date/time in mapped column. Use text identifiers or decimal prices."
            )
        if cell.kind not in ("n", "s", "inlineStr", "str"):
            raise WorkbookError(
                f"Row {row}: error or boolean in mapped column. Correct the cell before uploading."
            )
        if (
            cell.kind == "n"
            and cell.raw
            and field in ("supplier_sku", "gtin", "manufacturer_part_number")
        ):
            if not re.fullmatch(r"[0-9]{1,15}", cell.raw):
                raise WorkbookError(
                    f"Row {row}: ambiguous numeric identifier. Store it as text in Excel."
                )
            fmt = self.formats[cell.style]
            if re.fullmatch(r"0{1,30}", fmt):
                return cell.raw.zfill(len(fmt))
            if fmt != "General":
                raise WorkbookError(
                    f"Row {row}: unsupported identifier format. Store it as text in Excel."
                )
        return cell.raw


def inspect_workbook(data, worksheet=None, header_row=1):
    workbook = Workbook(data)
    output = {"worksheets": [{"name": s["name"], "state": s["state"]} for s in workbook.sheets]}
    if worksheet is not None:
        rows = workbook.rows(worksheet)
        headers = workbook.headers(rows, header_row)
        output.update(
            headers=headers,
            samples=[
                [
                    "[formula — replace with values]"
                    if cells.get(i) and cells[i].formula
                    else "[date/time]"
                    if cells.get(i)
                    and (cells[i].kind == "d" or cells[i].style in workbook.date_styles)
                    else cells[i].raw[:200]
                    if i in cells
                    else ""
                    for i in range(1, len(headers) + 1)
                ]
                for _, cells in sorted(rows.items())
                if _ > header_row
            ][:5],
        )
    return output


def parse_xlsx(data, *, source_file_id, source_name, options):
    settings = dict(options)
    if settings.pop("format", None) != "xlsx":
        raise WorkbookError("Choose XLSX import settings for this workbook.")
    worksheet, header_row = settings.pop("worksheet", None), settings.pop("header_row", None)
    if not isinstance(worksheet, str) or not worksheet:
        raise WorkbookError("Select a worksheet explicitly.")
    syntax = CsvOptions(**settings)
    workbook = Workbook(data)
    rows = workbook.rows(worksheet)
    headers = workbook.headers(rows, header_row)
    if not set(syntax.columns.values()) <= set(headers):
        raise WorkbookError(
            "Mapped column is absent. Check the worksheet, header row and column mapping."
        )
    mapped = {headers.index(header) + 1: field for field, header in syntax.columns.items()}
    raw_values = {}
    normalized = []
    for row, cells in sorted(rows.items()):
        if row <= header_row or not any(c.raw or c.formula for c in cells.values()):
            continue
        if max(cells, default=0) > len(headers):
            raise WorkbookError(
                f"Row {row}: data extends beyond the headers. Label every data column."
            )
        values = [""] * len(headers)
        for column, field in mapped.items():
            cell = cells.get(column)
            raw = workbook.value(cell, field, row)
            raw_values[(row, headers[column - 1])] = cell.raw if cell else ""
            if (
                cell
                and cell.kind == "n"
                and raw
                and field in ("cost_price", "retail_price", "rrp", "pack_quantity")
            ):
                try:
                    decimal = Decimal(raw)
                    if not decimal.is_finite() or len(raw) > 128 or abs(decimal.adjusted()) > 100:
                        raise InvalidOperation
                    raw = format(decimal, "f").replace(".", syntax.decimal_separator)
                except InvalidOperation as exc:
                    raise WorkbookError(
                        f"Row {row}: invalid numeric price. Correct the cell in Excel."
                    ) from exc
            values[column - 1] = raw
        normalized.append((row, values))
    catalogue = normalize_rows(
        source_file_id, source_name, syntax, headers, normalized, sheet=worksheet
    )
    for evidence in catalogue.evidence:
        evidence["raw_text"] = raw_values[
            (evidence["locator"]["row"], evidence["locator"]["column"])
        ]
    return catalogue
