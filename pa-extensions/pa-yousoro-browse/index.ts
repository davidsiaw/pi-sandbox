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
 * Why: plain headless Chromium leaks automation signals (navigator.webdriver,
 * HeadlessChrome UA token, missing plugins) and many sites 403 it. This tool
 * spoofs those signals, waits out Cloudflare "Just a moment" interstitial
 * challenges (which run JS then redirect to the real page), and retries
 * transient blocks, so page viewing works reliably from the pa sandbox.
 *
 * Note: JS already runs in Chromium; "Just a moment" is a Cloudflare challenge,
 * not a JS-disabled problem. The fix is to wait for the challenge to auto-solve
 * and navigate, not to enable JS. Hard managed challenges (Turnstile) may still
 * fail against stock headless Chromium — those need a patched/undetected build
 * or a real Chrome channel in headed mode.
 *
 * Playwright is not bundled; it is resolved from the global install baked into
 * the pa image (/usr/lib/node_modules/playwright), with the Chromium browsers
 * at /opt/ms-playwright.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
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
// Virtual display (Xvfb) for headed mode inside a headless container
// ---------------------------------------------------------------------------

interface VirtualDisplay {
	display: string;
	proc?: ChildProcess;
	dispose(): void;
}

// Headed Chromium needs an X server. In the pa sandbox there is no real display,
// so when the caller asks for headed mode and no DISPLAY is set we spawn an Xvfb
// virtual framebuffer and point Chromium at it. If DISPLAY is already present
// (e.g. a real X server was forwarded in), we reuse it and spawn nothing.
async function ensureDisplay(onProgress: (msg: string) => void): Promise<VirtualDisplay> {
	if (process.env.DISPLAY) {
		return { display: process.env.DISPLAY, dispose() {} };
	}
	if (!existsSync("/usr/bin/Xvfb")) {
		throw new Error(
			"headed mode requested but Xvfb is not installed and no DISPLAY is set. " +
				"Rebuild the pa image (install-system-deps.sh installs xvfb) or run with headed=false.",
		);
	}
	// Pick a display number unlikely to collide; Xvfb fails fast if taken.
	const num = 99;
	const display = `:${num}`;
	onProgress(`Starting Xvfb on ${display} for headed Chromium...`);
	const proc = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], {
		stdio: "ignore",
		detached: false,
	});
	proc.on("error", () => {});
	// Give Xvfb a moment to create the X socket.
	const sock = `/tmp/.X11-unix/X${num}`;
	for (let i = 0; i < 40; i++) {
		if (existsSync(sock)) break;
		await delay(50);
	}
	if (!existsSync(sock)) {
		try {
			proc.kill();
		} catch {}
		throw new Error("Xvfb failed to start (X socket never appeared).");
	}
	return {
		display,
		proc,
		dispose() {
			try {
				proc.kill();
			} catch {}
		},
	};
}

// ---------------------------------------------------------------------------
// Yousoro fetch
// ---------------------------------------------------------------------------

// Extract the Chromium major version from browser.version() (e.g. "149.0.7827.0"
// -> 149). Bundled Chromium reports its real engine version; hardcoding a
// different one (the old code used 126) is itself a tell, and worse, it makes
// the UA string, sec-ch-ua header, and navigator.userAgentData disagree. We pin
// everything to the real major so the identity is internally consistent.
function chromeMajor(browserVersion: string): string {
	const m = /^(\d+)\./.exec(browserVersion);
	return m ? m[1] : "126";
}

