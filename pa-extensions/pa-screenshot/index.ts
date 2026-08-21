/**
 * pa-screenshot
 *
 * Registers a `screenshot_url` tool that renders a URL in a fingerprint-masked
 * headless Chromium and writes a PNG **to a file**. It never returns image
 * bytes: the result is a one-line receipt naming the path. The agent can then
 * `read` the file (which attaches the image when the model is vision-capable),
 * fall back to `inspect_image` when it is not, or just leave it for the user.
 *
 * WHY A FILE AND NOT AN INLINE IMAGE
 * A base64 image in the tool result lands in the context window (and inflates
 * ~33%). For screenshots — often full-page, often several taken in a row —
 * that is expensive and usually unwanted. A path is cheap and reusable.
 *
 * WHERE THE FILE GOES
 * The `pa` launcher mounts only the project dir read-write, at its real host
 * path (`-v "$PWD:$PWD" --workdir="$PWD"`). So a **relative** path resolves
 * against the project and survives on the host, while an absolute path
 * elsewhere (e.g. /tmp) is destroyed when the container exits. Absolute paths
 * are allowed — sometimes a scratch file is what you want — but the receipt
 * says plainly that the file will be lost, because silently vanishing output is
 * worse than a refusal.
 *
 * WHY IT REFUSES TO OVERWRITE
 * Clobbering an existing screenshot loses information with no way to notice.
 * The tool refuses and names a concrete free alternative so the agent can retry
 * in one step instead of guessing.
 *
 * WHY IT REFUSES TO WRITE A BLOCKED PAGE
 * Measured in this sandbox: reddit.com returns **HTTP 200** while serving
 * "You've been blocked by network security" (plain Playwright) or a reCAPTCHA
 * "Prove your humanity" page (CloakBrowser). A tool that trusts the status code
 * writes a beautiful PNG of a CAPTCHA and reports success — plausible, silent,
 * wrong, and it costs a vision-model call to discover. So detection gates the
 * write: if the page looks blocked, nothing is written and the receipt says why.
 * Masking (shared with pa-yousoro-browse) is what makes that rare in practice.
 *
 * The masking layers and the block/challenge detection live in
 * ../_shared/stealth.ts. See that file for why detection reads VISIBLE text and
 * never raw HTML.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type Chromium,
	type VirtualDisplay,
	chromeMajor,
	ensureDisplay,
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
// Output path resolution
// ---------------------------------------------------------------------------

interface OutPath {
	absolute: string;
	/** True when the path is inside the project dir (the only rw mount). */
	insideProject: boolean;
}

/**
 * Build the default filename from the URL host plus a timestamp, so repeated
 * captures of different pages don't collide and the file is self-describing.
 * Falls back to "page" when the URL has no usable hostname.
 */
function defaultFileName(rawUrl: string): string {
	let host = "page";
	try {
		const h = new URL(rawUrl).hostname.replace(/^www\./, "").replace(/[^a-zA-Z0-9.-]/g, "-");
		if (h) host = h;
	} catch {
		// keep the fallback
	}
	const ts = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\..+$/, "")
		.replace("T", "-");
	return `screenshot-${host}-${ts}.png`;
}

/**
 * Resolve the requested path against the project dir and classify it.
 * Rejects non-.png names (writing PNG bytes to a .jpg is a lie that surfaces
 * much later) and paths that escape the project via "..".
 */
