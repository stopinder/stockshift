"""Synthetic digital/scanned/encrypted PDFs; never customer files."""

import base64
import io
import sys

from PIL import Image
from reportlab.lib.pdfencrypt import StandardEncryption
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

HEADERS = ["SKU", "Price", "Description", "Currency", "Pack", "UOM"]


def pdf_bytes(*, incoming=False, image_only=False, encrypted=False, pages=None, merged=False):
    output = io.BytesIO()
    canvas = Canvas(
        output,
        pagesize=(720, 540),
        invariant=1,
        encrypt=StandardEncryption("secret") if encrypted else None,
    )
    default = [
        [
            HEADERS,
            [
                "00123",
                "1.2O" if incoming else "1.001000000000000000",
                "Precision component",
                "GBP",
                "1",
                "each",
            ],
            ["REVIEW", "", "Missing price", "GBP", "1", "each"],
        ],
        [HEADERS, ["00042", "5.25", "Second page component", "GBP", "1", "each"]],
    ]
    for rows in pages if pages is not None else default:
        if image_only:
            canvas.drawImage(ImageReader(Image.new("RGB", (60, 40), "gray")), 30, 100, 600, 350)
        else:
            canvas.setFont("Helvetica", 9)
            canvas.drawString(30, 495, "Supplier catalogue — embedded text")
            x = [30, 105, 295, 475, 545, 605, 665]
            top, height = 460, 28
            for i in range(len(rows) + 1):
                canvas.line(x[0], top - i * height, x[-1], top - i * height)
            for col, pos in enumerate(x):
                if merged and col == 2:
                    canvas.line(pos, top - height, pos, top - len(rows) * height)
                else:
                    canvas.line(pos, top, pos, top - len(rows) * height)
            for row_index, row in enumerate(rows):
                for col, value in enumerate(row):
                    if value is not None:
                        for line_index, line in enumerate(str(value).split("\n")):
                            canvas.drawString(
                                x[col] + 4, top - row_index * height - 18 - line_index * 8, line
                            )
        canvas.showPage()
    canvas.save()
    return output.getvalue()


if __name__ == "__main__":
    print(
        base64.b64encode(
            pdf_bytes(
                incoming="incoming" in sys.argv,
                image_only="image" in sys.argv,
                encrypted="encrypted" in sys.argv,
            )
        ).decode()
    )