// Build a Google-Chrome (not "Chromium"/"Chrome for Testing") user-agent string
// for the given major version. Anti-bot checks compare this against the Sec-CH-UA
// brands and navigator.userAgentData; all three must say "Google Chrome".
function yousoroUserAgent(major: string): string {
	return (
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
		`(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
	);
}

// The Sec-CH-UA request header, claiming Google Chrome at the real major.
function secChUa(major: string): string {
	return `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not.A/Brand";v="24"`;
}

// Init script factory. Takes the major version so navigator.userAgentData
// reports "Google Chrome" consistently with the UA string and Sec-CH-UA header.
// Playwright bundles "Chromium"/"Chrome for Testing", whose userAgentData brands
// betray it (the rebrowser bot-detector flags this as the `useragent` tell), so
// we override brands + getHighEntropyValues in the page's main world.
function makeYousoroInitScript(major: string): string {
	// Serialize to a self-invoking string so we can inject the version. Runs in
	// the page context (no access to Node scope), hence the string form.
	return `(() => {
		// Define spoofed props on Navigator.prototype, NOT the navigator instance.
		// Defining on the instance creates OWN properties, which a detector catches
		// via Object.getOwnPropertyNames(navigator) (real Chrome keeps these on the
		// prototype). Redefining the existing prototype accessors avoids that tell.
		const navProto = Object.getPrototypeOf(navigator);
		const defineNav = (name, getter) => {
			try {
				Object.defineProperty(navProto, name, { get: getter, configurable: true });
			} catch (e) {}
		};
		// Hide the automation flag. Real Chrome returns false here, not undefined;
		// deleting it or returning undefined is itself a (weaker) tell, so mimic
		// the genuine value.
		defineNav("webdriver", () => false);
		// Populate plugins/languages that headless leaves empty.
		defineNav("plugins", () => [1, 2, 3, 4, 5]);
		defineNav("languages", () => ["en-US", "en"]);
		// Real Chrome exposes window.chrome.
		window.chrome = { runtime: {} };
		// Spoof permissions query (headless answers "denied" for notifications).
		const perms = navigator.permissions;
		if (perms && perms.query) {
			const orig = perms.query.bind(perms);
			perms.query = (params) =>
				params && params.name === "notifications"
					? Promise.resolve({ state: Notification.permission })
					: orig(params);
		}
		// --- userAgentData: claim Google Chrome, not Chromium / Chrome for Testing.
		// In headless mode brands even say "HeadlessChrome", an instant tell. The
		// real brands getter lives on NavigatorUAData.prototype and the instance
		// is non-extensible, so defining a property on the instance silently does
		// nothing. Instead we replace navigator.userAgentData wholesale with a fake
		// object (getter on Navigator.prototype), delegating getHighEntropyValues
		// to the original for fields we do not spoof.
		const MAJOR = "${major}";
		const brands = [
			{ brand: "Google Chrome", version: MAJOR },
			{ brand: "Chromium", version: MAJOR },
			{ brand: "Not.A/Brand", version: "24" },
		];
		const fullVersionList = [
			{ brand: "Google Chrome", version: MAJOR + ".0.0.0" },
			{ brand: "Chromium", version: MAJOR + ".0.0.0" },
			{ brand: "Not.A/Brand", version: "24.0.0.0" },
		];
		const realUAData = navigator.userAgentData;
		if (realUAData) {
			const fakeUAData = {
				get brands() { return brands; },
				get mobile() { return false; },
				get platform() { return "macOS"; },
				toJSON() { return { brands, mobile: false, platform: "macOS" }; },
				getHighEntropyValues: async (hints) => {
					let base = {};
					try { base = await realUAData.getHighEntropyValues(hints); } catch (e) {}
					return Object.assign({}, base, {
						brands,
						fullVersionList,
						uaFullVersion: MAJOR + ".0.0.0",
						platform: "macOS",
						platformVersion: "13.0.0",
					});
				},
			};
			try {
				Object.defineProperty(Object.getPrototypeOf(navigator), "userAgentData", {
					get: () => fakeUAData,
					configurable: true,
				});
			} catch (e) {}
		}
		// --- WebGL: report a real GPU instead of "SwiftShader".
		// A container has no GPU, so Chromium renders with SwiftShader and the
		// WEBGL_debug_renderer_info UNMASKED_* strings say so — an instant tell
		// (SwiftShader ~never appears on a real user's machine). We override
		// getParameter on BOTH WebGL context prototypes to return an Intel Mac GPU
		// consistent with our macOS user-agent. The replacement keeps a native
		// toString so it doesn't itself look patched.
		const GL_VENDOR = "Google Inc. (Intel Inc.)";
		const GL_RENDERER =
			"ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics OpenGL Engine, OpenGL 4.1)";
		const UNMASKED_VENDOR_WEBGL = 0x9245;
		const UNMASKED_RENDERER_WEBGL = 0x9246;
		const patchGL = (proto) => {
			if (!proto || !proto.getParameter) return;
			const orig = proto.getParameter;
			const repl = function (param) {
				if (param === UNMASKED_VENDOR_WEBGL) return GL_VENDOR;
				if (param === UNMASKED_RENDERER_WEBGL) return GL_RENDERER;
				return orig.call(this, param);
			};
			try { Object.defineProperty(repl, "name", { value: "getParameter" }); } catch (e) {}
			repl.toString = () => orig.toString();
			proto.getParameter = repl;
		};
		if (window.WebGLRenderingContext) patchGL(WebGLRenderingContext.prototype);
		if (window.WebGL2RenderingContext) patchGL(WebGL2RenderingContext.prototype);
	})();`;
}

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
	// CAPTCHA / verification pages that are not the transient CF interstitial
	// (these do not auto-solve; treat as a hard block so the caller moves on).
	"verification required",
	"please complete the challenge",
	"i'm not a robot",
	"client challenge",
	"please solve the challenge",
	"enter the characters seen in the image",
];

