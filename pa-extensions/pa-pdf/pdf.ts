/**
 * pa-pdf/pdf.ts — extract a PDF to a cached text file with per-page offsets.
 *
 * WHY A CACHE FILE RATHER THAN LAZY PER-PAGE EXTRACTION
 *   Measured in this image on a 500-page / 434KB text PDF via pdf-parse:
 *
 *     metadata only (max:1)   44 ms
 *     window pp.   1-10       11 ms
 *     window pp. 240-250      13 ms
 *     window pp. 480-490      20 ms
 *     FULL extraction         95 ms   -> 171,500 chars (~43k tokens)
 *
 *   Extraction is cheap; windowing barely beats it and the cost hardly grows
 *   with page depth. The thing that actually breaks an agent is the 43k tokens,
 *   not the 95ms. So: extract ONCE into a cache, then serve page windows and
 *   searches from that cache as ordinary file reads. Simpler than lazy paging
 *   and it makes pdf_search cheap, which is the tool that makes a 500-page
 *   document usable at all.
 *
 *   The deadline below is therefore a guard against PATHOLOGICAL files
 *   (broken xref, giant scans, font bombs), not the common case.
 *
 * PAGE SEPARATOR
 *   Pages are joined with U+000C (form feed) — the same convention pdftotext
 *   uses — so the cached .txt stays greppable and page boundaries are visible
 *   without a parallel index. Exact offsets still live in the .json sidecar.
 *
 * WHY WE BORROW pdf-parse INSTEAD OF DEPENDING ON IT
 *   pdf-parse (30MB — it ships four copies of pdf.js) is already baked into the
 *   image as a transitive dependency of pi-local-rag under pa-rag. Per the
 *   pa-uitag precedent ("onnxruntime-node is still borrowed on purpose (31MB)")
 *   something this size is borrowed rather than duplicated. The cost is a
 *   coupling to pa-rag's node_modules, so resolution below fails LOUDLY with an
 *   actionable message rather than degrading.
 *
 *   We require `lib/pdf-parse.js` directly, never the package root: pdf-parse's
 *   index.js runs a debug block that reads a test PDF off disk when it thinks it
 *   is not being required as a module. pi-local-rag avoids the root for the same
 *   reason.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Bump when the extraction format changes, so old caches are ignored. */
const CACHE_VERSION = 1;

/** Page separator: form feed, as pdftotext emits. */
export const PAGE_SEP = "\f";

/**
 * Non-whitespace characters below which a page is treated as having NO TEXT
 * LAYER (i.e. a scan that would need OCR).
 *
 * Upstream judges a whole document with `text.length < 50 * numpages`
 * (pi-local-rag/chunking.ts:isSparsePdfText) — an average. Applying that same
 * 50 per page is wrong, and the selftest caught it: a legitimate title or
 * divider page with one short line got reported as scanned.
 *
 * The real signal is much sharper. A rasterised page yields EXACTLY 0
 * characters (measured on the scanned fixture), while any page with a text
 * layer yields its text however short. The threshold only needs to be above 0
 * to absorb a scan whose page number is stamped as real text, so it is kept
 * deliberately small — this detects "no text layer", not "not much text".
 */
const NO_TEXT_LAYER_CHARS = 10;

/** Hard ceiling on pages extracted in one pass. */
const PAGE_HARD_CAP = 5000;

/** Wall-clock budget for one extraction. */
const DEADLINE_MS = 20_000;

export interface PageSpan {
	page: number;
	/** Byte-independent character offsets into the cached text. */
	start: number;
	end: number;
	/** Non-whitespace characters — what sparseness is judged on. */
	chars: number;
}

export interface PdfDoc {
	sha: string;
	source: string;
	bytes: number;
	numpages: number;
	/** Pages actually extracted; < numpages when capped or timed out. */
	extractedPages: number;
	partial: boolean;
	partialReason?: string;
	info: Record<string, unknown>;
	pdfVersion: string;
	textPath: string;
	metaPath: string;
	pages: PageSpan[];
	/** Pages whose text layer is effectively empty (scanned images). */
	sparsePages: number[];
	extractMs: number;
}

// ── Locating pdf-parse ───────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Walk up `node_modules` chains looking for a package. Plain fs checks rather
 * than require.resolve, which would go through the exports map we are trying to
 * sidestep. Same approach as pa-rag/upstream.ts.
 */
