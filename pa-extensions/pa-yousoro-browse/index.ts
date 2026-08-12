/**
 * pa-yousoro-browse
 *
 * "Yousoro" (宜候) — the helmsman's "steady as she goes". This tool keeps a
 * steady course past bot-blocks.
 *
 * Registers a `yousoro_browse` tool that fetches a web page using a
 * fingerprint-masked headless Chromium (Playwright), with retry + backoff to
 * defeat bot/rate-limit blocks (e.g. Reddit's "blocked by network security").
 *
 * The masking layers, the Xvfb headed-mode helper, and the block/challenge
 * detection live in ../_shared/stealth.ts, shared with pa-screenshot. See that
 * file for why detection reads VISIBLE text (title + innerText) and never raw
 * HTML — Cloudflare's 403-then-redirect leaves its challenge <script> tags in
 * the DOM of the *cleared* page, so matching HTML yields false positives.
 *
 * Notes:
 *   - JS already runs in Chromium; "Just a moment" is a Cloudflare challenge,
 *     not a JS-disabled problem. The fix is to wait for it to auto-solve and
 *     redirect.
 *   - The CDP Runtime.enable leak is already fixed upstream in the bundled
 *     Playwright, so no CDP patch is applied here.
 *   - Not addressed: TLS/JA3 fingerprint and IP reputation (network layer,
 *     unreachable from page JS). Image CAPTCHAs and the hardest managed
 *     challenges are reported as blocked so the caller can move on.
 *
 * WHERE THE USAGE DOCS LIVE
 * The how-to -- which search engines answer from this IP, link harvesting with
 * extract=, bounded BFS, the /tmp cache files, what to do when a page is still
 * blocked -- lives in the `web-search` SKILL (pa-skills/web-search/SKILL.md),
 * not in this tool's description or guidelines.
 *
 * Descriptions and promptGuidelines sit in the system prompt of EVERY session,
 * whether or not a page is ever fetched; a skill body is loaded on demand. So
 * what is here carries only what decides WHEN to reach for the tool, and points
 * at the skill for HOW. Collapsing eleven guideline bullets into two cut ~380
 * tokens of always-resident prompt, most of which restated the skill verbatim
 * while telling the model to go read it. Keep it that way: a new bullet about
 * HOW belongs in the skill.
 *
 * Playwright is not bundled; it is resolved from the global install baked into
 * the pa image (/usr/lib/node_modules/playwright), with the Chromium browsers
 * at /opt/ms-playwright. See docs/yousoro-browsing.md.
 */

import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type CacheInfo,
	formatCacheFailure,
	formatCacheFooter,
	truncateHead,
	writeCache,
} from "../_shared/cache.ts";
import { cloakAvailable, cloakDumpDom, titleOf } from "../_shared/cloak.ts";
import { htmlToMarkdown, htmlToText } from "../_shared/html-to-markdown.ts";
import { domToMarkdown } from "./markdown.ts";
import {
	type Chromium,
	type VirtualDisplay,
	chromeMajor,
	ensureDisplay,
	humanize,
	loadChromium,
	looksBlocked,
	looksChallenge,
	looksHopeless,
	makeYousoroInitScript,
	secChUa,
	visibleText,
	waitOutChallenge,
	yousoroUserAgent,
} from "../_shared/stealth.ts";

// ---------------------------------------------------------------------------
// Yousoro fetch
// ---------------------------------------------------------------------------

interface ExtractedItem {
	text: string;
	attr?: string;
}

interface FetchOptions {

	url: string;
	extract?: string;
	extractAttr?: string;
	waitMs: number;
	maxAttempts: number;
	scroll: number;
	scrollWaitMs: number;
	timezone: string;
	challengeWaitMs: number;
	headed: boolean;
	humanize: boolean;
	format: "text" | "markdown" | "html";
}

interface FetchResult {
	status: number | null;
	title: string;
	finalUrl: string;
	attempts: number;
	blocked: boolean;
	text: string;
	/** The serialised DOM, always captured so the raw markup can be cached. */
	html: string;
	extracted?: ExtractedItem[];
	/** Which fetcher produced the content that is being returned. */
	engine: "yousoro" | "cloakbrowser";
	/** Set when escalation was attempted but could not be used. */
	escalationNote?: string;
}

