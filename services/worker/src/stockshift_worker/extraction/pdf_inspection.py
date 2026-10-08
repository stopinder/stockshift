"""CPU-only structural probe; success never authorizes extraction or comparison."""

import json

from stockshift_worker.extraction.digital_pdf import PdfError, open_pdf

MAX_PAGES = 50
MAX_OBJECTS = 20000


def inspect_document(data):
    diagnostics = []
    with open_pdf(data) as pdf:
        if len(pdf.pages) > MAX_PAGES:
            raise PdfError("PDF inspection supports at most 50 document pages. Split the PDF.")
        for number, page in enumerate(pdf.pages, 1):
            # Bound work before text/table construction, in addition to the child deadline.
            if sum(len(items) for items in page.objects.values()) > MAX_OBJECTS:
                raise PdfError("PDF page exceeds inspection complexity limits. Simplify the PDF.")
            text = page.extract_text() or ""
            tables = page.find_tables() if text.strip() else []
            usable = 0
            unsupported = False
            if len(tables) > 32 or len(text) > 100000:
                raise PdfError("PDF page exceeds inspection complexity limits. Simplify the PDF.")
            for table in tables:
                if len(table.rows) > 2000 or len(table.cells) > 64000:
                    raise PdfError("PDF table exceeds inspection limits. Split the PDF.")
                rows = table.extract()
                if len(rows) < 2 or max(map(len, rows), default=0) < 2:
                    continue
                if max(map(len, rows)) > 32:
                    raise PdfError("PDF table exceeds 32 columns. Simplify the PDF.")
                if any(
                    len(row) != len(rows[0]) or any(box is None for box in geometry.cells)
                    for row, geometry in zip(rows, table.rows, strict=True)
                ):
                    unsupported = True
                else:
                    usable += 1
            eligible = bool(usable) and not unsupported
            diagnostics.append(
                {
                    "page": number,
                    "state": "digital_candidate" if eligible else "ocr_required",
                    "code": "ruled_table_candidate"
                    if eligible
                    else "unsupported_table_structure"
                    if unsupported
                    else "no_usable_embedded_table",
                    "table_count": usable,
                }
            )
            page.close()
    result = {
        "version": "cpu-inspection-v1",
        "page_count": len(diagnostics),
        "state": "ocr_required"
        if any(page["state"] == "ocr_required" for page in diagnostics)
        else "inspected",
        "diagnostics": diagnostics,
    }
    if len(json.dumps(result).encode()) > 32768:
        raise PdfError("PDF diagnostics exceed inspection limits.")
    return result