function findPackageDir(name: string, from: string): string | null {
	let dir = from;
	for (;;) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

type PdfParse = (
	buf: Buffer,
	opts?: {
		max?: number;
		pagerender?: (pageData: {
			pageIndex: number;
			getTextContent: (o?: unknown) => Promise<{ items: Array<{ str: string }> }>;
		}) => Promise<string> | string;
	},
) => Promise<{
	numpages: number;
	numrender: number;
	info: Record<string, unknown>;
	metadata: unknown;
	text: string;
	version: string;
}>;

let cachedPdfParse: PdfParse | null = null;

/** Candidate roots to search, nearest-first. pa-rag is the borrow source. */
function searchRoots(): string[] {
	return [
		HERE,
		"/opt/pa/extensions/pa-rag",
		join(HERE, "..", "pa-rag"),
		process.cwd(),
	];
}

export function loadPdfParse(): PdfParse {
	if (cachedPdfParse) return cachedPdfParse;

	let pkgDir: string | null = null;
	for (const root of searchRoots()) {
		pkgDir = findPackageDir("pdf-parse", root);
		if (pkgDir) break;
	}
	if (!pkgDir) {
		throw new Error(
			"pa-pdf: could not find pdf-parse. It is borrowed from pa-rag's node_modules " +
				"(a transitive dependency of pi-local-rag). Searched: " +
				searchRoots().join(", ") +
				". If pa-rag's dependencies changed, pa-pdf needs its own dependency instead.",
		);
	}

	// lib/, never the package root — see the header note about its debug block.
	const entry = join(pkgDir, "lib", "pdf-parse.js");
	if (!existsSync(entry)) {
		throw new Error(`pa-pdf: found pdf-parse at ${pkgDir} but ${entry} is missing.`);
	}

	// createRequire, not import(): the file is CommonJS, and a dynamic import in
	// a function body gets hoisted by jiti's ESM->CJS transform (the failure
	// mode documented in pa-rag/upstream.ts).
	const require_ = createRequire(import.meta.url);
	cachedPdfParse = require_(entry) as PdfParse;
	return cachedPdfParse;
}

// ── Cache ────────────────────────────────────────────────────────────────────

export function cacheDir(): string {
	const dir = process.env.PA_PDF_CACHE_DIR ?? join(tmpdir(), "pa-pdf-cache");
	mkdirSync(dir, { recursive: true });
	return dir;
}

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

function nonWhitespace(s: string): number {
	let n = 0;
	for (const ch of s) if (!/\s/.test(ch)) n++;
	return n;
}

/** Write via temp + rename so a concurrent reader never sees a half file. */
function writeAtomic(path: string, data: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, data);
	renameSync(tmp, path);
}

// ── Extraction ───────────────────────────────────────────────────────────────

/**
 * Extract `absPath` into the cache and return its map. Idempotent: a second
 * call with an unchanged file is a JSON read.
 */
