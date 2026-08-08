/**
 * pa-pdf (pa baked extension) — stage 1: `pdf_map`.
 *
 * THE PROBLEM THIS SOLVES
 *   A tool shaped `read_pdf(path) -> text` is unusable on real documents. A
 *   500-page PDF extracts in ~95ms but yields ~43k tokens: the model does not
 *   hang, it drowns. And because "give me everything" is the only call the tool
 *   offers, that is the call the model makes.
 *
 *   So the DEFAULT operation returns no body text at all. `pdf_map` reports the
 *   shape of the document — how many pages, how much text, which pages are
 *   scanned, where the cached text lives — and tells the caller to fetch
 *   specific pages. The expensive thing is unreachable by accident.
 *
 * SEPARATE TOOLS, NOT ONE TOOL WITH A MODE
 *   pdf_map reports shape; pdf_read returns a bounded page window; pdf_search
 *   locates content so those windows stay small. Distinct names are more legible
 *   to a model than an `op` enum, and each gets its own guidelines.
 *
 *   pdf_search carries more weight here than in most document tools: pdf-parse
 *   exposes no outline, so there is no table of contents to navigate by.
 *   Locating by content is the only way into a large document.
 *
 * Extraction, caching, slicing and search live in ./pdf.ts.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatRanges, loadPdf, parsePageSpec, readPages, searchPages } from "./pdf.ts";

/**
 * Default output budget in characters. ~8k chars is roughly 2k tokens — several
 * pages of prose without crowding the conversation. Same inline budget
 * pa-yousoro-browse uses for page text.
 */
const DEFAULT_MAX_CHARS = 8000;

/** Ceiling on a single call however large max_chars is set. */
const MAX_MAX_CHARS = 40000;

/** Rough token estimate. 4 chars/token is the usual English approximation. */
const estimateTokens = (chars: number): number => Math.round(chars / 4);

function humanBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const PdfMapParams = Type.Object({
	path: Type.String({
		description:
			"Path to a PDF file: workspace-relative or absolute. A leading @ is ignored.",
	}),
	force: Type.Optional(
		Type.Boolean({
			description:
				"Re-extract even if this exact file (by content hash) is already cached. Rarely needed.",
		}),
	),
});

const PdfReadParams = Type.Object({
	path: Type.String({
		description:
			"Path to a PDF file: workspace-relative or absolute. A leading @ is ignored.",
	}),
	pages: Type.Optional(
		Type.String({
			description:
				'Which pages to read: "12", "12-20", "12-" (to the end), or a list like "1,5,9-11". ' +
				"Omit to start from page 1. Pages past the end of the document are ignored.",
		}),
	),
	max_chars: Type.Optional(
		Type.Number({
			description:
				`Output budget in characters (default ${DEFAULT_MAX_CHARS}, max ${MAX_MAX_CHARS}). ` +
				"Reading stops on a page boundary when the budget runs out and reports how to continue.",
		}),
	),
});

const PdfSearchParams = Type.Object({
	path: Type.String({
		description:
			"Path to a PDF file: workspace-relative or absolute. A leading @ is ignored.",
	}),
	query: Type.String({
		description: "Text to find. Literal by default — set regex true to treat it as a pattern.",
	}),
	regex: Type.Optional(
		Type.Boolean({
			description:
				"Treat query as a JavaScript regular expression. Default false (literal), which is " +
				"safer: a hand-written pattern can backtrack catastrophically.",
		}),
	),
	case_sensitive: Type.Optional(
		Type.Boolean({ description: "Match case exactly. Default false." }),
	),
	max_results: Type.Optional(
		Type.Number({ description: "Maximum snippets to return (default 20, max 200)." }),
	),
});

