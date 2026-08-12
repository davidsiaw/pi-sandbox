/**
 * _shared/stealth.ts — fingerprint masking + block/challenge detection.
 *
 * WHY THIS FILE EXISTS
 * Extracted verbatim from pa-yousoro-browse so that pa-screenshot can reuse it
 * rather than carry a second copy. The value here is hard-won: the masking
 * layers below, and especially the rule that block/challenge detection reads
 * VISIBLE text (title + innerText) and never raw HTML. Two divergent copies of
 * BLOCK_MARKERS would drift the first time a site changes its wording, so both
 * tools import from here.
 *
 * NOT AN EXTENSION. This directory has no index.ts, and the pa launcher only
 * passes a directory to `pi -e` when that directory contains an index.ts, so
 * this one is skipped. That guard is what makes the layout safe: pointing
 * `pi -e` at a directory without an index.ts is a FATAL startup error.
 *
 * Masking, in layers:
 *   - navigator.webdriver = false, plugins/languages populated, window.chrome
 *   - navigator.userAgentData / Sec-CH-UA / UA string all claim Google Chrome
 *     at the real bundled-engine major (internally consistent)
 *   - coherent macOS hardware (hardwareConcurrency, deviceMemory, platform,
 *     screen geometry, devicePixelRatio)
 *   - WebGL UNMASKED_* reports a real Intel GPU instead of SwiftShader
 *   - per-session canvas + audio fingerprint noise (deterministic within a run)
 *   - brief human-ish mouse/scroll interaction before reading (opt-out)
 *   - optional headed mode behind Xvfb
 *
 * Playwright is not bundled; it is resolved from the global install baked into
 * the pa image (/usr/lib/node_modules/playwright), with the Chromium browsers
 * at /opt/ms-playwright.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Playwright loader (global module, absolute-path fallback)
// ---------------------------------------------------------------------------

export const GLOBAL_PLAYWRIGHT_CANDIDATES = [
	"playwright",
	"/usr/lib/node_modules/playwright/index.js",
	"/usr/local/lib/node_modules/playwright/index.js",
];

// biome-ignore lint/suspicious/noExplicitAny: playwright has no local types here
export type Chromium = any;

export function loadChromium(): Chromium {
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

export interface VirtualDisplay {
	display: string;
	proc?: ChildProcess;
	dispose(): void;
}

// Headed Chromium needs an X server. In the pa sandbox there is no real display,
// so when the caller asks for headed mode and no DISPLAY is set we spawn an Xvfb
// virtual framebuffer and point Chromium at it. If DISPLAY is already present
// (e.g. a real X server was forwarded in), we reuse it and spawn nothing.
export async function ensureDisplay(onProgress: (msg: string) => void): Promise<VirtualDisplay> {
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
export function chromeMajor(browserVersion: string): string {
	const m = /^(\d+)\./.exec(browserVersion);
	return m ? m[1] : "126";
}

// Build a Google-Chrome (not "Chromium"/"Chrome for Testing") user-agent string
// for the given major version. Anti-bot checks compare this against the Sec-CH-UA
// brands and navigator.userAgentData; all three must say "Google Chrome".
export function yousoroUserAgent(major: string): string {
	return (
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
		`(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
	);
}

// The Sec-CH-UA request header, claiming Google Chrome at the real major.
export function secChUa(major: string): string {
	return `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not.A/Brand";v="24"`;
}

// Init script factory. Takes the major version so navigator.userAgentData
// reports "Google Chrome" consistently with the UA string and Sec-CH-UA header.
// Playwright bundles "Chromium"/"Chrome for Testing", whose userAgentData brands
// betray it (the rebrowser bot-detector flags this as the `useragent` tell), so
// we override brands + getHighEntropyValues in the page's main world.
export function makeYousoroInitScript(major: string): string {
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
		// Coherent hardware for the macOS identity we claim. Containers report
		// values that don't match a "MacBook"; anti-bots cross-check these against
		// the platform. 8 cores / 8 GB is an unremarkable, real-looking laptop.
		defineNav("hardwareConcurrency", () => 8);
		defineNav("deviceMemory", () => 8);
		defineNav("platform", () => "MacIntel");
		defineNav("maxTouchPoints", () => 0);
		defineNav("vendor", () => "Google Inc.");
		// Screen/window geometry consistent with a real macOS display, the 1280x800
		// viewport, and a Retina-ish devicePixelRatio. Headless defaults (e.g. 0 /
		// mismatched availHeight, dpr 1 on "macOS") are a known tell.
		const defineScreenProp = (name, value) => {
			try {
				Object.defineProperty(window.screen, name, { get: () => value, configurable: true });
			} catch (e) {}
		};
		defineScreenProp("width", 1440);
		defineScreenProp("height", 900);
		defineScreenProp("availWidth", 1440);
		defineScreenProp("availHeight", 875); // minus the macOS menu bar
		defineScreenProp("colorDepth", 30);
		defineScreenProp("pixelDepth", 30);
		try {
			Object.defineProperty(window, "devicePixelRatio", { get: () => 2, configurable: true });
		} catch (e) {}
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

		// --- Canvas + Audio fingerprint noise.
		// Anti-bot systems hash a canvas render or an AudioContext buffer to build a
		// stable device fingerprint. Two problems for us: (a) headless SwiftShader
		// produces a KNOWN fingerprint that flags automation, and (b) a perfectly
		// stable hash across "different users" from one image is itself suspicious.
		// We inject a tiny per-session deterministic perturbation: enough to move
		// off the known headless hash, but stable WITHIN a session. All offsets
		// derive from one random seed per page load and RESET to it before each
		// read, so the same input always yields the same output. (A hash that
		// changes on every read is itself a tell — that's what naive
		// anti-fingerprinting does.)
		const seed = (Math.random() * 1e9) >>> 0;
		// Deterministic jitter generator seeded from a base value.
		const makeJitter = (base) => {
			let lcg = base >>> 0;
			return () => {
				lcg = (lcg * 1664525 + 1013904223) >>> 0;
				return (lcg % 3) - 1; // -1, 0, or +1
			};
		};

		// Canvas 2D: perturb a handful of channels on readback. Reset the jitter to
		// the session seed each call so repeated reads of the same canvas match.
		const perturbImageData = (data) => {
			const jit = makeJitter(seed);
			for (let i = 0; i < data.length; i += 4 * 997 + 4) {
				data[i] = Math.max(0, Math.min(255, data[i] + jit()));
			}
		};
		const Ctx2DProto = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
		if (Ctx2DProto && Ctx2DProto.getImageData) {
			const origGID = Ctx2DProto.getImageData;
			const repl = function (...args) {
				const res = origGID.apply(this, args);
				try { perturbImageData(res.data); } catch (e) {}
				return res;
			};
			repl.toString = () => origGID.toString();
			Ctx2DProto.getImageData = repl;
		}
		// toDataURL: derive the PNG from a perturbed copy of the pixels so the
		// output is stable per session AND doesn't mutate the visible canvas
		// (drawing into the live canvas each call would double-perturb).
		const CanvasProto = window.HTMLCanvasElement && HTMLCanvasElement.prototype;
		if (CanvasProto && CanvasProto.toDataURL && Ctx2DProto) {
			const origTDU = CanvasProto.toDataURL;
			const repl = function (...args) {
				try {
					const w = this.width, h = this.height;
					const src = this.getContext("2d");
					if (src && w && h) {
						// getImageData is already shimmed above -> perturbed + stable.
						const img = src.getImageData(0, 0, w, h);
						const tmp = document.createElement("canvas");
						tmp.width = w; tmp.height = h;
						const tctx = tmp.getContext("2d");
						tctx.putImageData(img, 0, 0);
						return origTDU.apply(tmp, args);
					}
				} catch (e) {}
				return origTDU.apply(this, args);
			};
			repl.toString = () => origTDU.toString();
			CanvasProto.toDataURL = repl;
		}

		// AudioContext: perturb the float samples so the audio fingerprint moves off
		// the headless baseline. Deterministic per session (reset jitter each call).
		// Scale ~1e-7 — far below audible/functional relevance.
		const AudioBufProto = window.AudioBuffer && AudioBuffer.prototype;
		if (AudioBufProto && AudioBufProto.getChannelData) {
			const origGCD = AudioBufProto.getChannelData;
			const repl = function (...args) {
				const out = origGCD.apply(this, args);
				try {
					const jit = makeJitter(seed);
					for (let i = 0; i < out.length; i += 1000) {
						out[i] = out[i] + jit() * 1e-7;
					}
				} catch (e) {}
				return out;
			};
			repl.toString = () => origGCD.toString();
			AudioBufProto.getChannelData = repl;
		}
		const AnalyserProto = window.AnalyserNode && AnalyserNode.prototype;
		if (AnalyserProto && AnalyserProto.getFloatFrequencyData) {
			const origFFD = AnalyserProto.getFloatFrequencyData;
			const repl = function (array) {
				origFFD.call(this, array);
				try {
					const jit = makeJitter(seed);
					for (let i = 0; i < array.length; i += 100) {
						array[i] = array[i] + jit() * 1e-4;
					}
				} catch (e) {}
			};
			repl.toString = () => origFFD.toString();
			AnalyserProto.getFloatFrequencyData = repl;
		}
	})();`;
}

// --- Behavioral signals.
// Freshly-loaded automated pages emit zero human interaction: no mouse movement,
// no scroll, instant everything. Some anti-bot gates score this. We inject a
// short, cheap sequence of human-ish mouse moves and small scroll wiggles after
// load so the page sees *some* organic-looking interaction. Kept brief so it
// doesn't slow ordinary fetches much.
export async function humanize(
	// biome-ignore lint/suspicious/noExplicitAny: playwright page
	page: any,
	signal: AbortSignal | undefined,
): Promise<void> {
	const rand = (min: number, max: number) => min + Math.random() * (max - min);
	try {
		// A few mouse moves along a jittery path across the viewport.
		let x = rand(100, 400);
		let y = rand(100, 300);
		const steps = 4 + Math.floor(rand(0, 3));
		for (let i = 0; i < steps; i++) {
			if (signal?.aborted) return;
			x = Math.max(0, Math.min(1279, x + rand(-120, 220)));
			y = Math.max(0, Math.min(799, y + rand(-80, 160)));
			// Playwright interpolates intermediate points when steps>1.
			await page.mouse.move(x, y, { steps: 3 + Math.floor(rand(0, 5)) });
			await page.waitForTimeout(rand(40, 140));
		}
		// A couple of small scroll nudges (down a bit, maybe back up).
		for (let i = 0; i < 2; i++) {
			if (signal?.aborted) return;
			await page.mouse.wheel(0, rand(120, 480));
			await page.waitForTimeout(rand(120, 300));
		}
		await page.mouse.wheel(0, -rand(40, 160));
	} catch (e) {
		// Interaction is best-effort; never fail the fetch over it.
	}
}


export const BLOCK_MARKERS = [
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
	// Google's /sorry/ interstitial. It is the block a datacenter IP hits most
	// often, and it was the one shape that slipped through every check: it is
	// served as HTTP **200**, its title is the requested URL rather than anything
	// challenge-like, and it says "not a robot" -- which does not contain any of
	// the phrases above ("are you a robot", "i'm not a robot"). So it was reported
	// as a successful fetch of a page whose entire content is the refusal, and
	// escalation never fired. Match its own wording instead.
	//
	// Deliberately NOT the bare phrase "not a robot": a page legitimately
	// discussing CAPTCHAs contains it, and a false block is worse than a missed
	// one -- it would discard a good page and burn a CloakBrowser fetch. "detected
	// unusual traffic" is Google's own wording and specific enough.
	"detected unusual traffic",
	"unusual traffic from your computer network",
];

// Blocks that RETRYING CANNOT FIX, because they are a verdict on the IP or a
// puzzle a human has to solve -- not the transient rate-limit the backoff loop
// was built for.
//
// The backoff exists for "too many requests, come back later", where waiting is
// the answer. Google's /sorry/ is the opposite: it is IP reputation, so attempts
// 2, 3 and 4 return the identical page and cost 27s of sleeping (6+9+12s) plus
// three more page loads to learn nothing. Measured in a live drive.
//
// This does NOT suppress escalation. CloakBrowser has a different fingerprint
// and is still worth one try; what is skipped is only re-asking the same engine
// the same question.
export const HOPELESS_MARKERS = [
	"detected unusual traffic",
	"unusual traffic from your computer network",
	"enter the characters seen in the image",
	"please solve the challenge",
	"client challenge",
];

// Visible-text based, like the others. A block already detected by looksBlocked
// is asked whether retrying it has any chance.
export function looksHopeless(visibleText: string): boolean {
	const lower = visibleText.toLowerCase();
	return HOPELESS_MARKERS.some((m) => lower.includes(m));
}

// Cloudflare / interstitial challenge markers. These are NOT permanent blocks:
// the page runs JS and redirects to the real content once the check passes, so
// we wait it out rather than retry-with-backoff.
// IMPORTANT: challenge detection keys off the VISIBLE page (title + innerText),
// never the raw HTML. Cloudflare uses a "403-then-redirect" pattern: it first
// serves an interstitial (HTTP 403, title "Just a moment…", visible text
// "Checking your browser…"), runs its JS fingerprint check, and — if the check
// passes — redirects to the real content. Crucially, once cleared it *leaves its
// challenge <script> tags in the DOM* (`challenge-platform`, `cf_chl_opt`,
// `cf-chl`, `cf-browser-verification`). Those live in page.content() (raw HTML)
// forever, so matching HTML would flag a fully-loaded page as still blocked —
// a false positive. The interstitial's TITLE and VISIBLE TEXT, by contrast,
// disappear the moment the real page renders, so they are the reliable signal.
export const CHALLENGE_MARKERS = [
	"just a moment",
	"checking your browser",
	"checking if the site connection is secure",
	"enable javascript and cookies to continue",
	"verifying you are human",
	"needs to review the security of your connection",
	"attention required! | cloudflare",
];

// title + VISIBLE text only (not raw HTML) — see note above.
export function looksChallenge(title: string, visibleText: string): boolean {
	const hay = `${title}\n${visibleText}`.toLowerCase();
	return CHALLENGE_MARKERS.some((m) => hay.includes(m));
}

// Also visible-text based (plus HTTP status). BLOCK_MARKERS are CAPTCHA /
// verification phrases that a human would see rendered on the page.
export function looksBlocked(status: number | null, visibleText: string): boolean {
	if (status === 403 || status === 429 || status === 503) return true;
	const lower = visibleText.toLowerCase();
	return BLOCK_MARKERS.some((m) => lower.includes(m));
}

// Read the page's visible text (what a human sees), used for all block/challenge
// detection. Falls back to "" if the body isn't ready.
export async function visibleText(
	// biome-ignore lint/suspicious/noExplicitAny: playwright page
	page: any,
): Promise<string> {
	try {
		return await page.evaluate(() => document.body?.innerText ?? "");
	} catch {
		return "";
	}
}

// Wait for a Cloudflare-style interstitial to clear. The challenge page runs JS
// then navigates to the real content; poll until the visible challenge text is
// gone (or timeout). Returns the final visible text once cleared, or the last
// seen. Detection is on title + innerText so leftover CF scripts in the DOM of
// the *cleared* page don't keep it looping (see note on CHALLENGE_MARKERS).
export async function waitOutChallenge(
	// biome-ignore lint/suspicious/noExplicitAny: playwright page
	page: any,
	timeoutMs: number,
	onProgress: (msg: string) => void,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let text = await visibleText(page);
	let title = await page.title();
	let waited = 0;
	while (looksChallenge(title, text) && Date.now() < deadline) {
		onProgress(`Cloudflare challenge detected; waiting for it to clear (${waited}ms)...`);
		try {
			// Wait until the visible interstitial text/title disappears (redirect to
			// real content). Checks title + document.body.innerText, NOT innerHTML,
			// so leftover challenge <script> tags don't defeat the wait.
			await page.waitForFunction(
				() => {
					const t = (document.title || "").toLowerCase();
					const v = (document.body?.innerText || "").toLowerCase();
					const markers = [
						"just a moment",
						"checking your browser",
						"checking if the site connection is secure",
						"enable javascript and cookies to continue",
						"verifying you are human",
					];
					return !markers.some((m) => t.includes(m) || v.includes(m));
				},
				{ timeout: 5000 },
			);
		} catch {
			// waitForFunction timed out this round; loop and re-check until deadline.
		}
		waited += 5000;
		text = await visibleText(page);
		title = await page.title();
	}
	return text;
}

