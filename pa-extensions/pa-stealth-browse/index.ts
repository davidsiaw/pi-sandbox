/**
 * pa-stealth-browse
 *
 * Registers a `stealth_browse` tool that fetches a web page using a
 * fingerprint-masked headless Chromium (Playwright), with retry + backoff to
 * defeat bot/rate-limit blocks (e.g. Reddit's "blocked by network security").
 *
 * Why: plain headless Chromium leaks automation signals (navigator.webdriver,
 * HeadlessChrome UA token, missing plugins) and many sites 403 it. This tool
 * spoofs those signals and retries transient blocks, so page viewing works
 * reliably from the pa sandbox.
 *
 * Playwright is not bundled; it is resolved from the global install baked into
 * the pa image (/usr/lib/node_modules/playwright), with the Chromium browsers
 * at /opt/ms-playwright.
 */

import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Playwright loader (global module, absolute-path fallback)
// ---------------------------------------------------------------------------

const GLOBAL_PLAYWRIGHT_CANDIDATES = [
	"playwright",
	"/usr/lib/node_modules/playwright/index.js",
	"/usr/local/lib/node_modules/playwright/index.js",
];

// biome-ignore lint/suspicious/noExplicitAny: playwright has no local types here
type Chromium = any;

function loadChromium(): Chromium {
	const require = createRequire(import.meta.url);
	let lastErr: unknown;
	for (const candidate of GLOBAL_PLAYWRIGHT_CANDIDATES) {
		try {
			const mod = require(candidate);
			const chromium = mod.chromium ?? mod.default?.chromium;
			if (chromium) return chromium;
		} catch (err) {
			lastErr = err;
		}
	}
	throw new Error(
		`Could not load Playwright. Tried: ${GLOBAL_PLAYWRIGHT_CANDIDATES.join(", ")}. ` +
			`Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
	);
}

// ---------------------------------------------------------------------------
// Stealth fetch
// ---------------------------------------------------------------------------

const STEALTH_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const STEALTH_INIT_SCRIPT = () => {
	// Hide the automation flag.
	Object.defineProperty(navigator, "webdriver", { get: () => undefined });
	// Populate plugins/languages that headless leaves empty.
	Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
	Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
	// Real Chrome exposes window.chrome.
	// biome-ignore lint/suspicious/noExplicitAny: browser-context global
	(window as any).chrome = { runtime: {} };
	// Spoof permissions query (headless answers "denied" for notifications).
	// biome-ignore lint/suspicious/noExplicitAny: browser-context global
	const perms = (navigator as any).permissions;
	if (perms?.query) {
		const orig = perms.query.bind(perms);
		// biome-ignore lint/suspicious/noExplicitAny: browser-context global
		perms.query = (params: any) =>
			params?.name === "notifications"
				? Promise.resolve({ state: Notification.permission })
				: orig(params);
	}
};

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

const BLOCK_MARKERS = [
	"blocked by network security",
	"whoa there",
	"are you a robot",
	"verify you are human",
	"access denied",
];

function looksBlocked(status: number | null, body: string): boolean {
	if (status === 403 || status === 429 || status === 503) return true;
	const lower = body.toLowerCase();
	return BLOCK_MARKERS.some((m) => lower.includes(m));
}

async function stealthFetch(
	chromium: Chromium,
	opts: FetchOptions,
	signal: AbortSignal | undefined,
	onProgress: (msg: string) => void,
): Promise<FetchResult> {
	const browser = await chromium.launch({
		headless: true,
		args: [
			"--no-sandbox",
			"--disable-blink-features=AutomationControlled",
			"--disable-features=IsolateOrigins,site-per-process",
		],
	});

	try {
		const context = await browser.newContext({
			userAgent: STEALTH_UA,
			locale: "en-US",
			timezoneId: opts.timezone,
			viewport: { width: 1280, height: 800 },
			// NOTE: do NOT override the `Accept` header. Forcing a custom Accept
			// makes some sites (Reddit) serve a minimal SSR fallback (few items).
			// Let Chromium send its native Accept; only add the safe hints below.
			extraHTTPHeaders: {
				"Accept-Language": "en-US,en;q=0.9",
				"sec-ch-ua": '"Chromium";v="126", "Not.A/Brand";v="24"',
				"sec-ch-ua-mobile": "?0",
				"sec-ch-ua-platform": '"macOS"',
			},
		});
		await context.addInitScript(STEALTH_INIT_SCRIPT);
		const page = await context.newPage();

		let status: number | null = null;
		let body = "";
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
			body = await page.content();
			blocked = looksBlocked(status, body);

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
	max_chars: Type.Optional(
		Type.Number({
			description: "Truncate returned page text to this many characters. Default 8000.",
		}),
	),
});

export default function paStealthBrowseExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "stealth_browse",
		label: "Stealth Browse",
		description:
			"Fetch a web page with a fingerprint-masked headless Chromium (spoofed " +
			"navigator.webdriver, real UA/plugins/timezone) and retry-with-backoff on " +
			"bot/rate-limit blocks. Use this to read pages that reject plain headless " +
			"browsers with 403/429/503 (e.g. Reddit, Cloudflare-fronted sites). Returns " +
			"page text, and optionally innerText (and an attribute such as href) of " +
			"elements matching a CSS selector — use extract=\"a\" extract_attr=\"href\" " +
			"to collect links with their text.",
		promptSnippet: "Fetch a web page past bot-blocks using a stealth headless browser",
		promptGuidelines: [
			"Use stealth_browse to read a web page when a normal fetch is blocked (403/429/503) or when the site is known to reject headless browsers (Reddit, Cloudflare).",
			"Prefer stealth_browse over ad-hoc Playwright scripts for one-off page reads.",
			"Set stealth_browse scroll>0 for infinite-scroll feeds (e.g. Reddit) so lazy-loaded items are captured.",
			'Use stealth_browse with extract="a" extract_attr="href" to collect candidate links (text + absolute URL) from a page before deciding which to follow.',
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
				result = await stealthFetch(
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
					},
					signal,
					onProgress,
				);
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `stealth_browse failed: ${err instanceof Error ? err.message : String(err)}`,
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