// Cloudflare / interstitial challenge markers. These are NOT permanent blocks:
// the page runs JS and redirects to the real content once the check passes, so
// we wait it out rather than retry-with-backoff.
const CHALLENGE_MARKERS = [
	"just a moment",
	"checking your browser",
	"checking if the site connection is secure",
	"cf-browser-verification",
	"cf_chl_opt",
	"cf-chl",
	"challenge-platform",
	"enable javascript and cookies to continue",
	"attention required! | cloudflare",
];

function looksChallenge(title: string, body: string): boolean {
	const hay = `${title}\n${body}`.toLowerCase();
	return CHALLENGE_MARKERS.some((m) => hay.includes(m));
}

function looksBlocked(status: number | null, body: string): boolean {
	if (status === 403 || status === 429 || status === 503) return true;
	const lower = body.toLowerCase();
	return BLOCK_MARKERS.some((m) => lower.includes(m));
}

// Wait for a Cloudflare-style interstitial to clear. The challenge page runs JS
// then navigates to the real content; poll until the challenge markers are gone
// (or timeout). Returns the final body once cleared, or the last body seen.
async function waitOutChallenge(
	// biome-ignore lint/suspicious/noExplicitAny: playwright page
	page: any,
	timeoutMs: number,
	onProgress: (msg: string) => void,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let body = await page.content();
	let title = await page.title();
	let waited = 0;
	while (looksChallenge(title, body) && Date.now() < deadline) {
		onProgress(`Cloudflare challenge detected; waiting for it to clear (${waited}ms)...`);
		try {
			// Either the interstitial navigates away, or its DOM markers vanish.
			await page.waitForFunction(
				() => {
					const t = (document.title || "").toLowerCase();
					const h = (document.documentElement.innerHTML || "").toLowerCase();
					const markers = [
						"just a moment",
						"checking your browser",
						"cf-browser-verification",
						"cf_chl_opt",
						"challenge-platform",
					];
					return !markers.some((m) => t.includes(m) || h.includes(m));
				},
				{ timeout: 5000 },
			);
		} catch {
			// waitForFunction timed out this round; loop and re-check until deadline.
		}
		waited += 5000;
		body = await page.content();
		title = await page.title();
	}
	return body;
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

			// Cloudflare "Just a moment" interstitial: wait for it to auto-solve
			// and navigate to the real page before deciding it's blocked. This is
			// the common case where JS runs fine but the first paint is the check.
			let title = await page.title();
			if (looksChallenge(title, body)) {
				body = await waitOutChallenge(page, opts.challengeWaitMs, onProgress);
				title = await page.title();
				status = looksChallenge(title, body) ? status : 200;
			}

			blocked = looksBlocked(status, body) || looksChallenge(title, body);

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
			"Fetch a web page with a fingerprint-masked headless Chromium (spoofed " +
			"navigator.webdriver, real UA/plugins/timezone), wait out Cloudflare " +
			"\"Just a moment\" interstitial challenges, and retry-with-backoff on " +
			"bot/rate-limit blocks. Use this to read pages that reject plain headless " +
			"browsers with 403/429/503 (e.g. Reddit, Cloudflare-fronted sites). Returns " +
			"page text, and optionally innerText (and an attribute such as href) of " +
			"elements matching a CSS selector — use extract=\"a\" extract_attr=\"href\" " +
			"to collect links with their text.",
		promptSnippet: "Fetch a web page past bot-blocks using the yousoro headless browser",
		promptGuidelines: [
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