export default function pdfExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "pdf_map",
		label: "Map PDF",
		description:
			"Report the structure of a PDF without returning its text: page count, size, " +
			"estimated tokens, which pages have no text layer (scanned), and the path to the " +
			"extracted text cache. Always call this before reading a PDF — it tells you whether " +
			"the document is small enough to read whole and which pages are worth reading.",
		promptSnippet: "Inspect a PDF's size and structure before reading any of it",
		promptGuidelines: [
			"Call pdf_map first for any PDF. It never returns body text, so it is always cheap.",
			"Use the reported token estimate to decide: read specific pages, do not read a large PDF whole.",
			"Pages listed as having no text layer are scanned images; extracting them yields nothing.",
			"The cached text file it reports is plain text with pages separated by form feed (\\f) — grep it with rg.",
		],
		parameters: PdfMapParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const raw = params.path.startsWith("@") ? params.path.slice(1) : params.path;
			const abs = isAbsolute(raw) ? raw : resolvePath(ctx.cwd, raw);

			const doc = await loadPdf(abs, { force: params.force === true });

			const totalChars = doc.pages.reduce((sum, p) => sum + (p.end - p.start), 0);
			const tokens = estimateTokens(totalChars);
			const textPages = doc.extractedPages - doc.sparsePages.length;

			const lines: string[] = [];
			lines.push(`${abs}`);
			lines.push(
				`${doc.numpages} page${doc.numpages === 1 ? "" : "s"}, ${humanBytes(doc.bytes)}, ` +
					`PDF ${String(doc.info.PDFFormatVersion ?? doc.pdfVersion)}`,
			);

			const title = typeof doc.info.Title === "string" ? doc.info.Title.trim() : "";
			const author = typeof doc.info.Author === "string" ? doc.info.Author.trim() : "";
			if (title) lines.push(`Title:  ${title}`);
			if (author) lines.push(`Author: ${author}`);

			lines.push(
				`Text:   ${totalChars.toLocaleString()} chars across ${textPages} page${textPages === 1 ? "" : "s"} ` +
					`(~${tokens.toLocaleString()} tokens)`,
			);

			if (doc.sparsePages.length > 0) {
				lines.push(
					`No text layer on ${doc.sparsePages.length} page${doc.sparsePages.length === 1 ? "" : "s"}: ` +
						`${formatRanges(doc.sparsePages)}` +
						(doc.sparsePages.length === doc.extractedPages
							? " — this document is entirely scanned images; text extraction will return nothing."
							: " — those pages are scanned images."),
				);
			}

			if (doc.partial) {
				lines.push(
					`PARTIAL: only pages 1-${doc.extractedPages} of ${doc.numpages} were extracted ` +
						`(${doc.partialReason}).`,
				);
			}

			lines.push(`Cache:  ${doc.textPath}`);

			// The whole point of the map: steer the next call.
			if (tokens > 8000) {
				lines.push(
					`Too large to read whole (~${tokens.toLocaleString()} tokens). Read specific pages, ` +
						`or grep the cache: rg -n "pattern" "${doc.textPath}"`,
				);
			} else if (totalChars > 0) {
				lines.push(`Small enough to read whole (~${tokens.toLocaleString()} tokens).`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					source: abs,
					sha: doc.sha,
					bytes: doc.bytes,
					numpages: doc.numpages,
					extractedPages: doc.extractedPages,
					partial: doc.partial,
					partialReason: doc.partialReason,
					chars: totalChars,
					estimatedTokens: tokens,
					sparsePages: doc.sparsePages,
					textPath: doc.textPath,
					metaPath: doc.metaPath,
					extractMs: doc.extractMs,
				},
			};
		},
	});

	pi.registerTool({
		name: "pdf_read",
		label: "Read PDF Pages",
		description:
			"Read a specific range of pages from a PDF as text. Output is capped and stops on a " +
			"page boundary, reporting how to continue, so it is safe to call on a large document. " +
			"Call pdf_map first to find out how many pages there are and which ones have text.",
		promptSnippet: "Read a bounded range of pages from a PDF",
		promptGuidelines: [
			"Call pdf_map before pdf_read so you know the page count and which pages are scanned.",
			"Read the pages you need, not the whole document: pass pages like \"12-20\".",
			"If the result says it was truncated, pass the suggested pages value to continue.",
			"Pages reported as having no text layer return a marker, not text — they are images.",
		],
		parameters: PdfReadParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const raw = params.path.startsWith("@") ? params.path.slice(1) : params.path;
			const abs = isAbsolute(raw) ? raw : resolvePath(ctx.cwd, raw);

			const budget = Math.max(
				500,
				Math.min(MAX_MAX_CHARS, Math.floor(params.max_chars ?? DEFAULT_MAX_CHARS)),
			);

			const doc = await loadPdf(abs);
			const selection = parsePageSpec(params.pages ?? "1-", doc.numpages);
			const result = readPages(doc, selection, budget);

			const header: string[] = [];
			header.push(
				`${abs} — pages ${formatRanges(result.pagesReturned)} of ${doc.numpages}`,
			);
			if (result.skippedScanned.length > 0) {
				header.push(
					`No text layer on ${formatRanges(result.skippedScanned)} (scanned images).`,
				);
			}

			const footer: string[] = [];
			if (result.truncated && result.nextSpec) {
				footer.push(
					`Truncated at ${budget} chars. Continue with pages="${result.nextSpec}", ` +
						`or grep the full text: rg -n "pattern" "${doc.textPath}"`,
				);
			}

			const text = [header.join("\n"), "", result.text, ...(footer.length ? ["", footer.join("\n")] : [])]
				.join("\n")
				.trimEnd();

			return {
				content: [{ type: "text", text }],
				details: {
					source: abs,
					numpages: doc.numpages,
					requested: params.pages ?? "1-",
					pagesReturned: result.pagesReturned,
					truncated: result.truncated,
					nextPages: result.nextSpec,
					scannedPages: result.skippedScanned,
					chars: result.chars,
					budget,
					textPath: doc.textPath,
				},
			};
		},
	});

	pi.registerTool({
		name: "pdf_search",
		label: "Search PDF",
		description:
			"Find text in a PDF and get back the page numbers it appears on, with a short " +
			"snippet for each hit. This is how you navigate a large PDF: search first, then " +
			"pdf_read only the pages that matched.",
		promptSnippet: "Find which pages of a PDF mention something",
		promptGuidelines: [
			"For any PDF too large to read whole, use pdf_search to find the relevant pages, then pdf_read those pages.",
			"Search is literal and case-insensitive by default; set regex true only if you need a pattern.",
			"The reported page list is what you pass to pdf_read's pages argument.",
		],
		parameters: PdfSearchParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const raw = params.path.startsWith("@") ? params.path.slice(1) : params.path;
			const abs = isAbsolute(raw) ? raw : resolvePath(ctx.cwd, raw);

			const doc = await loadPdf(abs);
			const result = searchPages(doc, params.query, {
				regex: params.regex === true,
				caseSensitive: params.case_sensitive === true,
				maxResults: params.max_results,
			});

			if (result.totalMatches === 0) {
				// Say WHY there may be nothing to find, or the agent concludes the
				// document does not cover the topic when it simply is not searchable.
				const hint =
					doc.sparsePages.length > 0
						? ` Note ${doc.sparsePages.length} page(s) have no text layer (${formatRanges(doc.sparsePages)}), so nothing on them is searchable.`
						: "";
				return {
					content: [
						{
							type: "text",
							text: `No matches for ${JSON.stringify(params.query)} in ${abs} (${doc.numpages} pages).${hint}`,
						},
					],
					details: { source: abs, query: params.query, totalMatches: 0, pagesMatched: [] },
				};
			}

			const lines: string[] = [];
			lines.push(
				`${result.totalMatches} match${result.totalMatches === 1 ? "" : "es"} on ` +
					`${result.pagesMatched.length} page${result.pagesMatched.length === 1 ? "" : "s"} ` +
					`in ${abs}` +
					(result.truncated ? ` (showing first ${result.hits.length})` : ""),
			);
			// The page list is the actionable part: it feeds straight into pdf_read.
			lines.push(`Pages: ${formatRanges(result.pagesMatched)}`);
			lines.push("");
			for (const hit of result.hits) lines.push(`p.${hit.page}: ${hit.snippet}`);
			lines.push("");
			lines.push(
				`Read them with pdf_read pages="${formatRanges(result.pagesMatched).replace(/, /g, ",")}"`,
			);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					source: abs,
					query: params.query,
					regex: params.regex === true,
					totalMatches: result.totalMatches,
					shown: result.hits.length,
					pagesMatched: result.pagesMatched,
					truncated: result.truncated,
					textPath: doc.textPath,
				},
			};
		},
	});
}
