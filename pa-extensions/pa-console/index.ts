/**
 * pa-console
 *
 * A REPL against ONE live browser page: send JS, read what comes out of the
 * console, screenshot the state you drove it into.
 *
 * WHY THIS EXISTS ALONGSIDE screenshot_url AND yousoro_browse
 * Those are one-shot: launch, load, read, close. Neither can express "click
 * this, THEN look", which is the shape of nearly every real bug report ("I
 * press Pay and nothing happens"). A fresh load can only ever show the initial
 * state. This tool holds the page open, so the agent can drive it and then
 * inspect the consequences -- including a screenshot of post-interaction state,
 * which was previously impossible.
 *
 * It is aimed at pages the agent itself wrote, on localhost. That is why none
 * of the fingerprint masking from ../_shared/stealth.ts is used here: it is
 * overhead against your own dev server, and its "is this a bot-block?" heuristic
 * could fire on a page that merely contains the word "blocked".
 *
 * THE THREE TOOLS
 *   page_console(url?, script?)   open / drive / drain the live page
 *   page_screenshot(path?)        capture its CURRENT state
 *   page_close()                  release the browser early
 *
 * Separate tools rather than flags on one, because they are separate verbs. You
 * screenshot without evaluating, and evaluate without screenshotting; folding
 * either into an optional boolean on the other makes both descriptions worse.
 *
 * WHAT IT IS EQUIVALENT TO
 * Opening the page in Chrome and typing into the DevTools console: same JS
 * realm, same DOM, same globals, `await` works, return values come back, and
 * the message text is literally DevTools' preview string. It differs in four
 * ways worth knowing -- fresh profile with no extensions or cookies, objects
 * arrive as a flat preview (`{id: 7, items: Array(2)}`) rather than an
 * expandable tree, DOM nodes degrade to `JSHandle@node`, and top-level `const`
 * does not persist between calls (put REPL state on `window`).
 *
 * WHERE THE USAGE DOCS LIVE
 * The how-to -- the REPL loop, the `window`-state rule, the JSHandle@node trap,
 * DOM geometry vs detect_ui_elements, recipes -- lives in the `pa-console`
 * SKILL (pa-skills/pa-console/SKILL.md), not in these tool descriptions.
 *
 * Descriptions and promptGuidelines sit in the system prompt of EVERY session,
 * whether or not a browser is ever opened; a skill body is loaded on demand.
 * So the descriptions here carry only what decides WHEN to reach for the tool,
 * and point at the skill for HOW. Moving the seven-bullet guideline block into
 * the skill cut ~1.2KB of always-resident prompt. Keep it that way: if you find
 * yourself adding a third guideline bullet, it belongs in the skill.
 *
 * Playwright is not bundled; it is resolved from the global install baked into
 * the pa image. See docs/console-repl.md.
 */

import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { countErrors, formatEvents, humanDuration, writeLogCache } from "./format.ts";
import {
	type ConsoleEvent,
	currentUrl,
	drain,
	evaluate,
	hasPage,
	open,
	screenshot,
	settle,
	shutdown,
	status,
} from "./session.ts";

/**
 * Inline event ceiling. Past this the receipt names the cache file instead of
 * pasting a wall of text into the context window. Head-first, matching
 * pa-yousoro-browse: the first events of a turn are the ones that explain it.
 */
const MAX_INLINE_EVENTS = 120;

/**
 * Default pause between running a snippet and draining. Long enough for a
 * microtask, a fetch on localhost and a paint; short enough not to feel like a
 * stall. Anything slower than this is not lost -- it lands in the buffer and is
 * delivered on the next call, which is the whole point of holding the page open.
 */
const DEFAULT_SETTLE_MS = 300;