export async function loadPdf(absPath: string, opts: { force?: boolean } = {}): Promise<PdfDoc> {
	if (!existsSync(absPath)) throw new Error(`pa-pdf: no such file: ${absPath}`);
	const st = statSync(absPath);
	if (!st.isFile()) throw new Error(`pa-pdf: not a file: ${absPath}`);

	const buf = readFileSync(absPath);
	if (buf.length === 0) throw new Error(`pa-pdf: file is empty: ${absPath}`);
	if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
		throw new Error(`pa-pdf: not a PDF (missing %PDF- header): ${absPath}`);
	}

	const sha = sha256(buf);
	const dir = cacheDir();
	const short = sha.slice(0, 16);
	const textPath = join(dir, `${short}.txt`);
	const metaPath = join(dir, `${short}.json`);

	if (!opts.force && existsSync(metaPath) && existsSync(textPath)) {
		try {
			const meta = JSON.parse(readFileSync(metaPath, "utf8")) as PdfDoc & { cacheVersion?: number };
			if (meta.cacheVersion === CACHE_VERSION) return meta;
		} catch {
			// Corrupt sidecar: fall through and re-extract.
		}
	}

	const pdf = loadPdfParse();
	const started = Date.now();

	// Phase A: page count only. Cheap (~44ms on 500 pages) and it tells us
	// whether to cap before doing any text work.
	let head: Awaited<ReturnType<PdfParse>>;
	try {
		head = await pdf(buf, { max: 1 });
	} catch (err) {
		throw new Error(`pa-pdf: could not open ${absPath}: ${describe(err)}`);
	}

	const numpages = head.numpages ?? 0;
	if (numpages <= 0) throw new Error(`pa-pdf: reports 0 pages: ${absPath}`);

	const cap = Math.min(numpages, PAGE_HARD_CAP);
	const deadline = started + DEADLINE_MS;

	// Phase B: per-page text. We accumulate ourselves rather than using
	// pdf-parse's joined `text`, because we need exact per-page offsets.
	const captured = new Map<number, string>();
	let timedOut = false;

	try {
		await pdf(buf, {
			max: cap,
			pagerender: async (pageData) => {
				const n = pageData.pageIndex + 1;
				if (timedOut) return "";
				if (Date.now() > deadline) {
					timedOut = true;
					return "";
				}
				try {
					const tc = await pageData.getTextContent();
					captured.set(n, joinItems(tc.items));
				} catch (err) {
					// One broken page must not lose the other 499.
					captured.set(n, `[pa-pdf: page ${n} could not be extracted: ${describe(err)}]`);
				}
				return "";
			},
		});
	} catch (err) {
		throw new Error(`pa-pdf: extraction failed for ${absPath}: ${describe(err)}`);
	}

	const extractedPages = captured.size;
	const parts: string[] = [];
	const pages: PageSpan[] = [];
	const sparsePages: number[] = [];
	let offset = 0;

	for (let n = 1; n <= extractedPages; n++) {
		const text = captured.get(n) ?? "";
		const start = offset;
		parts.push(text);
		offset += text.length;
		const chars = nonWhitespace(text);
		pages.push({ page: n, start, end: offset, chars });
		if (chars < NO_TEXT_LAYER_CHARS) sparsePages.push(n);
		if (n < extractedPages) offset += PAGE_SEP.length;
	}

	const partial = extractedPages < numpages;
	const doc: PdfDoc & { cacheVersion: number } = {
		cacheVersion: CACHE_VERSION,
		sha,
		source: absPath,
		bytes: buf.length,
		numpages,
		extractedPages,
		partial,
		partialReason: partial
			? timedOut
				? `extraction exceeded ${DEADLINE_MS}ms`
				: `page cap of ${PAGE_HARD_CAP} reached`
			: undefined,
		info: head.info ?? {},
		pdfVersion: String(head.version ?? ""),
		textPath,
		metaPath,
		pages,
		sparsePages,
		extractMs: Date.now() - started,
	};

	writeAtomic(textPath, parts.join(PAGE_SEP));
	writeAtomic(metaPath, `${JSON.stringify(doc, null, 1)}\n`);
	return doc;
}

/**
 * Join pdf.js text items into lines. pdf.js emits one item per positioned run;
 * a change in the vertical transform means a new line. Same rule pdf-parse's
 * default renderer uses.
 */
function joinItems(items: Array<{ str: string; transform?: number[] }>): string {
	let lastY: number | undefined;
	let out = "";
	for (const item of items) {
		const y = item.transform?.[5];
		if (lastY === undefined || lastY === y) out += item.str;
		else out += `\n${item.str}`;
		lastY = y;
	}
	return out.trim();
}

function describe(err: unknown): string {
	if (err && typeof err === "object" && "name" in err && (err as { name?: string }).name === "PasswordException") {
		return "the PDF is password protected";
	}
	return err instanceof Error ? err.message : String(err);
}

// ── Reading page windows out of the cache ─────────────────────────────────

/**
 * Parse a page selection: "12", "12-20", "12-" (to the end), or a comma list
 * like "1,5,9-11". Returns ascending unique page numbers.
 *
 * Out-of-range pages are dropped rather than clamped, so asking for "1-9999"
 * on a 300-page document yields 1..300 instead of an error — but a selection
 * that lands entirely outside the document is an error, because that is a
 * mistake worth surfacing rather than an empty read.
 */
