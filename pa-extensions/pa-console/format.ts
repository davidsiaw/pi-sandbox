/**
 * pa-console/format.ts — events to lines, and the overflow file.
 *
 * The whole value of this tool is that ONE chronological stream mixes the
 * agent's own console.log with the page's errors and its failed requests. So
 * the formatting rule is: one event per line, fixed columns, relative time
 * first. No grouping by kind, no separate "your logs" section -- grouping is
 * exactly what destroys the causality that makes the stream readable.
 *
 *      t     kind      where          text
 *   402ms   http                     POST /api/order  500
 *   403ms   error     /app.js:42     Failed to fetch
 *
 * The cache file mirrors pa-yousoro-browse/cache.ts: a chatty dev build can emit
 * hundreds of events, and a tool result goes straight into the context window.
 * Inline stays small; the complete log is one `read` away.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsoleEvent } from "./session.ts";

/**
 * Width of the time column. Fits "999999ms" -- about 16 minutes on one page --
 * before a row starts pushing right, and a row that does is still readable.
 */
const TIME_W = 8;
/** Width of the kind column; the longest kind is "uncaught" at 8. */
const KIND_W = 8;
/** Width of the source column. Long paths overflow rather than truncate. */
const WHERE_W = 16;

export function formatEvent(ev: ConsoleEvent): string {
	// The unit is spelled out on every row rather than announced in a header: a
	// bare "402" in the leading column reads just as easily as a line number, an
	// index or a status code, and the one thing this stream has to convey at a
	// glance is when things happened relative to each other.
	const t = `${ev.t}ms`.padStart(TIME_W);
	const kind = ev.kind.padEnd(KIND_W);
	const where = (ev.where || "").padEnd(WHERE_W);
	const head = `${t}  ${kind} ${where} ${ev.text}`;
	if (!ev.extra || ev.extra.length === 0) return head;
	const indent = " ".repeat(TIME_W + 2 + KIND_W + 1 + WHERE_W + 1);
	return [head, ...ev.extra.map((l) => indent + l)].join("\n");
}

export function formatEvents(events: ConsoleEvent[]): string {
	return events.map(formatEvent).join("\n");
}

/**
 * Only errors matter for a quick verdict, so the receipt leads with a count.
 * `script` is excluded deliberately: it is the caller's own broken snippet, not
 * evidence about the page, and folding it into the error count would make an
 * agent think it had found a bug in the app.
 */
export function countErrors(events: ConsoleEvent[]): number {
	return events.filter((e) => e.kind === "uncaught" || e.kind === "error" || e.kind === "http")
		.length;
}

export function cacheFileName(now: Date = new Date()): string {
	const ts = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
	const rand = Math.random().toString(16).slice(2, 6);
	return `pa-console-${ts}-${rand}.txt`;
}

export interface CacheInfo {
	path: string;
	lines: number;
}

/** Write the full log. Throws on IO failure; callers degrade rather than fail. */
export function writeLogCache(dir: string, url: string | null, events: ConsoleEvent[]): CacheInfo {
	const header = `=== pa-console log === ${url ?? "(no page)"} — ${events.length} events`;
	const body = formatEvents(events);
	const content = `${header}\n${body}\n`;
	const path = join(dir, cacheFileName());
	writeFileSync(path, content, "utf8");
	return { path, lines: events.length + 1 };
}

/** "6m12s" — uptime in a receipt should be readable, not a millisecond count. */
export function humanDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return `${m}m${rem}s`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}
