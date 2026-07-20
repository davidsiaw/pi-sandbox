/**
 * pa-cloakbrowser
 *
 * Registers a `cloak_browse` tool that fetches web pages using the CloakBrowser
 * binary (stealth Chromium with 71 C++ source-level patches).
 *
 * The free binary (v146) is baked into the image at /opt/cloakbrowser/cloakbrowser-bin.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CLOAKBROWSER_BINARY = "/opt/cloakbrowser/cloakbrowser-bin";

function ensureCloakBrowser(): void {
  if (!existsSync(CLOAKBROWSER_BINARY)) {
    throw new Error(
      `CloakBrowser binary not found at ${CLOAKBROWSER_BINARY}. ` +
        "The image may not have been built with CloakBrowser installed."
    );
  }
}

async function runCloakBrowser(args: string[], timeoutMs = 30000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLOAKBROWSER_BINARY, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`CloakBrowser timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (data) => (stdout += data.toString()));
    proc.stderr.on("data", (data) => (stderr += data.toString()));

    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

const BrowseParams = Type.Object({
  url: Type.String({ description: "URL to fetch (http/https only)" }),
  timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms", default: 30000 })),
  humanize: Type.Optional(Type.Boolean({ description: "Enable human-like behavior", default: true })),
  format: Type.Optional(Type.Enum({ html: "html", markdown: "markdown" }, { default: "html" })),
  fingerprint: Type.Optional(Type.String({ description: "Deterministic fingerprint seed" })),
});

export default function paCloakbrowserExtension(pi: ExtensionAPI) {
  ensureCloakBrowser();

  pi.registerTool({
    name: "cloak_browse",
    label: "CloakBrowser Browse",
    description:
      "Fetch a web page using CloakBrowser (stealth Chromium with 71 C++ source-level patches). " +
      "Use this for sites with reCAPTCHA v3, Cloudflare Turnstile, or behavioral detection. " +
      "The free binary (v146) is baked into the image.",
    promptSnippet: "Fetch a web page using CloakBrowser (stealth Chromium with C++ patches)",
    promptGuidelines: [
      "Use cloak_browse for reCAPTCHA v3, Turnstile, or behavioral detection sites.",
      "Set humanize=true for best results against behavioral detection.",
      "The free binary (v146) is baked in; Pro license needed for latest builds.",
      "If yousoro_browse or camoufox_browse fail, try cloak_browse.",
    ],
    parameters: BrowseParams,
    async execute(_toolCallId, params, signal) {
      const timeout = params.timeout_ms ?? 30000;

      // Build args: Known working flags for Docker/containers
      const args: string[] = [
        "--headless",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--dump-dom", // Output full HTML to stdout
        params.url,
      ];

      if (params.humanize) {
        args.push("--humanize");
      }

      if (params.fingerprint) {
        args.push(`--fingerprint=${params.fingerprint}`);
      }

      // Note: We don't use --format here because the binary outputs HTML via --dump-dom
      // If markdown is requested, we'll strip tags in the result.

      const { stdout, stderr, code } = await runCloakBrowser(args, timeout);

      if (code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `CloakBrowser failed (exit ${code}):\n${stderr || stdout}`,
            },
          ],
          isError: true,
        };
      }

      let result = stdout.trim();
      
      // Simple HTML to text conversion if markdown requested
      if (params.format === "markdown") {
        result = result
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }

      if (!result) {
        return {
          content: [{ type: "text", text: "CloakBrowser returned empty response." }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: result }],
        details: {
          url: params.url,
          format: params.format ?? "html",
          humanize: params.humanize ?? true,
        },
      };
    },
  });

  pi.registerCommand("cloak-status", {
    description: "Check CloakBrowser installation status",
    handler: async (_args, ctx) => {
      try {
        const { stdout } = await runCloakBrowser(["--version"], 5000);
        ctx.ui.notify(`CloakBrowser: ${stdout.trim() || "Running"}`, "info");
      } catch (err) {
        ctx.ui.notify(`CloakBrowser error: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