export function parsePageSpec(spec: string, numpages: number): number[] {
	const trimmed = spec.trim();
	if (trimmed === "") throw new Error("pa-pdf: empty page selection");

	const out = new Set<number>();
	for (const rawPart of trimmed.split(",")) {
		const part = rawPart.trim();
		if (part === "") continue;

		const range = /^(\d+)\s*-\s*(\d*)$/.exec(part);
		if (range) {
			const from = Number(range[1]);
			const to = range[2] === "" ? numpages : Number(range[2]);
			if (from < 1) throw new Error(`pa-pdf: page numbers start at 1, got "${part}"`);
			if (to < from) throw new Error(`pa-pdf: reversed page range "${part}"`);
			for (let n = from; n <= Math.min(to, numpages); n++) out.add(n);
			continue;
		}

		if (!/^\d+$/.test(part)) {
			throw new Error(
				`pa-pdf: cannot parse page selection "${part}". Use "12", "12-20", "12-", or "1,5,9-11".`,
			);
		}
		const n = Number(part);
		if (n < 1) throw new Error(`pa-pdf: page numbers start at 1, got "${part}"`);
		if (n <= numpages) out.add(n);
	}

	if (out.size === 0) {
		throw new Error(
			`pa-pdf: page selection "${trimmed}" selects nothing in a ${numpages}-page document`,
		);
	}
	return [...out].sort((a, b) => a - b);
}

export interface ReadResult {
	text: string;
	/** Pages fully included in `text`. */
	pagesReturned: number[];
	/** True when the budget stopped us before the selection was exhausted. */
	truncated: boolean;
	/** Page selection to pass back to continue, when truncated. */
	nextSpec?: string;
	/** Pages that were requested but have no text layer. */
	skippedScanned: number[];
	chars: number;
}

/**
 * Slice pages out of the cached text under a character budget.
 *
 * Pages are labelled in the output. Without labels the model has no way to cite
 * a finding or ask for the right next window, which is the whole point of
 * reading a large document in pieces.
 *
 * A page with no text layer is emitted as an explicit marker rather than as
 * nothing: silence reads as "this page is blank", which is wrong and sends the
 * agent looking in the wrong place.
 *
 * Budget handling is per page, but a SINGLE page larger than the whole budget
 * must still return something — otherwise a document with one enormous page is
 * unreadable at any budget. In that case the page is cut mid-way and marked.
 */
export function readPages(
	doc: PdfDoc,
	selection: number[],
	maxChars: number,
): ReadResult {
	const full = readFileSync(doc.textPath, "utf8");
	const byPage = new Map(doc.pages.map((p) => [p.page, p]));

	const chunks: string[] = [];
	const pagesReturned: number[] = [];
	const skippedScanned: number[] = [];
	let used = 0;
	let truncated = false;
	let nextPage: number | undefined;

	for (let i = 0; i < selection.length; i++) {
		const n = selection[i];
		const span = byPage.get(n);

		if (!span) {
			// Beyond what was extracted (partial document).
			chunks.push(`[page ${n}: not extracted — ${doc.partialReason ?? "beyond extracted range"}]`);
			pagesReturned.push(n);
			continue;
		}

		if (span.chars < 1) {
			chunks.push(`[page ${n}: no text layer — scanned image]`);
			skippedScanned.push(n);
			pagesReturned.push(n);
			continue;
		}

		const body = full.slice(span.start, span.end);
		const label = `[page ${n}]\n`;
		const cost = label.length + body.length;

		if (used + cost > maxChars) {
			const room = maxChars - used - label.length;
			// Only cut a page open if nothing has been emitted yet; otherwise stop
			// cleanly on a page boundary and let the caller ask for the rest.
			if (pagesReturned.length === 0 && room > 200) {
				chunks.push(`${label}${body.slice(0, room)}\n[page ${n} truncated at ${room} chars]`);
				pagesReturned.push(n);
				used = maxChars;
			}
			truncated = true;
			nextPage = pagesReturned.includes(n) ? selection[i + 1] : n;
			break;
		}

		chunks.push(`${label}${body}`);
		used += cost;
		pagesReturned.push(n);
	}

	let nextSpec: string | undefined;
	if (truncated && nextPage !== undefined) {
		const remaining = selection.filter((n) => n >= nextPage);
		nextSpec = formatRanges(remaining).replace(/, /g, ",");
	}

	return {
		text: chunks.join("\n\n"),
		pagesReturned,
		truncated,
		nextSpec,
		skippedScanned,
		chars: used,
	};
}

// ── Searching ──────────────────────────────────────────────────────────

export interface SearchHit {
	page: number;
	/** One-line context around the match, clamped to the page. */
	snippet: string;
}

