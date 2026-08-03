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
 * Playwright is not bundled; it is resolved from the global install baked into
 * the pa image (/usr/lib/node_modules/playwright), with the Chromium browsers
 * at /opt/ms-playwright. See docs/yousoro-browsing.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type Chromium,
	type VirtualDisplay,
	chromeMajor,
	ensureDisplay,
	humanize,
	loadChromium,
	looksBlocked,
	looksChallenge,
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
}

interface FetchResult {
	status: number | null;
	title: string;
	finalUrl: string;
	attempts: number;
	blocked: boolean;
	text: string;
	extracted?: ExtractedItem[];
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

			if (attempt < opts.maxAttempts) {
				const backoff = 3000 + attempt * 3000;
				onProgress(`Blocked (status ${status}). Backing off ${backoff}ms...`);
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
		const text: string = await page.evaluate(() => document.body?.innerText ?? "");

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

		return { status, title, finalUrl, attempts: attempt, blocked, text, extracted };
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
			description: "Max attempts with backoff when the page looks blocked. Default 4.",
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
	max_chars: Type.Optional(
		Type.Number({
			description: "Truncate returned page text to this many characters. Default 8000.",
		}),
	),
});

export default function paYousoroBrowseExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "yousoro_browse",
		label: "Yousoro Browse",
		description:
			"CRITICAL: Load the 'web-search' skill first for search/browsing guidance. " +
			"Fetch a web page with a fingerprint-masked headless Chromium (Google " +
			"Chrome UA + userAgentData, real WebGL GPU, coherent macOS hardware, " +
			"canvas/audio noise, human-ish interaction), wait out Cloudflare " +
			"\"Just a moment\" 403-then-redirect challenges, and retry-with-backoff on " +
			"bot/rate-limit blocks. Use this to read pages that reject plain headless " +
			"browsers with 403/429/503 (e.g. Reddit, Cloudflare-fronted sites). Returns " +
			"page text, and optionally innerText (and an attribute such as href) of " +
			"elements matching a CSS selector — use extract=\"a\" extract_attr=\"href\" " +
			"to collect links with their text.",
		promptSnippet: "Fetch a web page past bot-blocks using the yousoro headless browser",
		promptGuidelines: [
			"CRITICAL: Before using yousoro_browse for search/browsing tasks, load the 'web-search' skill which contains essential guidance on search engines, BFS strategies, and blocked-site handling.",
			"Use yousoro_browse to read a web page when a normal fetch is blocked (403/429/503) or when the site is known to reject headless browsers (Reddit, Cloudflare).",
			"Prefer yousoro_browse over ad-hoc Playwright scripts for one-off page reads.",
			"Set yousoro_browse scroll>0 for infinite-scroll feeds (e.g. Reddit) so lazy-loaded items are captured.",
			'Use yousoro_browse with extract="a" extract_attr="href" to collect candidate links (text + absolute URL) from a page before deciding which to follow.',
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
						maxAttempts: params.max_attempts ?? 4,
						scroll: params.scroll ?? 0,
						scrollWaitMs: params.scroll_wait_ms ?? 1500,
						timezone: "Asia/Tokyo",
						challengeWaitMs: params.challenge_wait_ms ?? 20000,
						headed: params.headed ?? false,
						humanize: params.humanize ?? true,
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

			const header =
				`URL: ${result.finalUrl}\n` +
				`Status: ${result.status ?? "unknown"}  Attempts: ${result.attempts}  ` +
				`Blocked: ${result.blocked}\n` +
				`Title: ${result.title}\n`;

			const parts: string[] = [header];

			if (result.extracted) {
				const lines = result.extracted.map((it, i) => {
					const label = it.text || "(no text)";
					return params.extract_attr && it.attr !== undefined
						? `${i + 1}. ${label}\n   [${params.extract_attr}] ${it.attr}`
						: `${i + 1}. ${label}`;
				});
				parts.push(
					`\nExtracted ${result.extracted.length} element(s) for selector ` +
						`"${params.extract}"` +
						(params.extract_attr ? ` (attr: ${params.extract_attr})` : "") +
						`:\n${lines.join("\n")}`,
				);
			}

			const pageText = result.text.slice(0, maxChars);
			const truncated = result.text.length > maxChars;
			parts.push(`\n--- Page text${truncated ? " (truncated)" : ""} ---\n${pageText}`);

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: {
					status: result.status,
					title: result.title,
					finalUrl: result.finalUrl,
					attempts: result.attempts,
					blocked: result.blocked,
					extractedCount: result.extracted?.length,
				},
				isError: result.blocked,
			};
		},
	});
}
