# Reading PDFs: `pa-pdf`

Three tools: **`pdf_map`** reports the *shape* of a PDF and deliberately returns
none of its text; **`pdf_search`** finds which pages mention something;
**`pdf_read`** returns a bounded window of pages.

The intended loop is **map → search → read**. On a 300-page manual (~12,200
tokens of text):

```
pdf_search(path, query="authentication")

3 matches on 3 pages in /tmp/manual.pdf
Pages: 7, 88, 203

p.7:   CHAPTER 7. authentication tokens are rotated hourly
p.88:  CHAPTER 88. the authentication handshake uses mutual TLS
p.203: CHAPTER 203. authentication failures are logged to the audit trail

Read them with pdf_read pages="7,88,203"
```

That is ~40 tokens read instead of 12,194 — and the last line hands the agent
the exact argument for the next call.

## Why the obvious tool shape is wrong

A tool shaped `read_pdf(path) -> text` fails on real documents, but not for the
reason it first appears. Measured in this image, on a 500-page / 434 KB PDF:

| operation | time |
|---|---|
| metadata only (`max: 1`) | 44 ms |
| window pp. 1–10 | 11 ms |
| window pp. 240–250 | 13 ms |
| window pp. 480–490 | 20 ms |
| **full extraction** | **95 ms → 171,500 chars ≈ 43k tokens** |

Extraction is *fast*. 95 ms of CPU produces enough text to blow the context
window. **The model does not hang, it drowns.** And if "give me everything" is
the only call the tool offers, that is the call the model makes.

So the default operation returns no body text at all, and the expensive
operation is unreachable by accident. `pdf_map` answers "how big is this, what's
in it, which pages are worth reading" for ~44 ms and a handful of tokens:

```
/tmp/manual.pdf
300 pages, 259.5 KB, PDF 1.4
Text:   116,901 chars across 300 pages (~29,225 tokens)
Cache:  /tmp/pa-pdf-cache/94206a0eee505d1c.txt
Too large to read whole (~29,225 tokens). Read specific pages, or grep the
cache: rg -n "pattern" "/tmp/pa-pdf-cache/94206a0eee505d1c.txt"
```

## `pdf_read`: bounded windows with a cursor

```
pdf_read(path, pages="40-")

/tmp/manual.pdf — pages 40-66 of 300
[page 40]
CHAPTER 40 lorem ipsum ...

Truncated at 8000 chars. Continue with pages="67-300", or grep the full text:
rg -n "pattern" "/tmp/pa-pdf-cache/94206a0eee505d1c.txt"
```

Design points that matter:

- **Pages are labelled** (`[page 40]`). Without labels the model cannot cite a
  finding or ask for the right next window — the entire point of reading a
  document in pieces.
- **Truncation stops on a page boundary** and reports a `pages` value that can be
  passed straight back. Verified to round-trip with no overlap: `40-` returns
  40–66 and hands back `67-300`, which returns 67–93 and hands back `94-300`.
- **The budget is clamped** (default 8000 chars, max 40000), so `max_chars:
  10000000` cannot be used to smuggle the whole document into context.
- **Selections are parsed strictly**: `"12"`, `"12-20"`, `"12-"`, `"1,5,9-11"`.
  Pages past the end are dropped (asking for `299-9999` of 300 gives 299–300),
  but a selection landing *entirely* outside the document is an error rather
  than an empty read — that is a mistake worth surfacing.
- **A page larger than the whole budget is cut open rather than skipped.**
  Otherwise a document with one enormous page is unreadable at any budget.
- **Scanned pages emit a marker**, never silence: `[page 2: no text layer —
  scanned image]`. Returning nothing reads as "this page is blank", which is
  wrong and sends the agent looking in the wrong place.

## `pdf_search`: how you navigate without a table of contents

`pdf-parse` exposes no document outline (see the limitation below), so there is
no TOC to jump from. Locating by content is the only way into a large document,
which makes this the tool that does the real work.

- **Literal and case-insensitive by default.** `regex: true` is available but
  opt-in: a caller-supplied pattern can backtrack catastrophically and
  JavaScript cannot interrupt a single `exec`. The literal path escapes the
  query so it cannot blow up. The internal deadline bounds the loop *between*
  matches, not one pathological match — that residual risk is the caller's, and
  it is why literal is the default.
- **The page list is complete even when snippets are capped.** `max_results`
  limits how many snippets come back, but every matching page is still reported,
  because the page list is the actionable output.