export interface SearchResult {
	hits: SearchHit[];
	/** Total matches found, which may exceed hits.length. */
	totalMatches: number;
	/** Every page containing at least one match, ascending. */
	pagesMatched: number[];
	truncated: boolean;
}

/** Characters of context to show either side of a match. */
const SNIPPET_CONTEXT = 60;

/** Matching is bounded in time as well as in results — see the regex note. */
const SEARCH_DEADLINE_MS = 5000;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Map a character offset in the cached text back to its page, by binary search
 * over the page spans. Linear scanning here would make search O(matches*pages),
 * which on a 500-page document with a common term is the difference between
 * instant and noticeable.
 */
export function pageAtOffset(doc: PdfDoc, offset: number): PageSpan | null {
	let lo = 0;
	let hi = doc.pages.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const span = doc.pages[mid];
		if (offset < span.start) hi = mid - 1;
		else if (offset >= span.end) lo = mid + 1;
		else return span;
	}
	return null;
}

/**
 * Find `query` in the cached text and report page numbers with context.
 *
 * This is the tool that makes a large PDF navigable. pdf-parse exposes no
 * document outline (see docs/pdf.md), so there is no table of contents to jump
 * from — locating by content is the only way in, and it is what keeps pdf_read
 * windows small and targeted.
 *
 * LITERAL BY DEFAULT, REGEX OPT-IN
 *   A caller-supplied regex can backtrack catastrophically, and JavaScript has
 *   no way to interrupt a single `exec`. So the default escapes the query to a
 *   literal, which cannot blow up. `regex: true` is available and documented as
 *   the caller's risk; the deadline below bounds the loop BETWEEN matches, not
 *   a single pathological one.
 */
export function searchPages(
	doc: PdfDoc,
	query: string,
	opts: { regex?: boolean; caseSensitive?: boolean; maxResults?: number } = {},
): SearchResult {
	const q = query.trim();
	if (q === "") throw new Error("pa-pdf: empty search query");

	const maxResults = Math.max(1, Math.min(200, opts.maxResults ?? 20));
	const flags = opts.caseSensitive ? "g" : "gi";

	let re: RegExp;
	try {
		re = new RegExp(opts.regex ? q : escapeRegExp(q), flags);
	} catch (err) {
		throw new Error(`pa-pdf: invalid regex ${JSON.stringify(q)}: ${describe(err)}`);
	}

	const full = readFileSync(doc.textPath, "utf8");
	const hits: SearchHit[] = [];
	const pagesMatched = new Set<number>();
	const deadline = Date.now() + SEARCH_DEADLINE_MS;

	let totalMatches = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(full)) !== null) {
		// A zero-width match (e.g. regex "a*") would spin forever otherwise.
		if (match[0].length === 0) {
			re.lastIndex++;
			continue;
		}

		totalMatches++;
		const span = pageAtOffset(doc, match.index);
		if (span) {
			pagesMatched.add(span.page);
			if (hits.length < maxResults) {
				// Clamp context to the page, so a snippet never bleeds text from a
				// neighbouring page and mislabels where the match actually is.
				const from = Math.max(span.start, match.index - SNIPPET_CONTEXT);
				const to = Math.min(span.end, match.index + match[0].length + SNIPPET_CONTEXT);
				const body = full.slice(from, to).replace(/\s+/g, " ").trim();
				hits.push({
					page: span.page,
					snippet: `${from > span.start ? "…" : ""}${body}${to < span.end ? "…" : ""}`,
				});
			}
		}

		if (Date.now() > deadline) break;
	}

	return {
		hits,
		totalMatches,
		pagesMatched: [...pagesMatched].sort((a, b) => a - b),
		truncated: totalMatches > hits.length,
	};
}

// ── Rendering pages to images (for scans) ────────────────────────────────

export interface RenderedPage {
	page: number;
	path: string;
	bytes: number;
	/** True when an existing render was reused rather than re-rasterised. */
	cached: boolean;
	/** True when this page already has extractable text (pdf_read is cheaper). */
	hasText: boolean;
}

/** Rasterising is cheap; the VISION CALL per page is not. Keep windows small. */
const MAX_RENDER_PAGES = 10;
const DEFAULT_DPI = 150;
const MIN_DPI = 50;
const MAX_DPI = 300;
/** Per-page rasterise timeout. A pathological page must not wedge the tool. */
const RENDER_TIMEOUT_MS = 20_000;