function renderDrain(events: ConsoleEvent[], dropped: number, cwd: string): string {
	if (events.length === 0 && dropped === 0) return "(no new console output)";

	const parts: string[] = [];
	if (dropped > 0) {
		parts.push(`(${dropped} older events dropped -- buffer full)`);
	}

	if (events.length > MAX_INLINE_EVENTS) {
		const shown = events.slice(0, MAX_INLINE_EVENTS);
		parts.push(formatEvents(shown));
		let note = `... ${events.length - MAX_INLINE_EVENTS} more events not shown inline.`;
		try {
			const cache = writeLogCache(tmpdir(), currentUrl(), events);
			note += `\nFull log: ${cache.path}`;
		} catch {
			note += " (could not write the full log to a file)";
		}
		parts.push(note);
	} else {
		parts.push(formatEvents(events));
	}

	const errors = countErrors(events);
	if (errors > 0) parts.push(`\n${errors} error/failed-request event(s) above.`);
	// cwd is unused for now but kept in the signature: a future "write the log
	// next to the project" option belongs here rather than in the tool body.
	void cwd;
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Screenshot path policy (same rules as pa-screenshot, same reasons)
// ---------------------------------------------------------------------------

interface OutPath {
	absolute: string;
	insideProject: boolean;
}

function defaultShotName(): string {
	const ts = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\..+$/, "")
		.replace("T", "-");
	return `page-${ts}.png`;
}

function resolveOutPath(cwd: string, requested: string): OutPath {
	if (extname(requested).toLowerCase() !== ".png") {
		throw new Error(`path must end in .png (got "${requested}"). Screenshots are written as PNG.`);
	}
	const absolute = isAbsolute(requested) ? requested : resolvePath(cwd, requested);
	const rel = relative(cwd, absolute);
	const insideProject = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	if (!isAbsolute(requested) && !insideProject) {
		throw new Error(
			`path "${requested}" escapes the project directory. Use a path inside the ` +
				`project, or pass an absolute path if you really mean to write outside it.`,
		);
	}
	return { absolute, insideProject };
}

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const CONSOLE_PARAMS = Type.Object({
	url: Type.Optional(
		Type.String({
			description:
				"Load this URL in a FRESH page, discarding the current one entirely " +
				"(including its cookies and localStorage). Omit to keep working with the " +
				"page that is already open.",
		}),
	),
	script: Type.Optional(
		Type.String({
			description:
				"JavaScript to run in the page, exactly as if typed into the DevTools " +
				"console: same DOM, same globals, top-level await allowed, and a `return` " +
				"value is reported back. State must be stored on `window` to survive to the " +
				"next call -- a top-level `const` or `let` does NOT persist.",
		}),
	),
	width: Type.Optional(
		Type.Number({ description: "Viewport width for a newly opened page. Default 1280." }),
	),
	height: Type.Optional(
		Type.Number({ description: "Viewport height for a newly opened page. Default 800." }),
	),
	settle_ms: Type.Optional(
		Type.Number({
			description:
				"Pause before collecting output, to let the page react. Default 300. " +
				"Late events are never lost -- they arrive on a later call.",
		}),
	),
});

