/**
 * _shared/cloak.ts — spawning the CloakBrowser binary.
 *
 * Shared by pa-cloakbrowser (which is a thin tool around it) and
 * pa-yousoro-browse (which ESCALATES to it when its own fetch comes back
 * blocked). One copy, so the flags that make the binary work in a container do
 * not drift between the two callers.
 *
 * WHY ESCALATION LIVES IN CODE AND NOT ONLY IN A PROMPT
 * Agents were observed reaching for cloak_browse only when a human named it: a
 * blocked yousoro_browse result said `Blocked: true` and nothing else, so the
 * model reported failure to the user instead of trying the tool that exists
 * precisely for this. Guidance in a system prompt is far away from that moment;
 * the code path is not.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	type Chromium,
	looksBlocked,
	looksChallenge,
	visibleText,
	waitOutChallenge,
} from "./stealth.ts";

export const CLOAKBROWSER_BINARY = "/opt/cloakbrowser/cloakbrowser-bin";

export function cloakAvailable(): boolean {
	return existsSync(CLOAKBROWSER_BINARY);
}

export interface CloakResult {
	stdout: string;
	stderr: string;
	code: number;
}

export async function runCloak(args: string[], timeoutMs = 30000): Promise<CloakResult> {
	return new Promise((resolve, reject) => {
		const proc = spawn(CLOAKBROWSER_BINARY, args, { stdio: ["ignore", "pipe", "pipe"] });

		let stdout = "";
		let stderr = "";

		const timeout = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error(`CloakBrowser timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		proc.on("close", (code) => {
			clearTimeout(timeout);
			resolve({ stdout, stderr, code: code ?? 0 });
		});
		proc.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});
	});
}

export interface CloakFetchOptions {
	url: string;
	humanize?: boolean;
	fingerprint?: string;
	timeoutMs?: number;
}

/**
 * Fetch a page and return the serialised DOM. Flags are the ones known to work
 * headless in a container; `--humanize` is what defeats behaviour-scoring gates,
 * so it is on unless explicitly disabled.
 */
export async function cloakDumpDom(opts: CloakFetchOptions): Promise<string> {
	const args = [
		"--headless",
		"--no-sandbox",
		"--disable-dev-shm-usage",
		"--disable-gpu",
		"--dump-dom",
		opts.url,
	];
	if (opts.humanize !== false) args.push("--humanize");
	if (opts.fingerprint) args.push(`--fingerprint=${opts.fingerprint}`);

	const { stdout, stderr, code } = await runCloak(args, opts.timeoutMs ?? 30000);
	if (code !== 0) {
		throw new Error(`CloakBrowser exited ${code}: ${(stderr || stdout).slice(0, 500)}`);
	}
	return stdout.trim();
}

/** `<title>` of a dumped document, for the visible-text block detection. */
export function titleOf(html: string): string {
	const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

// ---------------------------------------------------------------------------
// Live CloakBrowser: the escalation tier AFTER --dump-dom
// ---------------------------------------------------------------------------
//
// WHY --dump-dom IS NOT ENOUGH
// --dump-dom serialises the document at its first load event and exits. A
// Cloudflare challenge page IS a complete document, so the dump is always the
// challenge: nothing can wait for the post-verification reload, and nothing can
// click the Turnstile checkbox a managed challenge asks for. Measured on
// icy-veins.com: every --dump-dom variant (--virtual-time-budget, --timeout)
// returned "Just a moment...".
//
// (Its dump also CONTAINS "Verification successful. Waiting for ... to
// respond" -- a display:none template div in the challenge page, not a pass.
// The regex renderer cannot see display:none, so do not read it as progress.)
//
// WHAT THIS DOES INSTEAD
// Drives the same binary through Playwright (it is a real Chromium), then
// reuses waitOutChallenge, which clicks Turnstile. On icy-veins that cleared
// 5/5. Two things matter and were each tested:
//   - NO yousoro init script. CloakBrowser's fingerprint is patched in C++; the
//     JS overrides would paper over it with detectable getters.
//   - ignoreDefaultArgs --enable-automation, as the official cloakbrowser
//     wrapper does. The wrapper itself is NOT needed: plain Playwright with
//     executablePath passed the same test.
// Waiting without the click did NOT clear it, CDP attached or not.
//
// It costs a full browser session (~10-30s), so callers run it only when the
// cheap --dump-dom came back as a CHALLENGE. A hard block (Google /sorry/, an
// image CAPTCHA) cannot be waited or clicked out of and does not reach here.

export interface CloakLiveOptions {
	url: string;
	fingerprint?: string;
	challengeWaitMs?: number;
	timeoutMs?: number;
}

export interface CloakLiveResult<T> {
	status: number | null;
	title: string;
	finalUrl: string;
	blocked: boolean;
	/** Whatever `read` returned from the live page after the challenge. */
	read: T;
}

/**
 * Load `url` in a Playwright-driven CloakBrowser, wait out (and click) any
 * challenge, then hand the live page to `read`. Rendering is the caller's, so
 * yousoro can use its DOM walker and cloak_browse its string renderer.
 */
export async function cloakFetchLive<T>(
	chromium: Chromium,
	opts: CloakLiveOptions,
	onProgress: (msg: string) => void,
	// biome-ignore lint/suspicious/noExplicitAny: playwright page
	read: (page: any) => Promise<T>,
): Promise<CloakLiveResult<T>> {
	const args = ["--no-sandbox", "--disable-dev-shm-usage"];
	if (opts.fingerprint) args.push(`--fingerprint=${opts.fingerprint}`);
	const browser = await chromium.launch({
		executablePath: CLOAKBROWSER_BINARY,
		headless: true,
		args,
		ignoreDefaultArgs: ["--enable-automation"],
	});
	try {
		const page = await browser.newPage();
		const resp = await page.goto(opts.url, {
			waitUntil: "domcontentloaded",
			timeout: opts.timeoutMs ?? 30000,
		});
		let status: number | null = resp ? resp.status() : null;
		let title: string = await page.title();
		let vtext = await visibleText(page);
		if (looksChallenge(title, vtext)) {
			vtext = await waitOutChallenge(page, opts.challengeWaitMs ?? 25000, onProgress);
			title = await page.title();
			// Same rule as yousoro: a challenge that cleared makes its 403 moot.
			if (!looksChallenge(title, vtext)) {
				status = 200;
				// The reload after verification is a fresh navigation; let it settle
				// before reading, or `read` races a half-built DOM.
				await page.waitForLoadState("domcontentloaded").catch(() => {});
				await page.waitForTimeout(1500);
				title = await page.title();
				vtext = await visibleText(page);
			}
		}
		const blocked = looksChallenge(title, vtext) || looksBlocked(status, vtext);
		return { status, title, finalUrl: page.url(), blocked, read: await read(page) };
	} finally {
		await browser.close();
	}
}
