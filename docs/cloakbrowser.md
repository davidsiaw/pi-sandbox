# CloakBrowser Integration

## Overview

The `pi-sandbox` image includes **CloakBrowser** (free v146 binary) as the second browsing option alongside `yousoro_browse`.

> **There is no `camoufox_browse` in this image.** Earlier drafts of this page and
> of the web-search skill named one; nothing registers it. The two browsing tools
> are `yousoro_browse` (Chromium + Playwright, the default) and `cloak_browse`.
> `yousoro_browse` escalates to `cloak_browse` on its own when a page is blocked,
> so chaining them by hand is not needed.

## What is CloakBrowser?

CloakBrowser is a stealth Chromium browser with **71 C++ source-level patches** that make it undetectable by most anti-bot systems. Unlike JavaScript-based stealth tools, CloakBrowser patches the Chromium source code itself, making it effective against:

- **reCAPTCHA v3** (0.9 human score with Pro version)
- **Cloudflare Turnstile**
- **FingerprintJS** and **BrowserScan**
- **Behavioral detection** (mouse, keyboard, scroll patterns)

## Installation in the Image

The CloakBrowser binary is automatically downloaded and installed during the Docker image build:

1. **Binary**: Downloaded from GitHub Releases (latest free version) to `/opt/cloakbrowser/cloakbrowser-bin`
2. **Fonts**: Critical fonts installed for canvas fingerprinting (`fonts-noto-color-emoji`, etc.)
3. **npm package**: `cloakbrowser` and `playwright-core` installed globally for Node API access

## Usage in the Agent

The `pa-cloakbrowser` extension registers a `cloak_browse` tool:

```typescript
cloak_browse url="https://example.com"                  # markdown by default
cloak_browse url="https://example.com" format="text"    # prose, no markup
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | URL to fetch (http/https only) |
| `humanize` | boolean | true | Enable human-like behavior (Bézier curves, realistic typing) |
| `headless` | boolean | true | Run in headless mode |
| `format` | enum | "markdown" | `markdown` (headings + link URLs), `text` (prose only), or `html` (raw DOM inline; rarely needed, the raw DOM is always cached) |
| `fingerprint` | string | optional | Fixed fingerprint seed for consistent identity |
| `max_chars` | number | 8000 | inline budget for the returned content (the full output is always cached) |

## Output: readable by default, raw markup always on disk

`cloak_browse` drives the binary with `--dump-dom`, which serialises the **whole
DOM**. Measured on a Wikipedia article: **875 KB of markup**. All of it used to be
returned inline, straight into the context window — a single fetch could consume
most of a conversation.

It now behaves like `yousoro_browse`, and like a `curl` meant for reading pages:

1. the default `format="markdown"` renders headings, list markers, code fences,
   tables and **link URLs** as `[text](url)`, resolved absolute;
2. the inline result is a head-first preview capped by `max_chars` (default 8000);
3. **every** fetch writes two files under `/tmp` and reports both:

```
--- Page markdown (showing 7965 of 136599 chars; lines 1-229 of 1180) ---
[Jump to content](#bodyContent)
...

--- Full content cached ---
  Rendered: /tmp/pa-browse-en.wikipedia.org-20260811-225859-8b45.txt  (134 KB, 1181 lines)
  Raw HTML: /tmp/pa-browse-en.wikipedia.org-20260811-225859-8b45.html  (857 KB, 2119 lines)
  Truncation is head-first, so the TAIL is only in the file.
  Tail:   read path="..." offset=1081
  Search: rg -n "pattern" "..."
  Rendering looks wrong or incomplete? Read the raw HTML file above.
```

So "did the renderer eat the table I wanted?" is answered by reading the `.html`
file, not by re-fetching with `format="html"`. The cache section is labelled
`PAGE MARKDOWN` / `PAGE TEXT` / `PAGE HTML` to match what was rendered. A cache
write failure never fails the fetch — the preview is still returned, with a note.

The caching layer is `pa-extensions/_shared/cache.ts`, shared with
`pa-yousoro-browse` down to `formatCacheFooter`, so both tools print the same
footer (see [yousoro-browsing.md](yousoro-browsing.md#output-caching-two-files-per-fetch)).

### Its markdown is noisier than yousoro_browse's, on purpose

The two tools render markdown by different means, because they have different
inputs:

| | input | renderer | can drop hidden elements? |
|---|---|---|---|
| `yousoro_browse` | live Playwright page | DOM walk (`pa-yousoro-browse/markdown.ts`) | **yes** — `Element.checkVisibility()` |
| `cloak_browse` | a STRING from `--dump-dom` | regexes (`_shared/html-to-markdown.ts`) | no |

There is no DOM parser in the image (no jsdom, and adding one to convert markup
is a poor trade), so `cloak_browse` cannot know what was actually rendered:
`display:none` menus, collapsed accordions and off-screen cookie banners all
survive. Same Wikipedia article, same fetch: **yousoro markdown 86 KB,
cloak markdown 136 KB** — the difference is almost entirely hidden navigation.

Nested list depth and complex table layout are likewise not tracked. So: prefer
`yousoro_browse` when both work; reach for `cloak_browse` when the site demands
it (reCAPTCHA v3, behavioural detection).

The real fix is to drive CloakBrowser over **CDP** — it is a Chromium, so launch
it with `--remote-debugging-port` and connect with the `playwright-core` already
in the image, then reuse the DOM walker. That changes the fetch path (and the
`--humanize` behaviour that lives in the CLI), so it is deliberately a separate
piece of work.

## Tool Comparison

| Tool | Engine | Strengths | Best For |
|------|--------|-----------|----------|
| `yousoro_browse` | Chromium (JS patches) | Fast, lightweight, Cloudflare 403-then-redirect | General browsing, Cloudflare challenges |
| `cloak_browse` | Chromium (C++ patches) | **reCAPTCHA v3**, TLS spoofing, behavioral | reCAPTCHA v3, Turnstile, behavioral detection |

## You usually do not have to ask for it

`yousoro_browse` **escalates to CloakBrowser automatically** when its own fetch
comes back blocked, and says so in the header
(`Engine: cloakbrowser (yousoro was blocked; escalated automatically)`). Call
`cloak_browse` directly when you already know the site needs it, or when
something other than `yousoro_browse` hit a 403/429/503 or a CAPTCHA. See
[yousoro-browsing.md](yousoro-browsing.md#automatic-escalation-to-cloakbrowser).

Both tools share the spawn logic in `pa-extensions/_shared/cloak.ts`.

### Blocked pages are now reported as blocked

`--dump-dom` exits 0 whatever it was served, so a Cloudflare interstitial or a
DNS error page used to be returned as if it were the article. `cloak_browse` now
runs the same visible-text detection `yousoro_browse` uses (challenge/CAPTCHA
phrases in the RENDERED text, never the raw markup — challenge `<script>` tags
survive in the DOM of a page that cleared) and marks the result as an error,
noting that CloakBrowser is the last resort in this image so there is nothing
further to escalate to.

## When to Use CloakBrowser

Use `cloak_browse` when:

1. **reCAPTCHA v3 is present**: Only CloakBrowser can reliably pass (with Pro version for 0.9 score)
2. **Behavioral detection**: The `humanize=true` flag simulates real mouse/keyboard patterns
3. **`yousoro_browse` is blocked**: it escalates here automatically, so this is
   usually not a call you make yourself

## Pro Version (Optional)

This is a **host-side** decision, and deliberately not something the agent is told
about: the licence note used to sit in `cloak_browse`'s prompt guidelines, where it
decided nothing at the call site (there is no Pro binary in the image to reach for)
and only invited the agent to suggest a purchase when a fetch failed. The skill now
tells it that a reCAPTCHA v3 miss is normal and to switch sources instead.

The free binary (v146) works for most sites. For the latest builds and guaranteed reCAPTCHA v3 0.9 score, you can provide a Pro license:

```bash
export CLOAKBROWSER_LICENSE_KEY=cb_your_license_key
```

The image will automatically download the Pro binary at runtime if the license key is set.

## Building the Image

The CloakBrowser version is automatically fetched from GitHub Releases during build:

```bash
# Newest free build for each architecture (the default)
sh build.sh

# Or pin an exact release tag -- check it has assets for BOTH arches first
CLOAKBROWSER_VERSION=chromium-v146.0.7680.177.4 sh build.sh
```

Tags look like `chromium-v146.0.7680.177.5`; Pro releases carry a `-pro` suffix
and auto-detection skips them. (An earlier version of this doc suggested
`CLOAKBROWSER_VERSION=0.4.12` — that tag format does not exist and would fail
with "release not found".)

### Detection is per-architecture, and the arches can differ

The build resolves the newest non-Pro release **that actually carries a binary
for the architecture being built**. That qualifier is load-bearing, because
CloakHQ publishes arm64 irregularly:

| release | assets |
|---|---|
| `chromium-v146.0.7680.177.5` | linux-x64, windows-x64 |
| `chromium-v146.0.7680.177.4` | **linux-arm64**, linux-x64, windows-x64 |
| `chromium-v146.0.7680.177.3` | **linux-arm64**, linux-x64 |
| `chromium-v146.0.7680.177.1` | linux-x64 |

So a multi-arch build legitimately ships **different point releases per arch** —
currently `.5` on x64 and `.4` on arm64. That is not a bug to fix; it is the only
way both legs get a binary at all.

It is also why the image is **not pinned to a single tag**. Pinning `.5` looks
reasonable and breaks the arm64 leg outright:

```
No CloakBrowser build for linux-arm64 in the releases checked.
Tags seen: chromium-v146.0.7680.177.5
```

If you do pin — to reproduce an older image, say — **check the tag has assets for
both arches first**. Whatever each leg resolved to is recorded in the image at
`/opt/cloakbrowser/RELEASE_TAG`, and the smoke test asserts it is not a `-pro`
build (a Pro binary without a licence fails at runtime, not at build time).

### Request cost

Detection is **one GitHub API request per build leg**. The releases list embeds
each release's assets, so there is nothing to follow up on; `per_page=100` is
GitHub's maximum and costs the same as any smaller page, which matters because
the newest arm64-bearing release can sit well down the list behind Pro-only and
x64-only releases.

An earlier version of this script re-fetched every tag individually — ~21
requests per leg, ~42 for a multi-arch build, against a limit of 60/hour.

### "Could not find a free CloakBrowser release" is usually a rate limit

If the build fails with:

```
ERROR: Could not find a free CloakBrowser release for linux-x64
The latest releases appear to be Pro-only.
```

**check your GitHub API quota before believing it.** Unauthenticated requests are
limited to **60/hour/IP**. When the limit is hit, the API returns
`{"message":"API rate limit exceeded"}`, which parses to zero releases — and the
old script reported that as a licensing problem, sending you to CloakHQ's
release page instead of to your API budget.

```bash
curl -s https://api.github.com/rate_limit     # "remaining": 0 means this is your problem
```

The installer now names this failure correctly. Three things make it much less
likely in the first place:

- it makes **one** API call instead of ~21 (the release list already embeds each
  release's assets; the old script re-fetched every tag individually, and a
  multi-arch build doubled that to ~42 against a limit of 60),
- it honours **`GITHUB_TOKEN`** if set (60/hour → 5000/hour),
- pinning `CLOAKBROWSER_VERSION` needs only a single tag lookup.

Note that anything else sharing your public IP spends the same quota — including
an agent doing GitHub research in the sandbox.

## Troubleshooting

### Canvas Fingerprinting Issues

If sites detect missing fonts (common in Linux containers), the image already includes:
- `fonts-noto-color-emoji`
- `fonts-freefont-ttf`
- `fonts-unifont`
- `fonts-ipafont-gothic`
- `fonts-wqy-zenhei`

### Binary Not Found

If you get "CloakBrowser binary not found" errors, the image may not have been built with the installation script. Rebuild the image:

```bash
sh build.sh
```

### reCAPTCHA Still Failing

The free binary (v146) may not pass the latest reCAPTCHA v3. Consider:
1. Using Pro version with license key
2. Switching to a different source — there is no third engine to fall back to
3. Adding a residential proxy (CloakBrowser supports `proxy` parameter)

## Files Modified

- `scripts/install-cloakbrowser.sh` - Downloads and installs latest CloakBrowser binary
- `Dockerfile` - Added font installation and CloakBrowser setup
- `pa-extensions/pa-cloakbrowser/index.ts` - Extension registering `cloak_browse` tool
- `pa-extensions/pa-cloakbrowser/selftest.mjs` - Guards the bounded preview, the two cache files, and the markdown/text rendering (run by `smoketest.sh`)
- `pa-extensions/_shared/cache.ts` - Shared output-caching module, incl. the footer both tools print (moved here from `pa-yousoro-browse/`)
- `pa-extensions/_shared/html-to-markdown.ts` - Regex HTML→Markdown/text used when there is no live DOM
- `pa-extensions/_shared/cloak.ts` - Shared binary spawn + `--dump-dom` fetch, used by `cloak_browse` and by `yousoro_browse`'s automatic escalation
- `build.sh` - Added `CLOAKBROWSER_VERSION` build argument
- `pa-skills/web-search/SKILL.md` - Updated with CloakBrowser documentation

## Future Improvements

Potential enhancements:
- **Drive the binary over CDP** and reuse `pa-yousoro-browse/markdown.ts`, so hidden elements are dropped and the two tools render identically (see above)
- Extract links (`extract` / `extract_attr`) the way `yousoro_browse` does; the shared cache module already stores an extracted TSV section
- Add proxy support parameters to the tool
- Implement persistent browser contexts
- Add screenshot capture capability
- Better error handling and retry logic