const SHOT_PARAMS = Type.Object({
	path: Type.Optional(
		Type.String({
			description:
				"Where to write the PNG. Must end in .png. Relative paths resolve against " +
				"the project directory and persist on the host; absolute paths outside it " +
				"are lost when the sandbox exits. Default: ./page-<timestamp>.png. " +
				"Refuses to overwrite an existing file.",
		}),
	),
	full_page: Type.Optional(
		Type.Boolean({
			description: "Capture the entire scrollable page instead of just the viewport. Default false.",
		}),
	),
	selector: Type.Optional(
		Type.String({ description: "Capture only the element matching this CSS selector." }),
	),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function paConsoleExtension(pi: ExtensionAPI) {
	// The browser is started lazily, inside the tool, never in this factory:
	// extension factories run in invocations that never start a session, and pi
	// is explicit that background resources must not be started here.
	pi.on("session_shutdown", async () => {
		await shutdown();
	});

	pi.registerTool({
		name: "page_console",
		label: "Page console (REPL)",
		description:
			"Drive ONE live browser page and read its console output. Pass url= to load a " +
			"fresh page, script= to run JS in it (like typing into the DevTools console), or " +
			"neither to collect whatever the page has logged since the last call. Returns one " +
			"chronological stream mixing your own console.log with the page's errors, uncaught " +
			"exceptions and 4xx/5xx responses. The page STAYS OPEN between calls, so unlike " +
			"screenshot_url/yousoro_browse you can click something and then inspect what " +
			"happened. Read the `pa-console` skill for how to use it.",
		promptSnippet: "Open one live page, run JS in it repeatedly, and read the console output",
		promptGuidelines: [
			"Use page_console to debug a page you can drive (localhost app, a page you wrote): load it with url=, then send script= snippets and read the console stream.",
			"Read the `pa-console` skill before using it — it covers the REPL loop, why state must go on `window`, and the traps that silently waste a debugging session.",
		],
		parameters: CONSOLE_PARAMS,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const onProgress = (msg: string) => onUpdate?.({ content: [{ type: "text", text: msg }] });

			if (!params.url && !params.script && !hasPage()) {
				return {
					content: [
						{
							type: "text",
							text:
								"No page is open. Call page_console with url=\"http://localhost:3000/\" " +
								"(or whatever you want to debug) first.",
						},
					],
					isError: true,
				};
			}

			if (params.url) {
				try {
					onProgress(`Opening ${params.url}...`);
					await open({
						url: params.url,
						width: params.width,
						height: params.height,
					});
				} catch (err) {
					return {
						content: [
							{
								type: "text",
								text: `Could not open ${params.url}: ${err instanceof Error ? err.message : String(err)}`,
							},
						],
						isError: true,
					};
				}
			}

			if (params.script) {
				if (!hasPage()) {
					return {
						content: [
							{ type: "text", text: "The page is gone (crashed or closed). Re-open it with url=." },
						],
						isError: true,
					};
				}
				onProgress("Running script in page...");
				// evaluate() records a caller-side throw as a `script` event rather
				// than raising: the events collected before it usually explain it.
				await evaluate(params.script);
			}

			try {
				await settle(params.settle_ms ?? DEFAULT_SETTLE_MS);
			} catch {
				// A page that dies mid-settle is reported by the drain below.
			}

			const { events, dropped } = drain();
			const st = status();
			const body = renderDrain(events, dropped, ctx.cwd);

			return {
				content: [{ type: "text", text: `${st.url ?? "(no page)"}\n${body}` }],
				details: {
					url: st.url,
					events: events.length,
					errors: countErrors(events),
					dropped,
					viewport: st.viewport,
				},
			};
		},
	});

	pi.registerTool({
		name: "page_screenshot",
		label: "Screenshot live page",
		description:
			"Save a PNG of the page page_console currently has open, in its CURRENT state — " +
			"after whatever clicks or scripts you have run. screenshot_url cannot do this: it " +
			"always reloads, so it only ever captures the initial state. Returns the file " +
			"path, not the image. See the `pa-console` skill.",
		promptSnippet: "Screenshot the live page_console page in its current, post-interaction state",
		promptGuidelines: [
			"Use page_screenshot to see the state you drove the page into with page_console — screenshot_url cannot, it reloads. Prefer a relative path so the PNG persists on the host.",
		],
		parameters: SHOT_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!hasPage()) {
				return {
					content: [
						{ type: "text", text: "No page is open. Use page_console with url= first." },
					],
					isError: true,
				};
			}

			let out: OutPath;
			try {
				out = resolveOutPath(ctx.cwd, params.path ?? defaultShotName());
			} catch (err) {
				return {
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					isError: true,
				};
			}

			// Refuse to clobber, and say what to do instead -- same policy as
			// pa-screenshot, so there is one rule to remember, not two.
			if (existsSync(out.absolute)) {
				return {
					content: [
						{
							type: "text",
							text:
								`A file already exists at ${out.absolute} and page_screenshot will not ` +
								`overwrite it.\nRetry with e.g. path="${out.absolute.replace(/\.png$/i, "-2.png")}".`,
						},
					],
					isError: true,
				};
			}
			try {
				if (statSync(out.absolute).isDirectory()) {
					return {
						content: [{ type: "text", text: `${out.absolute} is a directory, not a file path.` }],
						isError: true,
					};
				}
			} catch {
				// ENOENT is the expected, good case.
			}

			try {
				await screenshot({
					path: out.absolute,
					fullPage: params.full_page,
					selector: params.selector,
				});
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `page_screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
				};
			}

			const lines = [`Saved ${out.absolute}`, `Page: ${currentUrl() ?? "(unknown)"}`];
			if (!out.insideProject) {
				lines.push(
					"WARNING: outside the project directory, so this file is LOST when the sandbox exits.",
				);
			}
			lines.push(`To view it, call inspect_image with image="${out.absolute}".`);
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { path: out.absolute, insideProject: out.insideProject, url: currentUrl() },
			};
		},
	});

	pi.registerTool({
		name: "page_close",
		label: "Close live page",
		description:
			"Close the browser page_console is holding open and free its memory (an idle " +
			"headless Chromium holds several hundred MB). Safe to call at any time, including " +
			"when nothing is open. Undrained console output is written to a file first, so " +
			"closing never destroys evidence.",
		promptSnippet: "Close the live page_console browser and free its memory",
		promptGuidelines: [
			"Call page_close when you are done debugging a page — an idle browser holds several hundred MB for the rest of the session. Safe to call even if nothing is open.",
		],
		parameters: Type.Object({}),
		async execute() {
			if (!status().running) {
				return { content: [{ type: "text", text: "No browser running." }], details: { closed: false } };
			}
			// Flush before closing: shutting down should never be the reason a
			// clue disappeared, or agents will hesitate to call it.
			let cachePath: string | null = null;
			try {
				const { events } = drain();
				if (events.length > 0) {
					cachePath = writeLogCache(tmpdir(), currentUrl(), events).path;
				}
			} catch {
				// Best effort; failing to write the log must not block the close.
			}

			const final = await shutdown();
			const lines = final
				? [
						`Closed browser. Last page: ${final.url ?? "(none)"}`,
						`Open for ${humanDuration(final.uptimeMs)}, ${final.pagesOpened} page(s), ` +
							`${final.totalEvents} console event(s).`,
					]
				: ["No browser running."];
			if (cachePath) lines.push(`Undrained log written to ${cachePath}`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: { closed: true } };
		},
	});

	// --- Human-facing commands ---------------------------------------------
	// The browser is otherwise invisible from outside the conversation; these
	// let the user notice one the agent forgot about, and kill it.
	pi.registerCommand("page-status", {
		description: "Show the live browser page pa-console is holding, if any",
		handler: async (_args, ctx) => {
			const st = status();
			if (!st.running) {
				ctx.ui.notify("pa-console: no browser running.", "info");
				return;
			}
			ctx.ui.notify(
				`pa-console: ${st.url ?? "(no page)"} — open ${humanDuration(st.uptimeMs)}, ` +
					`${st.pagesOpened} page(s), ${st.totalEvents} event(s), ` +
					`viewport ${st.viewport.width}x${st.viewport.height}`,
				"info",
			);
		},
	});

	pi.registerCommand("page-close", {
		description: "Close the live browser page pa-console is holding",
		handler: async (_args, ctx) => {
			const final = await shutdown();
			ctx.ui.notify(
				final
					? `pa-console: closed (${final.url ?? "no page"}, open ${humanDuration(final.uptimeMs)}).`
					: "pa-console: no browser running.",
				"info",
			);
		},
	});
}