function resolveOutPath(cwd: string, requested: string): OutPath {
	if (extname(requested).toLowerCase() !== ".png") {
		throw new Error(
			`path must end in .png (got "${requested}"). Screenshots are written as PNG.`,
		);
	}
	const absolute = isAbsolute(requested) ? requested : resolvePath(cwd, requested);
	const rel = relative(cwd, absolute);
	// rel starting with ".." (or being absolute) means the target escapes cwd.
	// An empty rel means the path *is* cwd, which is a directory, not a file.
	const insideProject = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	if (!isAbsolute(requested) && !insideProject) {
		throw new Error(
			`path "${requested}" escapes the project directory. Use a path inside ` +
				`the project, or pass an absolute path if you really mean to write outside it.`,
		);
	}
	return { absolute, insideProject };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

interface ShotOptions {
	url: string;
	outPath: string;
	fullPage: boolean;
	width: number;
	height: number;
	scale: number;
	selector?: string;
	waitForSelector?: string;
	waitMs: number;
	challengeWaitMs: number;
	headed: boolean;
	timezone: string;
}

interface ShotResult {
	status: number | null;
	title: string;
	finalUrl: string;
	blocked: boolean;
	/** Present only when a file was actually written. */
	written?: { bytes: number; width: number; height: number };
	/** Visible text, used to explain a block. */
	visible: string;
}

/** Read the PNG's IHDR to report true pixel dimensions (cheap, 24-byte read). */
function pngSize(bytes: Buffer): { width: number; height: number } {
	// PNG: 8-byte signature, then IHDR length+type (8 bytes), then W,H as BE u32.
	if (bytes.length < 24) return { width: 0, height: 0 };
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function capture(
	chromium: Chromium,
	opts: ShotOptions,
	signal: AbortSignal | undefined,
	onProgress: (msg: string) => void,
): Promise<ShotResult> {
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
		// One consistent Chrome identity, derived from the real bundled engine.
		const major = chromeMajor(browser.version());

		const context = await browser.newContext({
			userAgent: yousoroUserAgent(major),
			locale: "en-US",
			timezoneId: opts.timezone,
			viewport: { width: opts.width, height: opts.height },
			deviceScaleFactor: opts.scale,
			// NOTE: do NOT override `Accept` — see pa-yousoro-browse; forcing it
			// makes some sites serve a minimal SSR fallback.
			extraHTTPHeaders: {
				"Accept-Language": "en-US,en;q=0.9",
				"sec-ch-ua": secChUa(major),
				"sec-ch-ua-mobile": "?0",
				"sec-ch-ua-platform": '"macOS"',
			},
		});
		await context.addInitScript(makeYousoroInitScript(major));
		const page = await context.newPage();

		onProgress(`Loading ${opts.url}...`);
		const resp = await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 30000 });
		let status: number | null = resp ? resp.status() : null;

		// Wait for a specific element before capturing. This is the difference
		// between a reliable screenshot and a race on JS-rendered UIs: a local
		// page can reach networkidle while still showing "loading…".
		if (opts.waitForSelector) {
			onProgress(`Waiting for selector "${opts.waitForSelector}"...`);
			try {
				await page.waitForSelector(opts.waitForSelector, { timeout: 15000, state: "visible" });
			} catch {
				throw new Error(
					`wait_for_selector "${opts.waitForSelector}" never appeared (15s). ` +
						`Nothing was written. Check the selector, or raise wait_ms and omit it.`,
				);
			}
		}

		await page.waitForTimeout(opts.waitMs);
		if (signal?.aborted) throw new Error("aborted");

		// Detection on VISIBLE text (title + innerText), never raw HTML.
		let title = await page.title();
		let vtext = await visibleText(page);

		// Cloudflare "403-then-redirect": wait for the interstitial to clear
		// before judging. If it clears, the initial 403 was just the gate.
		if (looksChallenge(title, vtext)) {
			vtext = await waitOutChallenge(page, opts.challengeWaitMs, onProgress);
			title = await page.title();
			status = looksChallenge(title, vtext) ? status : 200;
		}

		const blocked = looksBlocked(status, vtext) || looksChallenge(title, vtext);
		const finalUrl = page.url();

		// Refuse to write a picture of a block/CAPTCHA page. See file header.
		if (blocked) {
			return { status, title, finalUrl, blocked: true, visible: vtext };
		}

		// Create the parent directory only now that we know we will write.
		mkdirSync(dirname(opts.outPath), { recursive: true });

		if (opts.selector) {
			const el = await page.$(opts.selector);
			if (!el) {
				throw new Error(
					`selector "${opts.selector}" matched no element. Nothing was written.`,
				);
			}
			onProgress(`Capturing element "${opts.selector}"...`);
			await el.screenshot({ path: opts.outPath, type: "png" });
		} else {
			onProgress(opts.fullPage ? "Capturing full page..." : "Capturing viewport...");
			await page.screenshot({ path: opts.outPath, type: "png", fullPage: opts.fullPage });
		}

		const { readFileSync } = await import("node:fs");
		const bytes = readFileSync(opts.outPath);
		const dims = pngSize(bytes);
		return {
			status,
			title,
			finalUrl,
			blocked: false,
			written: { bytes: bytes.length, ...dims },
			visible: vtext,
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
	url: Type.String({
		description: "The URL to render (http/https). Local addresses work too, e.g. http://localhost:3000.",
	}),
	path: Type.Optional(
		Type.String({
			description:
				"Where to write the PNG. Must end in .png. Relative paths resolve against " +
				"the project directory and persist on the host; absolute paths outside it " +
				"are written but lost when the sandbox exits. " +
				"Default: ./screenshot-<host>-<timestamp>.png. " +
				"Refuses to overwrite an existing file.",
		}),
	),
	full_page: Type.Optional(
		Type.Boolean({
			description:
				"Capture the entire scrollable page instead of just the viewport. " +
				"Default false (a long page makes a very large PNG).",
		}),
	),
	selector: Type.Optional(
		Type.String({
			description: "Capture only the element matching this CSS selector, cropped to its box.",
		}),
	),
	wait_for_selector: Type.Optional(
		Type.String({
			description:
				"Wait until this CSS selector is visible before capturing (max 15s). Use this " +
				"for JS-rendered UIs — a page can finish loading while still showing a spinner.",
		}),
	),
	width: Type.Optional(
		Type.Number({ description: "Viewport width in px. Default 1280." }),
	),
	height: Type.Optional(
		Type.Number({ description: "Viewport height in px. Default 800." }),
	),
	scale: Type.Optional(
		Type.Number({
			description:
				"Device scale factor. 2 gives retina-sharp text at ~4x the bytes. Default 1.",
		}),
	),
	wait_ms: Type.Optional(
		Type.Number({ description: "Milliseconds to wait after load for JS to settle. Default 2500." }),
	),
	challenge_wait_ms: Type.Optional(
		Type.Number({
			description:
				'Max time to wait for a Cloudflare "Just a moment" interstitial to clear. Default 20000.',
		}),
	),
	headed: Type.Optional(
		Type.Boolean({
			description:
				"Render in a headed Chromium behind a virtual X display (Xvfb). Slower to start; " +
				"clears some challenges headless cannot. Default false.",
		}),
	),
});