async function yousoroFetch(
	chromium: Chromium,
	opts: FetchOptions,
	signal: AbortSignal | undefined,
	onProgress: (msg: string) => void,
): Promise<FetchResult> {
	let vdisplay: VirtualDisplay | undefined;
	if (opts.headed) {
		vdisplay = await ensureDisplay(onProgress);
	}

	const browser = await chromium.launch({
		headless: !opts.headed,
		...(vdisplay ? { env: { ...process.env, DISPLAY: vdisplay.display } } : {}),
		args: [
			"--no-sandbox",
			"--disable-blink-features=AutomationControlled",
			"--disable-features=IsolateOrigins,site-per-process",
		],
	});

	try {
		// Derive one consistent Chrome identity from the real bundled engine so
		// the UA string, Sec-CH-UA header, and navigator.userAgentData all agree.
		const major = chromeMajor(browser.version());

		const context = await browser.newContext({
			userAgent: yousoroUserAgent(major),
			locale: "en-US",
			timezoneId: opts.timezone,
			viewport: { width: 1280, height: 800 },
			// NOTE: do NOT override the `Accept` header. Forcing a custom Accept
			// makes some sites (Reddit) serve a minimal SSR fallback (few items).
			// Let Chromium send its native Accept; only add the safe hints below.
			extraHTTPHeaders: {
				"Accept-Language": "en-US,en;q=0.9",
				"sec-ch-ua": secChUa(major),
				"sec-ch-ua-mobile": "?0",
				"sec-ch-ua-platform": '"macOS"',
			},
		});
		await context.addInitScript(makeYousoroInitScript(major));
		const page = await context.newPage();

		let status: number | null = null;
		let blocked = false;
		let attempt = 0;

		for (attempt = 1; attempt <= opts.maxAttempts; attempt++) {
			if (signal?.aborted) throw new Error("aborted");
			onProgress(`Attempt ${attempt}/${opts.maxAttempts}: ${opts.url}`);

			const resp = await page.goto(opts.url, {
				waitUntil: "domcontentloaded",
				timeout: 30000,
			});
			status = resp ? resp.status() : null;
			await page.waitForTimeout(opts.waitMs);

			// Emit some human-ish mouse/scroll interaction before reading the page,
			// so behavior-scoring gates don't see a zero-interaction session.
			if (opts.humanize) await humanize(page, signal);

			// Detection uses VISIBLE text (title + innerText), never raw HTML — see
			// the note on CHALLENGE_MARKERS about Cloudflare's 403-then-redirect
			// leaving challenge <script> tags in the DOM of the cleared page.
			let title = await page.title();
			let vtext = await visibleText(page);

			// Cloudflare "403-then-redirect" interstitial: it serves the challenge
			// first (often HTTP 403), runs its JS fingerprint check, and redirects
			// to the real page if we pass. Wait for the visible interstitial to
			// clear before deciding it's blocked. If it clears, the initial 403 was
			// just the challenge gate, so treat the outcome as 200.
			if (looksChallenge(title, vtext)) {
				vtext = await waitOutChallenge(page, opts.challengeWaitMs, onProgress);
				title = await page.title();
				status = looksChallenge(title, vtext) ? status : 200;
			}

			blocked = looksBlocked(status, vtext) || looksChallenge(title, vtext);

			if (!blocked) break;

			// Retrying an IP-reputation verdict or a human-solvable puzzle returns the
			// identical page, so stop after the first look and let escalation (a
			// different engine, different fingerprint) be the thing that gets tried.
			if (looksHopeless(vtext)) {
				onProgress("Blocked in a way retrying cannot fix; not backing off.");
				break;
			}

			// ONE backoff, then let escalation take over. maxAttempts defaults to 2.
			//
			// It used to be 4, which cost 27s of sleeping (6+9+12s) plus three extra
			// page loads before CloakBrowser was ever tried. That ordering was
			// backwards: a second identical request rarely changes a block, whereas a
			// different engine with a different fingerprint sometimes does. So the
			// cheap retry (for a genuinely transient hiccup) happens once, and after
			// that the budget goes to the thing that might actually work.
			if (attempt < opts.maxAttempts) {
				const backoff = 3000 + attempt * 3000;
				onProgress(`Blocked (status ${status}). Backing off ${backoff}ms once...`);
				await page.waitForTimeout(backoff);
			}
		}

		// Auto-scroll to trigger lazy-loaded content (infinite-scroll feeds).
		if (opts.scroll > 0 && !blocked) {
			for (let i = 0; i < opts.scroll; i++) {
				if (signal?.aborted) throw new Error("aborted");
				onProgress(`Scrolling ${i + 1}/${opts.scroll}...`);
				await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
				await page.waitForTimeout(opts.scrollWaitMs);
			}
		}

		const title = await page.title();
		const finalUrl = page.url();
		// innerText is flat: it loses headings, list nesting and every link URL.
		// markdown keeps them, at the cost of running a DOM walk in the page.
		const html: string = await page.content();
		const text: string =
			opts.format === "html"
				? html
				: opts.format === "markdown"
					? await page.evaluate(domToMarkdown)
					: await page.evaluate(() => document.body?.innerText ?? "");

		let extracted: ExtractedItem[] | undefined;
		if (opts.extract) {
			extracted = await page.$$eval(
				opts.extract,
				(els: Element[], attrName: string | undefined) =>
					els
						.map((el) => {
							const text = (el as HTMLElement).innerText?.trim() ?? "";
							if (!attrName) return { text };
							// For href/src, prefer the resolved absolute URL from the
							// live property (element.href) over the raw attribute.
							// biome-ignore lint/suspicious/noExplicitAny: dynamic prop access
							const live = (el as any)[attrName];
							const attr =
								typeof live === "string" && live
									? live
									: (el.getAttribute(attrName) ?? undefined);
							return { text, attr };
						})
						// Keep items that have either visible text or the requested attr.
						.filter((it) => it.text || it.attr),
				opts.extractAttr,
			);
		}

		return {
			status,
			title,
			finalUrl,
			// The loop counter runs one past the last attempt when every attempt was
			// blocked, which reported "Attempts: 5" for a maxAttempts=4 fetch.
			attempts: Math.min(attempt, opts.maxAttempts),
			blocked,
			text,
			html,
			extracted,
			engine: "yousoro",
		};
	} finally {
		await browser.close();
		vdisplay?.dispose();
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const PARAMS = Type.Object({
	url: Type.String({ description: "The URL to fetch (must be http/https)." }),
	extract: Type.Optional(
		Type.String({
			description:
				"Optional CSS selector. When set, returns innerText of every matching element as a list.",
		}),
	),
	extract_attr: Type.Optional(
		Type.String({
			description:
				"Optional attribute name to also return for each matched element, " +
				'e.g. "href" (link URLs) or "src". For href/src the value is the ' +
				"resolved absolute URL. Pair with extract=\"a\" to collect links.",
		}),
	),
	wait_ms: Type.Optional(
		Type.Number({
			description: "Milliseconds to wait after load for JS to settle. Default 2500.",
		}),
	),
	max_attempts: Type.Optional(
		Type.Number({
			description:
				"Max attempts with backoff when the page looks blocked. Default 2: one retry, " +
				"then escalate to CloakBrowser, which is likelier to help than a third try.",
		}),
	),
	scroll: Type.Optional(
		Type.Number({
			description:
				"Number of scroll-to-bottom passes to trigger lazy-loaded content " +
				"(infinite-scroll feeds like Reddit). Default 0 (no scrolling).",
		}),
	),
	scroll_wait_ms: Type.Optional(
		Type.Number({
			description: "Milliseconds to wait after each scroll pass. Default 1500.",
		}),
	),
	challenge_wait_ms: Type.Optional(
		Type.Number({
			description:
				"Max time to wait for a Cloudflare/interstitial challenge (\"Just a moment\") " +
				"to auto-solve and redirect to the real page. Default 20000.",
		}),
	),
	headed: Type.Optional(
		Type.Boolean({
			description:
				"Run a headed (non-headless) Chromium behind a virtual X display (Xvfb). " +
				"Headless leaves many detectable tells; headed mode removes a class of them " +
				"and clears more Cloudflare challenges. Slower to start. Default false.",
		}),
	),
	humanize: Type.Optional(
		Type.Boolean({
			description:
				"Emit brief human-ish mouse movement and scroll before reading the page, " +
				"so behavior-scoring anti-bot gates don't see a zero-interaction session. " +
				"Adds ~1s. Default true; set false for the fastest possible fetch.",
		}),
	),
	format: Type.Optional(
		// Type.Enum(map, options) is the shape this typebox build supports — there is
		// no Type.StringEnum. Same call as pa-cloakbrowser's `format`.
		Type.Enum({ markdown: "markdown", text: "text", html: "html" }, {
			default: "markdown",
			description:
				'How to render the page. "markdown" (default) keeps headings, lists, ' +
				"tables, code blocks and \u2014 the useful part \u2014 link URLs inline as " +
				"[text](url), so one fetch gives both the prose and where to go next; " +
				'hidden elements (menus, cookie banners) are skipped. "text" is flat ' +
				'innerText. "html" is the raw DOM \u2014 rarely needed inline, since the raw ' +
				"DOM is ALWAYS written to a sibling .html cache file whose path is reported.",
		}),
	),
	escalate: Type.Optional(
		Type.Boolean({
			description:
				"When the fetch ends up blocked, automatically retry it with CloakBrowser " +
				"(stealth Chromium, C++ patches) before giving up, and return that content " +
				"instead. Default true. Costs nothing on a normal fetch \u2014 it only runs " +
				"after a block. Set false to see the raw block instead.",
		}),
	),
	max_chars: Type.Optional(
		Type.Number({
			description:
				"Inline budget for page text, in characters. Default 8000. The COMPLETE " +
				"text is always written to the cache file regardless, so raising this is " +
				"rarely necessary \u2014 read or grep the file instead.",
		}),
	),
	max_items: Type.Optional(
		Type.Number({
			description:
				"Inline budget for the `extract` list, in items. Default 50. The COMPLETE " +
				"list is always written to the cache file as TSV.",
		}),
	),
});

export default function paYousoroBrowseExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "yousoro_browse",
		label: "Yousoro Browse",
		description:
			"CRITICAL: Load the 'web-search' skill first for search/browsing guidance. " +
			"Fetch a web page with a fingerprint-masked headless Chromium, waiting out " +
			"Cloudflare \"Just a moment\" challenges and retrying on bot/rate-limit " +
			"blocks, so it reads pages that reject plain headless browsers with " +
			"403/429/503 (Reddit, Cloudflare-fronted sites). If a page is still blocked " +
			"it escalates to CloakBrowser by itself and says which engine won, so a " +
			"block needs no follow-up call. Returns Markdown with link URLs inline as " +
			"[text](url), and always writes the full body and raw DOM to /tmp, reporting " +
			"both paths, so nothing is lost to truncation. Read the 'web-search' skill " +
			"for how to drive it.",
		promptSnippet: "Fetch a web page past bot-blocks using the yousoro headless browser",
		// Two bullets, both about WHEN to reach for it. Everything about HOW --
		// caching, extract, scroll, truncation, escalation, engine choice -- lives in
		// the web-search skill, loaded on demand instead of riding in every system
		// prompt. See the WHERE THE USAGE DOCS LIVE note in the header.
		promptGuidelines: [
			"Use yousoro_browse for anything web: fetching a URL, reading a page, searching, verifying a fact. Never curl/wget/fetch/ad-hoc Playwright -- this is a datacenter IP and those get blocked (403/429/503).",
			"READ THE 'web-search' SKILL FIRST for any search or multi-page research. It covers which engines work from here, link harvesting, bounded BFS, the /tmp cache files, and what to do when a page is still blocked.",
		],
		parameters: PARAMS,
		async execute(_toolCallId, params, signal, onUpdate) {
			let url: URL;
			try {
				url = new URL(params.url);
			} catch {
				return {
					content: [{ type: "text", text: `Invalid URL: ${params.url}` }],
					isError: true,
				};
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				return {
					content: [{ type: "text", text: `Unsupported protocol: ${url.protocol}` }],
					isError: true,
				};
			}

			let chromium: Chromium;
			try {
				chromium = loadChromium();
			} catch (err) {
				return {
					content: [
						{ type: "text", text: err instanceof Error ? err.message : String(err) },
					],
					isError: true,
				};
			}

			const maxChars = params.max_chars ?? 8000;
			const maxItems = params.max_items ?? 50;
			const escalate = params.escalate !== false;
			const format =
				params.format === "text" || params.format === "html" ? params.format : "markdown";
			const onProgress = (msg: string) =>
				onUpdate?.({ content: [{ type: "text", text: msg }] });

			let result: FetchResult;
			try {
				result = await yousoroFetch(
					chromium,
					{
						url: url.toString(),
						extract: params.extract,
						extractAttr: params.extract_attr,
						waitMs: params.wait_ms ?? 2500,
						maxAttempts: params.max_attempts ?? 2,
						scroll: params.scroll ?? 0,
						scrollWaitMs: params.scroll_wait_ms ?? 1500,
						timezone: "Asia/Tokyo",
						challengeWaitMs: params.challenge_wait_ms ?? 20000,
						headed: params.headed ?? false,
						humanize: params.humanize ?? true,
						format,
					},
					signal,
					onProgress,
				);
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `yousoro_browse failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
				};
			}

			// ESCALATION. A blocked fetch used to end here with `Blocked: true` and no
			// suggestion, and agents were observed reporting failure to the user
			// instead of reaching for CloakBrowser — the tool that exists for exactly
			// this and defeats what Playwright-with-patches cannot (reCAPTCHA v3,
			// behaviour scoring). So retry here rather than hoping the model does.
			// Only on a real block, so a normal fetch never pays for it.
			if (result.blocked && escalate) {
				if (!cloakAvailable()) {
					result.escalationNote =
						"CloakBrowser is not installed in this image, so there is nothing to " +
						"escalate to.";
				} else {
					onProgress("Blocked — escalating to CloakBrowser (stealth Chromium)...");
					try {
						const html = await cloakDumpDom({
							url: result.finalUrl,
							humanize: params.humanize ?? true,
							timeoutMs: 45000,
						});
						// No live page here, so render from the string and re-run the same
						// visible-text detection to see whether cloak got further.
						const readable = htmlToText(html);
						const stillBlocked =
							looksChallenge(titleOf(html), readable) || looksBlocked(null, readable);
						if (stillBlocked) {
							result.escalationNote =
								"CloakBrowser was tried automatically and was ALSO blocked, so this " +
								"site cannot be read from this sandbox. Find another source rather " +
								"than retrying either tool.";
						} else {
							result.text =
								format === "html"
									? html
									: format === "text"
										? readable
										: htmlToMarkdown(html, result.finalUrl);
							result.html = html;
							result.title = titleOf(html) || result.title;
							result.blocked = false;
							result.engine = "cloakbrowser";
							// The extract list came from the blocked page, so it describes a
							// challenge screen, not the content now being returned.
							if (result.extracted) {
								result.extracted = undefined;
								result.escalationNote =
									'`extract` was dropped: it had matched the blocked page. Re-run ' +
									"with the same selector to extract from the CloakBrowser content.";
							}
						}
					} catch (err) {
						result.escalationNote = `CloakBrowser escalation failed: ${
							err instanceof Error ? err.message : String(err)
						}`;
					}
				}
			}

			// CloakBrowser dumps a DOM and reports no HTTP status, so after a
			// successful escalation the status belongs to the BLOCKED attempt, not to
			// the content being returned. Saying `Status: 403 Blocked: false` reads as
			// a contradiction, so attribute it.
			const statusLine =
				result.engine === "cloakbrowser"
					? `Status: n/a (CloakBrowser reports none; yousoro saw ${result.status ?? "unknown"})`
					: `Status: ${result.status ?? "unknown"}`;
			const header =
				`URL: ${result.finalUrl}\n` +
				`${statusLine}  Attempts: ${result.attempts}  Blocked: ${result.blocked}\n` +
				`Title: ${result.title}\n` +
				`Format: ${format}  Engine: ${
					result.engine === "cloakbrowser"
						? "cloakbrowser (yousoro was blocked; escalated automatically)"
						: "yousoro"
				}\n`;

			// Cache the COMPLETE result before building the preview, so nothing the
			// preview drops is lost. A cache failure must not fail the fetch: the
			// inline preview is still useful, so degrade and say so.
			let cache: CacheInfo | undefined;
			let cacheError: unknown;
			try {
				cache = writeCache(tmpdir(), result.finalUrl, {
					extract: params.extract,
					extractAttr: params.extract_attr,
					extracted: result.extracted,
					text: result.text,
					textLabel:
						format === "markdown"
							? "PAGE MARKDOWN"
							: format === "html"
								? "PAGE HTML"
								: "PAGE TEXT",
					// Always keep the raw DOM, whatever was rendered inline. It is the
					// answer to "is the renderer hiding something from me?". Skipped when
					// the body IS the raw DOM, which would just duplicate the file.
					rawHtml: format === "html" ? undefined : result.html,
				});
			} catch (err) {
				cacheError = err;
			}

			const parts: string[] = [header];

			if (result.extracted) {
				const total = result.extracted.length;
				const shown = result.extracted.slice(0, maxItems);
				const lines = shown.map((it, i) => {
					const label = it.text || "(no text)";
					return params.extract_attr && it.attr !== undefined
						? `${i + 1}. ${label}\n   [${params.extract_attr}] ${it.attr}`
						: `${i + 1}. ${label}`;
				});
				const heading =
					`\nExtracted ${total} element(s) for selector "${params.extract}"` +
					(params.extract_attr ? ` (attr: ${params.extract_attr})` : "") +
					(total > shown.length ? ` \u2014 showing first ${shown.length}` : "") +
					":";
				parts.push(`${heading}\n${lines.join("\n")}`);
			}

			const page = truncateHead(result.text, maxChars);
			const pageLabel =
				format === "markdown" ? "Page markdown" : format === "html" ? "Page HTML" : "Page text";
			const pageHeading = page.truncated
				? `\n--- ${pageLabel} (showing ${page.shownChars} of ${page.totalChars} chars; ` +
					`lines 1-${page.shownLines} of ${page.totalLines}) ---`
				: `\n--- ${pageLabel} ---`;
			parts.push(`${pageHeading}\n${page.content}`);

			// The footer is the whole point: it tells the model what it did NOT see
			// and hands it ready-to-run commands to get the rest. Rendered by the
			// shared module so cloak_browse says exactly the same thing.
			if (cache) {
				const sections: string[] = [];
				if (cache.extractedRange) {
					sections.push(
						`extracted TSV lines ${cache.extractedRange[0]}-${cache.extractedRange[1]}`,
					);
				}
				if (cache.pageTextRange) {
					sections.push(`page body lines ${cache.pageTextRange[0]}-${cache.pageTextRange[1]}`);
				}
				parts.push(
					formatCacheFooter(cache, {
						truncated: page.truncated || (result.extracted?.length ?? 0) > maxItems,
						sections,
					}),
				);
			} else {
				parts.push(formatCacheFailure(cacheError));
			}

			if (result.escalationNote) {
				parts.push(`\n--- Escalation ---\n${result.escalationNote}`);
			}

			// What to do next, at the moment the model is deciding it. Guidance in a
			// system prompt is too far away from this point to be acted on.
			if (result.blocked) {
				parts.push(
					escalate
						? "\n--- BLOCKED ---\nBoth yousoro_browse and CloakBrowser failed on this " +
							"URL. Do not retry either one: find another source for the same " +
							"information, or tell the user this site cannot be read from here."
						: "\n--- BLOCKED ---\nNext step: retry this URL with the cloak_browse tool " +
							"(stealth Chromium with C++ patches; defeats reCAPTCHA v3 and " +
							`behavioural detection that this tool cannot). cloak_browse url="${result.finalUrl}"`,
				);
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: {
					status: result.status,
					title: result.title,
					finalUrl: result.finalUrl,
					attempts: result.attempts,
					blocked: result.blocked,
					format,
					engine: result.engine,
					extractedCount: result.extracted?.length,
					cachePath: cache?.path,
					rawPath: cache?.rawPath,
					cacheLines: cache?.totalLines,
					textTruncated: page.truncated,
					totalChars: page.totalChars,
				},
				isError: result.blocked,
			};
		},
	});
}
