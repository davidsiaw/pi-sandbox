/**
 * selftest.mjs — auth-free guard for pa-pdf (stage 1).
 *
 * Uses two committed fixtures under ./fixtures (7KB each) with known text on
 * known pages, so offset assertions mean something.
 *
 * WHY FIXTURES AND NOT A HAND-BUILT PDF
 *   The first attempt generated PDFs byte-by-byte to avoid committing binaries.
 *   Every bundled pdf.js version (v1.9.426 through v2.0.550) rejected them with
 *   "bad XRef entry" despite spec-correct 20-byte xref entries and offsets
 *   verified to land on their object headers. Chasing that is PDF-format
 *   archaeology with no bearing on this extension. Real fixtures from a real
 *   producer also exercise realistic structure (font subsets, compressed
 *   streams) that a minimal hand-rolled file would not.
 *   Regenerate with fixtures/make-fixtures.py; see that file.
 *
 * Guards the things most likely to break silently:
 *   (1) pdf-parse still resolves — it is BORROWED from pa-rag's node_modules,
 *       so a pa-rag dependency change breaks pa-pdf at a distance;
 *   (2) per-page offsets actually address the right page in the cached text
 *       (this is what pdf_read and pdf_search will be built on);
 *   (3) pages are separated by form feed, so the cache stays greppable;
 *   (4) pages with no text layer are detected and reported, instead of being
 *       silently returned as empty — the scanned-PDF failure mode;
 *   (5) the cache is reused on a second call rather than re-extracting;
 *   (6) non-PDF and missing input fail with a clear message, not a crash.
 *
 * Usage: node selftest.mjs   (exit 0 = pass, non-zero = fail)
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PI_ROOT = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";
const PI_MODULES = `${PI_ROOT}/node_modules`;

let failed = 0;
const check = (label, ok, detail = "") => {
	console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
};

const FIXTURES = join(HERE, "fixtures");

// ── Load the module under test through pi's own jiti ─────────────────────────

const { createJiti } = await import(`${PI_MODULES}/jiti/lib/jiti.mjs`);
const jiti = createJiti(`file://${HERE}/`, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": PI_ROOT,
		typebox: `${PI_MODULES}/typebox/build/index.mjs`,
	},
});

const SANDBOX = mkdtempSync(join(tmpdir(), "pa-pdf-selftest-"));
process.env.PA_PDF_CACHE_DIR = join(SANDBOX, "cache");

let mod;
try {
	mod = await jiti.import(join(HERE, "pdf.ts"));
} catch (err) {
	console.log(`  FAIL  pdf.ts failed to load — ${err.message}`);
	process.exit(1);
}
const { loadPdf, loadPdfParse, formatRanges, PAGE_SEP, parsePageSpec, readPages, searchPages, pageAtOffset } = mod;

// (1) the borrowed dependency still resolves
try {
	const fn = loadPdfParse();
	check("pdf-parse resolves (borrowed from pa-rag)", typeof fn === "function");
} catch (err) {
	check("pdf-parse resolves (borrowed from pa-rag)", false, err.message);
	console.log("\nselftest: cannot continue without pdf-parse");
	process.exit(1);
}

// ── A 3-page document with known text ────────────────────────────────────────

// Copied into the sandbox so `force` re-extraction cannot touch the committed
// fixture's mtime, and so a failed run leaves the repo untouched.
const threePage = join(SANDBOX, "three-page.pdf");
copyFileSync(join(FIXTURES, "three-page.pdf"), threePage);

const doc = await loadPdf(threePage);

check("page count is read correctly", doc.numpages === 3, `got ${doc.numpages}`);
check("all pages extracted", doc.extractedPages === 3, `got ${doc.extractedPages}`);
check("not marked partial", doc.partial === false);

const text = readFileSync(doc.textPath, "utf8");

// (3) form-feed separation keeps the cache greppable
const ff = [...text].filter((c) => c === PAGE_SEP).length;
check("pages separated by form feed", ff === 2, `got ${ff} separators for 3 pages`);

// (2) offsets address the right page — the contract pdf_read/pdf_search rely on
const slice = (n) => {
	const span = doc.pages.find((p) => p.page === n);
	return text.slice(span.start, span.end);
};
check("page 1 offsets select page 1 text", slice(1).includes("ALPHA_MARKER_ONE"), JSON.stringify(slice(1)));
check("page 2 offsets select page 2 text", slice(2).includes("BRAVO_MARKER_TWO"), JSON.stringify(slice(2)));
check("page 3 offsets select page 3 text", slice(3).includes("CHARLIE_MARKER_THREE"), JSON.stringify(slice(3)));
check(
	"page 2 slice does not bleed into its neighbours",
	!slice(2).includes("ALPHA_MARKER_ONE") && !slice(2).includes("CHARLIE_MARKER_THREE"),
);

// (5) second call is served from cache, not re-extracted
const before = statSync(doc.textPath).mtimeMs;
await new Promise((r) => setTimeout(r, 12));
const again = await loadPdf(threePage);
check("second call reuses the cache", statSync(again.textPath).mtimeMs === before);
check("cached result is equivalent", again.sha === doc.sha && again.numpages === doc.numpages);

// force re-extracts
const forced = await loadPdf(threePage, { force: true });
check("force re-extracts", statSync(forced.textPath).mtimeMs !== before);

// ── (4) scanned pages: real pages with no text layer ─────────────────────────

const scanned = join(SANDBOX, "scanned.pdf");
copyFileSync(join(FIXTURES, "scanned.pdf"), scanned);
const sdoc = await loadPdf(scanned);
check("scanned pages detected", sdoc.sparsePages.join(",") === "2,3", `got [${sdoc.sparsePages}]`);
check("text page not flagged as scanned", !sdoc.sparsePages.includes(1));

// ── (6) bad input fails clearly ──────────────────────────────────────────────

const notPdf = join(SANDBOX, "notes.txt");
writeFileSync(notPdf, "this is plainly not a pdf");
let msg = "";
try {
	await loadPdf(notPdf);
} catch (err) {
	msg = err.message;
}
check("non-PDF rejected by header check", /not a PDF/i.test(msg), msg || "no error thrown");

msg = "";
try {
	await loadPdf(join(SANDBOX, "does-not-exist.pdf"));
} catch (err) {
	msg = err.message;
}
check("missing file rejected", /no such file/i.test(msg), msg || "no error thrown");

// ── range formatting used by pdf_map's scanned-page report ───────────────────

check("formatRanges collapses runs", formatRanges([1, 2, 3, 7, 8, 11]) === "1-3, 7-8, 11", formatRanges([1, 2, 3, 7, 8, 11]));
check("formatRanges handles singletons", formatRanges([4]) === "4");
check("formatRanges handles empty", formatRanges([]) === "");

// ── page selection parsing ──────────────────────────────────────────────────

const spec = (s, n = 300) => parsePageSpec(s, n).join(",");
check("spec: single page", spec("12") === "12");
check("spec: range", spec("12-15") === "12,13,14,15");
check("spec: open-ended range runs to the last page", spec("298-", 300) === "298,299,300");
check("spec: comma list with ranges", spec("1,5,9-11") === "1,5,9,10,11");
check("spec: duplicates collapse and order is ascending", spec("9,1,9,2-3") === "1,2,3,9");
check("spec: pages past the end are dropped, not an error", spec("299-9999", 300) === "299,300");

const specThrows = (s, n = 300) => {
	try {
		parsePageSpec(s, n);
		return "";
	} catch (err) {
		return err.message;
	}
};
check("spec: entirely out of range is an error", /selects nothing/.test(specThrows("900-999", 300)));
check("spec: reversed range is an error", /reversed/.test(specThrows("20-10")));
check("spec: page 0 is an error", /start at 1/.test(specThrows("0-5")));
check("spec: garbage is an error", /cannot parse/.test(specThrows("twelve")));
check("spec: empty is an error", /empty page selection/.test(specThrows("   ")));

// ── windowed reads out of the cache ─────────────────────────────────────────

const r2 = readPages(doc, [2], 8000);
check("read: returns only the requested page", r2.text.includes("BRAVO_MARKER_TWO"));
check(
	"read: does not leak neighbouring pages",
	!r2.text.includes("ALPHA_MARKER_ONE") && !r2.text.includes("CHARLIE_MARKER_THREE"),
	r2.text,
);
check("read: labels the page so the model can cite it", r2.text.includes("[page 2]"));
check("read: not truncated when it fits", r2.truncated === false);

const rAll = readPages(doc, [1, 2, 3], 8000);
check("read: multi-page window returns all three", rAll.pagesReturned.join(",") === "1,2,3");

// budget stops on a page boundary and hands back a usable cursor
const tiny = readPages(doc, [1, 2, 3], 60);
check("read: budget truncates", tiny.truncated === true);
check("read: truncation reports where to continue", !!tiny.nextSpec, JSON.stringify(tiny.nextSpec));
check(
	"read: continuation spec re-parses and excludes what was already returned",
	!!tiny.nextSpec && !parsePageSpec(tiny.nextSpec, doc.numpages).includes(1),
	String(tiny.nextSpec),
);

// a single page bigger than the whole budget must still return something,
// or a document with one huge page is unreadable at any budget
const hugeOnly = readPages(doc, [1], 300);
check(
	"read: an oversized single page is cut open rather than returning nothing",
	hugeOnly.text.includes("ALPHA_MARKER_ONE") || /truncated at/.test(hugeOnly.text),
	hugeOnly.text.slice(0, 80),
);

// scanned pages come back as explicit markers, never as silence
const rs = readPages(sdoc, [1, 2, 3], 8000);
check("read: scanned page emits a marker, not empty text", /\[page 2: no text layer/.test(rs.text), rs.text);
check("read: scanned pages are reported separately", rs.skippedScanned.join(",") === "2,3");
check("read: the text page still comes through", rs.text.includes("REAL_TEXT_PAGE"));

// ── search ──────────────────────────────────────────────────────────────────

// offset -> page mapping is the foundation; a subtle off-by-one here would
// mislabel every hit, so check the boundaries explicitly.
const p2 = doc.pages.find((p) => p.page === 2);
check("offset->page: first char of a page maps to that page", pageAtOffset(doc, p2.start)?.page === 2);
check("offset->page: last char of a page maps to that page", pageAtOffset(doc, p2.end - 1)?.page === 2);
// The character immediately before a page start is the form-feed SEPARATOR,
// which deliberately belongs to no page: spans are [start, end) and the joiner
// sits between them. A match landing there (only possible with a regex like
// \s) is counted but not attributed to a page, rather than being blamed on a
// neighbour.
const p1 = doc.pages.find((p) => p.page === 1);
check("offset->page: last char of page 1 maps to page 1", pageAtOffset(doc, p1.end - 1)?.page === 1);
check("offset->page: the page separator belongs to no page", pageAtOffset(doc, p2.start - 1) === null);
check("offset->page: past the end is null", pageAtOffset(doc, 10 ** 9) === null);

const sr = searchPages(doc, "BRAVO_MARKER_TWO");
check("search: finds the term", sr.totalMatches === 1, `got ${sr.totalMatches}`);
check("search: reports the right page", sr.pagesMatched.join(",") === "2", `got [${sr.pagesMatched}]`);
check("search: snippet contains the match", sr.hits[0]?.snippet.includes("BRAVO_MARKER_TWO"), sr.hits[0]?.snippet);

check("search: case-insensitive by default", searchPages(doc, "bravo_marker_two").totalMatches === 1);
check("search: case_sensitive suppresses a wrong-case match",
	searchPages(doc, "bravo_marker_two", { caseSensitive: true }).totalMatches === 0);

// a term on every page should report every page
const all = searchPages(doc, "MARKER");
check("search: term on all pages reports all pages", all.pagesMatched.join(",") === "1,2,3", `got [${all.pagesMatched}]`);

// literal by default: regex metacharacters must not be interpreted
const dotted = searchPages(doc, "ALPHA.MARKER.ONE");
check("search: query is literal by default (dots are not wildcards)", dotted.totalMatches === 0, `got ${dotted.totalMatches}`);
check("search: regex:true enables patterns", searchPages(doc, "ALPHA.MARKER.ONE", { regex: true }).totalMatches === 1);

let serr = "";
try { searchPages(doc, "(unclosed", { regex: true }); } catch (e) { serr = e.message; }
check("search: invalid regex is a clear error", /invalid regex/.test(serr), serr || "no error");

serr = "";
try { searchPages(doc, "   "); } catch (e) { serr = e.message; }
check("search: empty query is an error", /empty search query/.test(serr), serr || "no error");

// a zero-width regex must not spin forever
const zw = searchPages(doc, "x*", { regex: true, maxResults: 5 });
check("search: zero-width regex terminates", zw.hits.length <= 5);

// max_results caps snippets but the page list stays complete
const capped = searchPages(doc, "MARKER", { maxResults: 1 });
check("search: maxResults caps the snippets", capped.hits.length === 1);
check("search: truncation is flagged", capped.truncated === true);
check("search: page list stays complete despite the cap", capped.pagesMatched.join(",") === "1,2,3");

// no matches is a normal result, not an error
const none = searchPages(doc, "ZZZ_DEFINITELY_NOT_PRESENT");
check("search: no matches returns empty, not an error", none.totalMatches === 0 && none.hits.length === 0);

// snippets must not bleed across a page boundary and mislabel the hit
const bleed = searchPages(doc, "CHARLIE_MARKER_THREE");
check("search: snippet does not include the previous page's text",
	!bleed.hits[0]?.snippet.includes("BRAVO_MARKER_TWO"), bleed.hits[0]?.snippet);

// ── the tools register and behave ───────────────────────────────────────────

try {
	const ext = await jiti.import(join(HERE, "index.ts"));
	const tools = [];
	const pi = { registerTool: (t) => tools.push(t), on() {}, registerCommand() {}, registerProvider() {} };
	(ext.default ?? ext)(pi);
	const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
	check("registers all three tools", tools.length === 3, `got ${tools.map((t) => t.name).join(",")}`);
	check("pdf_map is registered", !!byName.pdf_map);
	check("pdf_read is registered", !!byName.pdf_read);
	check("pdf_search is registered", !!byName.pdf_search);

	const res = await byName.pdf_map.execute("t1", { path: threePage }, null, () => {}, { cwd: SANDBOX });
	const out = res.content.map((c) => c.text).join("\n");
	check("pdf_map reports the page count", /\b3 pages\b/.test(out), out.split("\n")[1]);
	check(
		"pdf_map returns NO body text (the whole point)",
		!out.includes("ALPHA_MARKER_ONE") && !out.includes("BRAVO_MARKER_TWO"),
		out,
	);
	check("pdf_map reports the cache path", out.includes(doc.textPath));
	check("pdf_map details carry structured fields", res.details?.numpages === 3 && typeof res.details?.estimatedTokens === "number");

	const rr = await byName.pdf_read.execute("t2", { path: threePage, pages: "2" }, null, () => {}, { cwd: SANDBOX });
	const rtext = rr.content.map((c) => c.text).join("\n");
	check("pdf_read returns the requested page", rtext.includes("BRAVO_MARKER_TWO"));
	check("pdf_read excludes other pages", !rtext.includes("ALPHA_MARKER_ONE"), rtext);
	check("pdf_read details record what was returned", rr.details?.pagesReturned?.join(",") === "2");

	// the default selection must still be bounded, not "the whole document"
	const rdef = await byName.pdf_read.execute("t3", { path: threePage }, null, () => {}, { cwd: SANDBOX });
	check("pdf_read defaults to starting at page 1", rdef.details?.pagesReturned?.[0] === 1);
	check("pdf_read applies a default budget", typeof rdef.details?.budget === "number" && rdef.details.budget > 0);

	// an absurd budget request is clamped, not honoured
	const rbig = await byName.pdf_read.execute(
		"t4",
		{ path: threePage, pages: "1-3", max_chars: 10000000 },
		null,
		() => {},
		{ cwd: SANDBOX },
	);
	check("pdf_read clamps an absurd max_chars", rbig.details.budget <= 40000, String(rbig.details.budget));

	let perr = "";
	try {
		await byName.pdf_read.execute("t5", { path: threePage, pages: "90-99" }, null, () => {}, { cwd: SANDBOX });
	} catch (err) {
		perr = err.message;
	}
	check("pdf_read rejects a selection outside the document", /selects nothing/.test(perr), perr || "no error");

	const rsr = await byName.pdf_search.execute("t6", { path: threePage, query: "BRAVO_MARKER_TWO" }, null, () => {}, { cwd: SANDBOX });
	const stext = rsr.content.map((c) => c.text).join("\n");
	check("pdf_search reports the matching page", /Pages: 2/.test(stext), stext.split("\n")[1]);
	check("pdf_search hands back a pdf_read selection", /pdf_read pages="2"/.test(stext), stext);
	check("pdf_search details carry the page list", rsr.details?.pagesMatched?.join(",") === "2");

	// the search -> read handoff must actually work end to end
	const handoff = await byName.pdf_read.execute(
		"t7",
		{ path: threePage, pages: rsr.details.pagesMatched.join(",") },
		null, () => {}, { cwd: SANDBOX },
	);
	check("search -> read handoff returns the matching page",
		handoff.content.map((c) => c.text).join("").includes("BRAVO_MARKER_TWO"));

	const rmiss = await byName.pdf_search.execute("t8", { path: threePage, query: "NOT_IN_DOC_XYZ" }, null, () => {}, { cwd: SANDBOX });
	check("pdf_search: no matches is a normal result", /No matches/.test(rmiss.content[0].text));

	// on a scanned document, a miss must explain that the pages are unsearchable
	const rscan = await byName.pdf_search.execute("t9", { path: scanned, query: "anything" }, null, () => {}, { cwd: SANDBOX });
	check("pdf_search explains unsearchable scanned pages",
		/no text layer/.test(rscan.content[0].text), rscan.content[0].text);
} catch (err) {
	check("index.ts loads and registers both tools", false, err.message);
}


rmSync(SANDBOX, { recursive: true, force: true });

console.log(failed === 0 ? "\nselftest: all checks passed" : `\nselftest: ${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
