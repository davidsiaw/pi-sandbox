/**
 * pa-yousoro-browse/cache.ts — spill the full fetch to a file, preview inline.
 *
 * WHY THIS EXISTS
 * A tool result goes straight into the context window, so a big page is
 * expensive and a huge extracted link list can swamp the whole conversation.
 * The old behaviour had two separate failures:
 *
 *   1. `extract` was UNCAPPED. `extract="a"` on a link-dense page emitted every
 *      match — thousands of lines, no ceiling.
 *   2. Page text was capped by `max_chars` and the remainder was simply GONE.
 *      Truncation is head-first, so on a long page it is exactly the bottom
 *      that disappears — and scrolling had already paid to load it. The only
 *      recovery was re-fetching with a bigger max_chars.
 *
 * So: always write the complete result to a file, always tell the caller where
 * it is and what it could not see. Truncation stops being lossy because the
 * remainder is one `read`/`rg` away, and the inline budget can stay small.
 *
 * This mirrors pi's own bash tool, which truncates inline and writes the full
 * output to /tmp/pi-bash-<id>.log with a footer naming the path. Same mental
 * model, so there is nothing new for an agent to learn.
 *
 * WHY ALWAYS, RATHER THAN ONLY WHEN BIG
 * A threshold means two code paths and a judgement call. Writing always costs
 * one file write and one line of output; when nothing was truncated the caller
 * just ignores the path. The extra read happens only when content was actually
 * cut, which is precisely when it is wanted.
 *
 * The truncation helper is deliberately a local ~30 lines rather than an import
 * of pi's dist/core/tools/truncate.js: that path is internal and not exported
 * from the package root, and this tool is used constantly enough that a silent
 * upstream breakage would be costly. Wording is modelled on it.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ExtractedItem {
	text: string;
	attr?: string;
}

export interface Truncation {
	/** The content to show inline. */
	content: string;
	truncated: boolean;
	shownChars: number;
	totalChars: number;
	shownLines: number;
	totalLines: number;
}

/** Count lines the way a `wc -l`-style reader would: a trailing \n adds none. */
export function countLines(content: string): number {
	if (content.length === 0) return 0;
	const n = content.split("\n").length;
	return content.endsWith("\n") ? n - 1 : n;
}

/**
 * Keep the first `maxChars` characters, never cutting mid-line.
 *
 * Head-first because the top of a page is usually the useful part; the caller
 * is told the totals so it can jump to the tail in the cache file instead of
 * guessing that it saw everything.
 */
export function truncateHead(content: string, maxChars: number): Truncation {
	const totalChars = content.length;
	const totalLines = countLines(content);
	if (totalChars <= maxChars) {
		return {
			content,
			truncated: false,
			shownChars: totalChars,
			totalChars,
			shownLines: totalLines,
			totalLines,
		};
	}
	// Back off to the last newline inside the budget so the preview ends on a
	// whole line. A single line longer than the budget has no newline to find,
	// in which case a hard cut is the only option.
	let cut = content.lastIndexOf("\n", maxChars);
	if (cut <= 0) cut = maxChars;
	const shown = content.slice(0, cut);
	return {
		content: shown,
		truncated: true,
		shownChars: shown.length,
		totalChars,
		shownLines: countLines(shown),
		totalLines,
	};
}

/**
 * One item per line as `text<TAB>attr`.
 *
 * TSV rather than the pretty numbered form used inline, because the file exists
 * to be sliced by `rg`/`cut`, and those need one record per line. Embedded tabs
 * and newlines in link text would break that invariant, so they collapse to
 * spaces.
 */
export function tsvLine(item: ExtractedItem): string {
	const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();
	return item.attr === undefined ? clean(item.text) : `${clean(item.text)}\t${clean(item.attr)}`;
}

export interface CacheDocument {
	content: string;
	totalLines: number;
	/** 1-indexed [first, last] line of the TSV rows, if any were written. */
	extractedRange?: [number, number];
	/** 1-indexed [first, last] line of the page text, if non-empty. */
	pageTextRange?: [number, number];
}

export interface CacheInput {
	extract?: string;
	extractAttr?: string;
	extracted?: ExtractedItem[];
	text: string;
}

/**
 * Assemble the cache file: labelled sections with known line ranges, so the
 * caller can `read offset=` straight into the part it wants.
 *
 * Ranges point at the DATA lines, not the `===` marker, so an offset taken from
 * the report lands on content rather than a header.
 */
export function buildCacheDocument(input: CacheInput): CacheDocument {
	const lines: string[] = [];
	let extractedRange: [number, number] | undefined;
	let pageTextRange: [number, number] | undefined;

	if (input.extracted && input.extracted.length > 0) {
		const attrNote = input.extractAttr ? ` attr ${JSON.stringify(input.extractAttr)}` : "";
		lines.push(
			`=== EXTRACTED === selector ${JSON.stringify(input.extract ?? "")}${attrNote} — ` +
				`${input.extracted.length} items — TSV: text<TAB>attr`,
		);
		const start = lines.length + 1;
		for (const item of input.extracted) lines.push(tsvLine(item));
		extractedRange = [start, lines.length];
		lines.push("");
	}

	lines.push(`=== PAGE TEXT === ${input.text.length} chars`);
	if (input.text.length > 0) {
		const start = lines.length + 1;
		const body = input.text.endsWith("\n") ? input.text.slice(0, -1) : input.text;
		for (const line of body.split("\n")) lines.push(line);
		pageTextRange = [start, lines.length];
	}

	const content = `${lines.join("\n")}\n`;
	return { content, totalLines: lines.length, extractedRange, pageTextRange };
}

/**
 * Filename carries the host and a timestamp so repeated fetches are
 * distinguishable at a glance; the random suffix stops two fetches of the same
 * host in the same second from clobbering each other.
 */
export function cacheFileName(rawUrl: string, now: Date = new Date()): string {
	let host = "page";
	try {
		const h = new URL(rawUrl).hostname.replace(/^www\./, "").replace(/[^a-zA-Z0-9.-]/g, "-");
		if (h) host = h;
	} catch {
		// keep the fallback
	}
	const ts = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
	const rand = Math.random().toString(16).slice(2, 6);
	return `pa-browse-${host}-${ts}-${rand}.txt`;
}

export interface CacheInfo extends CacheDocument {
	path: string;
	bytes: number;
}

/** Write the cache file. Throws on IO failure; the caller degrades gracefully. */
export function writeCache(dir: string, rawUrl: string, input: CacheInput): CacheInfo {
	const doc = buildCacheDocument(input);
	const path = join(dir, cacheFileName(rawUrl));
	writeFileSync(path, doc.content, "utf8");
	return { ...doc, path, bytes: Buffer.byteLength(doc.content, "utf8") };
}
