"""Representative synthetic supplier tables rasterized into scanned/mixed PDFs."""

import base64
import io
import sys

import pypdfium2
from pdf_fixture import pdf_bytes
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas


def scanned_pdf(*, mixed=False, incoming=False):
    source = pdf_bytes(incoming=incoming)
    out = io.BytesIO()
    canvas = Canvas(out, pagesize=(720, 540), invariant=1)
    with pypdfium2.PdfDocument(source) as doc:
        for i in range(len(doc)):
            page = doc[i]
            bitmap = page.render(scale=2)
            image = bitmap.to_pil()
            canvas.drawImage(ImageReader(image), 0, 0, 720, 540)
            canvas.showPage()
            image.close()
            bitmap.close()
            page.close()
    canvas.save()
    if not mixed:
        return out.getvalue()
    with (
        pypdfium2.PdfDocument(source) as digital,
        pypdfium2.PdfDocument(out.getvalue()) as scan,
        pypdfium2.PdfDocument.new() as joined,
    ):
        joined.import_pages(digital, [0])
        joined.import_pages(scan, [1])
        result = io.BytesIO()
        joined.save(result)
        return result.getvalue()


if __name__ == "__main__":
    print(
        base64.b64encode(
            scanned_pdf(mixed="mixed" in sys.argv, incoming="incoming" in sys.argv)
        ).decode()
    )
