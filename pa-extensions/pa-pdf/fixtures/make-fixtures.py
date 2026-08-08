#!/usr/bin/env python3
"""
Regenerate pa-pdf's selftest fixtures.

This is a HOST/dev tool, deliberately not run by the selftest or the image
build: it needs matplotlib, which the sandbox image does not ship. The two
PDFs it produces are committed (7KB each) and the selftest reads them directly.

    python3 make-fixtures.py

WHY COMMITTED FIXTURES RATHER THAN GENERATING THEM IN THE TEST
    The selftest originally built PDFs byte-by-byte to avoid committing
    binaries. Every pdf.js version bundled in pdf-parse (v1.9.426 .. v2.0.550)
    rejected them with "bad XRef entry", despite spec-correct 20-byte xref
    entries whose offsets were verified to land exactly on their object
    headers. That is PDF-format archaeology with no bearing on this extension,
    so we generate with a real producer instead. A real producer also exercises
    realistic structure -- font subsets, compressed content streams, an xref
    pdf.js actually likes -- which a minimal hand-rolled file would not.

WHAT THEY CONTAIN (the selftest asserts on exactly this)
    three-page.pdf  3 pages, one marker per page:
                    ALPHA_MARKER_ONE / BRAVO_MARKER_TWO / CHARLIE_MARKER_THREE
    scanned.pdf     3 pages: page 1 has real text, pages 2-3
                    are raster images with NO text layer, which is the
                    scanned-document case pdf_map must detect and report.

Keep them small: they are baked into the image with the rest of pa-extensions.
"""

import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.backends.backend_pdf import PdfPages  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def text_page(pdf, s):
    fig = plt.figure(figsize=(3, 2))
    fig.text(0.05, 0.5, s, fontsize=9)
    pdf.savefig(fig)
    plt.close(fig)


def image_page(pdf):
    """A page with raster content only -- no text layer, like a scan."""
    fig = plt.figure(figsize=(3, 2))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.axis("off")
    ax.imshow(np.tile(np.linspace(0, 1, 40), (30, 1)), cmap="gray")
    pdf.savefig(fig, dpi=50)
    plt.close(fig)


def main():
    with PdfPages(os.path.join(HERE, "three-page.pdf")) as pdf:
        for marker in ("ALPHA_MARKER_ONE", "BRAVO_MARKER_TWO", "CHARLIE_MARKER_THREE"):
            text_page(pdf, marker)

    with PdfPages(os.path.join(HERE, "scanned.pdf")) as pdf:
        text_page(pdf, "REAL_TEXT_PAGE with a genuine text layer on it")
        image_page(pdf)
        image_page(pdf)

    for name in ("three-page.pdf", "scanned.pdf"):
        path = os.path.join(HERE, name)
        print(f"{name}: {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