- **Snippets are clamped to their page.** Context never bleeds across a page
  boundary, or a hit would be shown with a neighbouring page's text and be
  mislabelled.
- **A miss on a scanned document explains itself**: it reports that N pages have
  no text layer, so the agent doesn't conclude the document lacks the topic when
  it is simply unsearchable.

Offsets map back to pages by binary search over the page spans. The form-feed
separator between pages deliberately belongs to **no** page, so a regex match
landing on it is counted but not attributed rather than blamed on a neighbour.

## Extract once, serve from cache

Because full extraction is ~95 ms, lazy per-page extraction is premature
optimisation — windowing barely beats it and the cost hardly grows with page
depth. So a PDF is extracted **once**, keyed by `sha256` of its bytes, into:

- `<sha16>.txt` — the full text, pages separated by **form feed** (`\f`), the
  same convention `pdftotext` uses, so the cache stays greppable with `rg`
- `<sha16>.json` — page count, per-page character offsets, scanned-page list,
  document info

Later stages (`pdf_read`, `pdf_search`) become ordinary file reads against that
cache, with no pdfjs in the hot path. Cache location defaults to
`$TMPDIR/pa-pdf-cache`, overridable with `PA_PDF_CACHE_DIR`.

The wall-clock deadline (20 s) and page cap (5000) are guards against
**pathological** files — broken xref, giant scans, font bombs — not the common
case. If either trips, the result is marked `PARTIAL` with the reason, and
whatever was extracted is still cached and usable.

## Scanned pages

Pages with no text layer are detected and reported by page range:

```
No text layer on 2 pages: 2-3 — those pages are scanned images.
```

Upstream judges a whole document with `text.length < 50 * numpages`
(`pi-local-rag/chunking.ts:isSparsePdfText`) — an average. Applying that same 50
*per page* is wrong, and the selftest caught it: a legitimate short page was
reported as scanned. The real signal is far sharper — a rasterised page yields
**exactly 0** characters, while a page with a text layer yields its text however
short. The threshold is therefore small (10 chars, enough to absorb a scan whose
page number is stamped as real text) and detects "no text layer", not "not much
text".

OCR is **not** available in this image (`pdftoppm` and `tesseract` are both
absent), which is exactly why these pages are reported explicitly rather than
returned as empty text. Wiring scanned pages through `inspect_image` is stage 4.

## Dependency: pdf-parse is borrowed, not duplicated

`pdf-parse` (30 MB — it ships four copies of pdf.js) is already baked in as a
transitive dependency of `pi-local-rag` under `pa-rag`. Per the `pa-uitag`
precedent (*"onnxruntime-node is still borrowed on purpose (31 MB)"*), something
this size is borrowed. `pa-pdf` therefore declares **no dependencies**.

The cost is coupling: a `pa-rag` dependency change breaks `pa-pdf` at a
distance. So resolution walks `node_modules` explicitly, **fails loudly** with an
actionable message naming every path it searched, and the selftest asserts it
still resolves.

Two details worth keeping:

- We require `lib/pdf-parse.js`, never the package root — `pdf-parse`'s
  `index.js` runs a debug block that reads a test PDF off disk when it thinks it
  is not being required as a module. `pi-local-rag` avoids the root for the same
  reason.
- We load it with `createRequire`, not `import()`. The file is CommonJS, and a
  dynamic import inside a function body gets hoisted by jiti's ESM→CJS
  transform — the failure documented in `pa-rag/upstream.ts`.

## Known limitation: no outline / TOC

`pdf-parse` returns only `{numpages, numrender, info, metadata, text, version}`.
It never exposes the underlying `PDFDocumentProxy`, so `getOutline()` is
unreachable and `pdf_map` cannot report a table of contents. Attempting to load
the bundled pdf.js build directly fails: it is strict-mode and only initialises
through `pdf-parse`'s own loader.

Navigation therefore rests on `pdf_search` (stage 3) rather than a TOC.

## Test fixtures

`fixtures/` holds two committed PDFs (7–11 KB) with known text on known pages,
regenerated by `fixtures/make-fixtures.py` (a host tool — it needs matplotlib,
which the image does not ship).

They are committed rather than generated in the test because a hand-built
minimal PDF was rejected by **every** pdf.js version bundled in `pdf-parse`
(v1.9.426 → v2.0.550) with `bad XRef entry`, despite spec-correct 20-byte xref
entries whose offsets were verified to land exactly on their object headers.
That is PDF-format archaeology with no bearing on this extension. Fixtures from
a real producer also exercise realistic structure — font subsets, compressed
content streams — that a minimal file would not.
