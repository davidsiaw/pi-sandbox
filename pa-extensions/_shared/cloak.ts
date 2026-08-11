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