export default function paScreenshotExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "screenshot_url",
		label: "Screenshot URL",
		description:
			"Render a URL in a fingerprint-masked headless Chromium (JS fully executed) and " +
			"save a PNG to a file. Returns the file path, NOT the image bytes — read the file " +
			"or pass it to read if you need to see it. Use this to capture a web page " +
			"or a local UI (e.g. http://localhost:3000). Refuses to overwrite an existing file, " +
			"and refuses to write anything if the page turns out to be a bot-block or CAPTCHA.",
		promptSnippet: "Render a URL with JS and save a PNG screenshot to a file path",
		promptGuidelines: [
			"Use screenshot_url to capture how a page or local UI actually renders; JS is executed.",
			"It writes a PNG file and returns the path. It does not return the image — call read on the path if you need to see the contents (or inspect_image, if read reports this model cannot see images).",
			"Prefer a relative path (or omit path entirely): relative paths land in the project directory and persist on the host, while /tmp is lost when the sandbox exits.",
			"For JS-rendered UIs pass wait_for_selector so the capture waits for real content instead of racing a spinner.",
			"It refuses to overwrite; if it reports the file exists, pass a different path.",
		],
		parameters: PARAMS,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// --- Validate URL -------------------------------------------------
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

			// --- Resolve destination ------------------------------------------
			let out: OutPath;
			try {
				out = resolveOutPath(ctx.cwd, params.path ?? defaultFileName(params.url));
			} catch (err) {
				return {
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					isError: true,
				};
			}

			// Refuse to clobber. Do this BEFORE launching a browser so the failure
			// is instant rather than costing a page load.
			if (existsSync(out.absolute)) {
				const suggestion = out.absolute.replace(/\.png$/i, "-2.png");
				return {
					content: [
						{
							type: "text",
							text:
								`A file already exists at ${out.absolute} and screenshot_url will not ` +
								`overwrite it.\nRetry with a different path, e.g. path="${suggestion}", ` +
								`or delete the existing file first.`,
						},
					],
					isError: true,
				};
			}
			// A directory sitting on the target path would make the write fail with
			// a confusing EISDIR much later; say so now.
			try {
				if (statSync(out.absolute).isDirectory()) {
					return {
						content: [
							{ type: "text", text: `${out.absolute} is a directory, not a file path.` },
						],
						isError: true,
					};
				}
			} catch {
				// ENOENT is the expected, good case.
			}

			// --- Load Playwright ----------------------------------------------
			let chromium: Chromium;
			try {
				chromium = loadChromium();
			} catch (err) {
				return {
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					isError: true,
				};
			}

			const onProgress = (msg: string) =>
				onUpdate?.({ content: [{ type: "text", text: msg }] });

			// --- Capture -------------------------------------------------------
			let result: ShotResult;
			try {
				result = await capture(
					chromium,
					{
						url: url.toString(),
						outPath: out.absolute,
						fullPage: params.full_page ?? false,
						width: params.width ?? 1280,
						height: params.height ?? 800,
						scale: params.scale ?? 1,
						selector: params.selector,
						waitForSelector: params.wait_for_selector,
						waitMs: params.wait_ms ?? 2500,
						challengeWaitMs: params.challenge_wait_ms ?? 20000,
						headed: params.headed ?? false,
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
							text: `screenshot_url failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
				};
			}

			// --- Blocked: nothing written --------------------------------------
			if (result.blocked) {
				const snippet = result.visible.slice(0, 200).replace(/\s+/g, " ").trim();
				return {
					content: [
						{
							type: "text",
							text:
								`No file written: ${result.finalUrl} served a bot-block or CAPTCHA page ` +
								`(status ${result.status ?? "unknown"}), so the screenshot would have ` +
								`captured that instead of the real content.\n` +
								`Visible text: "${snippet}"\n` +
								`Try headed=true, or read the page with yousoro_browse instead.`,
						},
					],
					details: { url: result.finalUrl, status: result.status, blocked: true, written: false },
					isError: true,
				};
			}

			// --- Success receipt ------------------------------------------------
			const w = result.written;
			const kb = w ? Math.round(w.bytes / 1024) : 0;
			const lines = [
				`Saved ${w?.width}x${w?.height} PNG (${kb} KB) to ${out.absolute}`,
				`Page: ${result.title || "(no title)"} — ${result.finalUrl}`,
			];
			if (!out.insideProject) {
				lines.push(
					`WARNING: this path is outside the project directory, which is the only ` +
						`writable mount. The file will be LOST when the sandbox exits. Use a ` +
						`relative path to keep it on the host.`,
				);
			}
			lines.push(`To view it, call read with path="${out.absolute}" (or inspect_image, if read says this model cannot see images).`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					path: out.absolute,
					insideProject: out.insideProject,
					bytes: w?.bytes,
					width: w?.width,
					height: w?.height,
					status: result.status,
					finalUrl: result.finalUrl,
					blocked: false,
					written: true,
				},
			};
		},
	});
}