let pdftoppmChecked: string | null | undefined;

/** One-shot probe for pdftoppm, cached. Mirrors pi-local-rag's getOcrTooling. */
export function findPdftoppm(): string | null {
	if (pdftoppmChecked !== undefined) return pdftoppmChecked;
	const probe = spawnSync("pdftoppm", ["-v"], { encoding: "utf8" });
	pdftoppmChecked = probe.error ? null : "pdftoppm";
	return pdftoppmChecked;
}

/**
 * Rasterise selected pages to PNG so a vision model can read them.
 *
 * WHY THIS RENDERS INSTEAD OF OCR-ING
 *   The image is the deliverable, not text. This sandbox already has a vision
 *   tool (inspect_image) and an established idiom — screenshot_url writes a PNG
 *   and returns its path, detect_ui_elements crops to a box and hands it to
 *   inspect_image. Doing the same here avoids duplicating pa-inspect-image's
 *   model-registry resolution, keeps the expensive step under the caller's
 *   control, and means better vision models improve OCR for free.
 *
 *   It is also why the tool is called pdf_render rather than pdf_ocr: it returns
 *   images. Naming it for an output it does not produce would be a lie the
 *   model would act on.
 *
 * `-singlefile` is not optional. Without it pdftoppm zero-pads the page number
 * to the width of the document's last page (page 7 of 300 becomes `pad-007.png`),
 * so the output name depends on the page count. With it the name is exactly what
 * we asked for.
 */
export function renderPages(
	doc: PdfDoc,
	selection: number[],
	opts: { dpi?: number; force?: boolean } = {},
): { rendered: RenderedPage[]; dropped: number[]; dpi: number } {
	const bin = findPdftoppm();
	if (!bin) {
		throw new Error(
			"pa-pdf: pdftoppm not found. It comes from the poppler-utils package, which the " +
				"sandbox image installs in scripts/install-system-deps.sh. Outside the image: " +
				"apt-get install -y poppler-utils",
		);
	}

	const dpi = Math.max(MIN_DPI, Math.min(MAX_DPI, Math.floor(opts.dpi ?? DEFAULT_DPI)));
	const take = selection.slice(0, MAX_RENDER_PAGES);
	const dropped = selection.slice(MAX_RENDER_PAGES);

	const dir = cacheDir();
	const short = doc.sha.slice(0, 16);
	const byPage = new Map(doc.pages.map((p) => [p.page, p]));
	const rendered: RenderedPage[] = [];

	for (const page of take) {
		const root = join(dir, `${short}-p${page}-r${dpi}`);
		const out = `${root}.png`;

		if (!opts.force && existsSync(out)) {
			rendered.push({
				page,
				path: out,
				bytes: statSync(out).size,
				cached: true,
				hasText: (byPage.get(page)?.chars ?? 0) >= NO_TEXT_LAYER_CHARS,
			});
			continue;
		}

		const res = spawnSync(
			bin,
			["-png", "-r", String(dpi), "-f", String(page), "-l", String(page), "-singlefile", doc.source, root],
			{ encoding: "utf8", timeout: RENDER_TIMEOUT_MS },
		);

		if (res.error || res.status !== 0 || !existsSync(out)) {
			const why = res.error
				? res.error.message
				: (res.stderr || "").trim() || `pdftoppm exited ${res.status}`;
			throw new Error(`pa-pdf: could not render page ${page} of ${doc.source}: ${why}`);
		}

		rendered.push({
			page,
			path: out,
			bytes: statSync(out).size,
			cached: false,
			hasText: (byPage.get(page)?.chars ?? 0) >= NO_TEXT_LAYER_CHARS,
		});
	}

	return { rendered, dropped, dpi };
}

/** Collapse [1,2,3,7,8] into "1-3, 7-8" for compact reporting. */
export function formatRanges(nums: number[]): string {
	if (nums.length === 0) return "";
	const sorted = [...nums].sort((a, b) => a - b);
	const out: string[] = [];
	let start = sorted[0];
	let prev = sorted[0];
	for (const n of sorted.slice(1)) {
		if (n === prev + 1) {
			prev = n;
			continue;
		}
		out.push(start === prev ? `${start}` : `${start}-${prev}`);
		start = prev = n;
	}
	out.push(start === prev ? `${start}` : `${start}-${prev}`);
	return out.join(", ");
}
