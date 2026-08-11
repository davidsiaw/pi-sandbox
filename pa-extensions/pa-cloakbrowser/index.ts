/**
 * pa-cloakbrowser
 *
 * Registers a `cloak_browse` tool that fetches web pages using the CloakBrowser
 * binary (stealth Chromium with 71 C++ source-level patches).
 *
 * The free binary (v146) is baked into the image at /opt/cloakbrowser/cloakbrowser-bin.
 *
 * READS LIKE curl, BUT FOR PAGES.
 * `--dump-dom` returns the whole serialised DOM; measured on a Wikipedia article
 * that is 875 KB of markup for 51 KB of readable text, and all of it used to
 * land in the context window in one piece — enough to swallow a conversation.
 * So the tool returns RENDERED MARKDOWN by default, capped to a preview, and
 * always writes two files under /tmp:
 *
 *   <stem>.txt   the complete rendered body (greppable)
 *   <stem>.html  the raw DOM exactly as fetched
 *
 * Both paths are reported, so "did the rendering eat something?" is answered by
 * reading the raw file instead of re-fetching. Same contract as yousoro_browse,
 * sharing ../_shared/cache.ts.
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
import { CLOAKBROWSER_BINARY, cloakAvailable, runCloak, titleOf } from "../_shared/cloak.ts";
import { htmlToMarkdown, htmlToText } from "../_shared/html-to-markdown.ts";
import { looksBlocked, looksChallenge } from "../_shared/stealth.ts";

const DEFAULT_MAX_CHARS = 8000;

function ensureCloakBrowser(): void {
  if (!cloakAvailable()) {
    throw new Error(
      `CloakBrowser binary not found at ${CLOAKBROWSER_BINARY}. ` +
        "The image may not have been built with CloakBrowser installed."
    );
  }
}

const BrowseParams = Type.Object({
  url: Type.String({ description: "URL to fetch (http/https only)" }),
  timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms", default: 30000 })),
  humanize: Type.Optional(Type.Boolean({ description: "Enable human-like behavior", default: true })),
  format: Type.Optional(
    Type.Enum(
      { markdown: "markdown", text: "text", html: "html" },
      {
        default: "markdown",
        description:
          'How to render the page. "markdown" (default) keeps headings, list markers ' +
          'and link URLs as [text](url). "text" is prose only. "html" is the raw ' +
          "DOM \u2014 rarely needed inline, since the raw DOM is ALWAYS written to a " +
          "sibling .html cache file whose path is reported.",
      },
    ),
  ),
  fingerprint: Type.Optional(Type.String({ description: "Deterministic fingerprint seed" })),
  max_chars: Type.Optional(
    Type.Number({
      description:
        "Inline budget for the returned content, in characters. Default 8000. The " +
        "COMPLETE output is always written to the cache file regardless, so raising " +
        "this is rarely necessary \u2014 read or rg the file instead.",
    }),
  ),
});

export default function paCloakbrowserExtension(pi: ExtensionAPI) {
  ensureCloakBrowser();

  pi.registerTool({
    name: "cloak_browse",
    label: "CloakBrowser Browse",
    description:
      "Fetch a web page using CloakBrowser (stealth Chromium with 71 C++ source-level patches). " +
      "Use this for sites with reCAPTCHA v3, Cloudflare Turnstile, or behavioral detection. " +
      "The free binary (v146) is baked into the image. Returns readable Markdown " +
      "(headings, list markers, link URLs), capped to a head-first preview. EVERY " +
      "fetch also writes two files under /tmp and reports both paths: the complete " +
      "rendered body (.txt) and the raw DOM exactly as fetched (.html), so anything " +
      "truncated \u2014 or anything the rendering may have dropped \u2014 is recovered with " +
      "read or rg instead of a re-fetch.",
    promptSnippet: "Fetch a web page using CloakBrowser (stealth Chromium with C++ patches)",
    promptGuidelines: [
      "Use cloak_browse for reCAPTCHA v3, Turnstile, or behavioral detection sites.",
      "Set humanize=true for best results against behavioral detection.",
      "The free binary (v146) is baked in; Pro license needed for latest builds.",
      "If yousoro_browse or camoufox_browse fail, try cloak_browse.",
      "cloak_browse returns only a preview and caches the COMPLETE output to /tmp: <stem>.txt is the rendered body, <stem>.html is the raw DOM. When it says the output was truncated, read or rg those files instead of re-fetching with a bigger max_chars.",
      "If cloak_browse output looks like the rendering swallowed something (a table, a form, a value you expected), read the .html file it reported rather than re-fetching with format=\"html\".",
      "cloak_browse renders markup with regexes because --dump-dom returns a string, not a live page: unlike yousoro_browse it CANNOT drop hidden menus/cookie banners, so its markdown is noisier. Prefer yousoro_browse when both work.",
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

      const { stdout, stderr, code } = await runCloak(args, timeout);

      if (code !== 0) {
        // Error output is small and is the whole diagnosis, so it stays inline.
        return {
          content: [
            {
              type: "text",
              text: `CloakBrowser failed (exit ${code}):\n${(stderr || stdout).slice(0, 4000)}`,
            },
          ],
          isError: true,
        };
      }

      const format = params.format ?? "markdown";
      const raw = stdout.trim();
      const result =
        format === "markdown"
          ? htmlToMarkdown(raw, params.url)
          : format === "text"
            ? htmlToText(raw)
            : raw;

      // `--dump-dom` exits 0 whatever it was served, so a Cloudflare interstitial
      // or a DNS error page used to be returned as if it were the article. Detect
      // it from the READABLE text (never the raw markup — challenge <script> tags
      // survive in the DOM of a page that cleared, which is why yousoro_browse
      // matches visible text only).
      const readable = format === "html" ? htmlToText(raw) : result;
      const blocked =
        looksChallenge(titleOf(raw), readable) || looksBlocked(null, readable);

      if (!result) {
        return {
          content: [{ type: "text", text: "CloakBrowser returned empty response." }],
          isError: true,
        };
      }

      // Cache the COMPLETE output before building the preview, so nothing the
      // preview drops is lost. A cache failure must not fail the fetch: the
      // preview is still useful, so degrade and say so.
      let cache: CacheInfo | undefined;
      let cacheError: unknown;
      const label =
        format === "markdown" ? "PAGE MARKDOWN" : format === "text" ? "PAGE TEXT" : "PAGE HTML";
      try {
        cache = writeCache(tmpdir(), params.url, {
          text: result,
          textLabel: label,
          // Always keep the raw DOM, whatever was rendered inline. It is the
          // answer to "is the renderer hiding something from me?".
          rawHtml: raw,
        });
      } catch (err) {
        cacheError = err;
      }

      const preview = truncateHead(result, params.max_chars ?? DEFAULT_MAX_CHARS);
      const heading =
        format === "markdown" ? "Page markdown" : format === "text" ? "Page text" : "Page HTML";
      const parts: string[] = [
        `URL: ${params.url}\nFormat: ${format}  Humanize: ${params.humanize ?? true}`,
      ];
      parts.push(
        preview.truncated
          ? `\n--- ${heading} (showing ${preview.shownChars} of ${preview.totalChars} chars; ` +
              `lines 1-${preview.shownLines} of ${preview.totalLines}) ---\n${preview.content}`
          : `\n--- ${heading} ---\n${preview.content}`,
      );

      parts.push(
        cache
          ? formatCacheFooter(cache, { truncated: preview.truncated })
          : formatCacheFailure(cacheError),
      );

      if (blocked) {
        // CloakBrowser is the last resort in this image, so say so rather than
        // leaving the caller to hunt for another tool that does not exist.
        parts.push(
          "\n--- BLOCKED ---\n" +
            "The page looks like a challenge/CAPTCHA rather than content. CloakBrowser " +
            "is the strongest fetcher in this sandbox, so there is nothing further to " +
            "escalate to: try a different source for the same information, or tell the " +
            "user the site cannot be read from here.",
        );
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: {
          url: params.url,
          format,
          humanize: params.humanize ?? true,
          cachePath: cache?.path,
          rawPath: cache?.rawPath,
          cacheLines: cache?.totalLines,
          truncated: preview.truncated,
          totalChars: preview.totalChars,
          blocked,
        },
        isError: blocked,
      };
    },
  });

  pi.registerCommand("cloak-status", {
    description: "Check CloakBrowser installation status",
    handler: async (_args, ctx) => {
      try {
        const { stdout } = await runCloak(["--version"], 5000);
        ctx.ui.notify(`CloakBrowser: ${stdout.trim() || "Running"}`, "info");
      } catch (err) {
        ctx.ui.notify(`CloakBrowser error: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
