# Yousoro browsing (`pa-yousoro-browse`)

**Yousoro** (宜候) is the helmsman's call for "steady as she goes" — hold course.
The `yousoro_browse` tool holds a steady course past bot-blocks.

The image bakes a browsing extension, `pa-yousoro-browse`, that registers a
`yousoro_browse` tool. It fetches a page with a **fingerprint-masked Chromium**
(Playwright), waits out Cloudflare interstitial challenges, and retries
transient blocks — so the agent can read pages that reject plain headless
browsers (403/429/503) from the sandbox's datacenter IP.

- Extension source: `pa-extensions/pa-yousoro-browse/index.ts`
- Baked at `/opt/pa/extensions/pa-yousoro-browse`, loaded additively by `pa`
  (see [usage.md](usage.md#baked-skills--extensions)).
- Playwright is **not** bundled with the extension; it resolves the global
  install at `/usr/lib/node_modules/playwright` with browsers at
  `/opt/ms-playwright` (see [architecture.md](architecture.md) §2a).
- The `web-search` skill (`pa-skills/web-search/`) is written around this tool
  and documents which search engines/sources work from the sandbox IP.

## Why this exists

A plain headless Chromium leaks a pile of automation signals. Anti-bot systems
(Cloudflare, DataDome, PerimeterX, …) check them in milliseconds and serve a
challenge, CAPTCHA, or 403. The signals fall in layers, cheapest first:

1. **JS/DOM fingerprint** — `navigator.webdriver`, empty `navigator.plugins`,
   `navigator.userAgentData` reporting *Chromium* / *HeadlessChrome* instead of
   *Google Chrome*, default viewport, WebGL renderer = *SwiftShader* (no GPU in
   a container), etc.
2. **CDP leak** — automation libs call `Runtime.enable`, historically
   observable from the page.
3. **Network layer** — TLS/JA3 handshake shape, HTTP/2 frame ordering, IP
   reputation. Not reachable from page JS.

`yousoro_browse` closes layer 1 (and, on current Playwright, layer 2 is already
closed upstream). Layer 3 is **not** addressed — see [What it does and does not
fix](#what-it-does-and-does-not-fix).

## What the tool does

For each fetch it:

1. Launches Chromium (headless by default; optionally headed — see below) with
   `--no-sandbox --disable-blink-features=AutomationControlled
   --disable-features=IsolateOrigins,site-per-process`.
2. Creates a context spoofing a **Google Chrome on macOS** identity, all pinned
   to the *real* bundled engine's major version so nothing disagrees:
   - `userAgent` — `...Chrome/<major>.0.0.0 Safari/537.36`
   - `sec-ch-ua` header — claims `"Google Chrome"` + `"Chromium"` at `<major>`
   - viewport `1280x800`, `locale en-US`, timezone `Asia/Tokyo`
   - does **not** override `Accept` (forcing it makes some sites, e.g. Reddit,
     serve a minimal SSR fallback)
3. Injects an init script (page main world) that:
   - defines `webdriver`/`plugins`/`languages` on `Navigator.prototype`
     (not the instance — instance own-props are themselves a tell)
   - `navigator.webdriver` → `false` (real Chrome value; `undefined` is a tell)
   - replaces `navigator.userAgentData` wholesale so `brands` and
     `getHighEntropyValues()` report *Google Chrome* (the instance is
     non-extensible, so a per-instance override silently no-ops)
   - overrides `getParameter` on **both** `WebGLRenderingContext.prototype`
     and `WebGL2RenderingContext.prototype` so
     `UNMASKED_VENDOR_WEBGL`/`UNMASKED_RENDERER_WEBGL` report a real Intel Mac
     GPU instead of SwiftShader, keeping a native-looking `toString()`
   - spoofs the permissions/notifications query
4. Navigates, waits `wait_ms`, then **waits out Cloudflare interstitials**
   ("Just a moment", "Checking your browser", `challenge-platform`, …): these
   run JS then redirect, so it polls until the challenge markers vanish (up to
   `challenge_wait_ms`) instead of treating the first paint as a block.
5. Treats real blocks (403/429/503, or CAPTCHA/verification markers) as
   `blocked` and retries with backoff up to `max_attempts`.
6. Optionally scrolls for lazy/infinite-scroll feeds and extracts elements by
   CSS selector.

### Parameters

| Param | Default | Purpose |
|-------|---------|---------|
| `url` | — | page to fetch (http/https) |
| `extract` | — | CSS selector; returns innerText of every match |
| `extract_attr` | — | also return an attribute per match; use `href` (resolved absolute URL) with `extract="a"` to collect links |
| `wait_ms` | 2500 | wait after load for JS to settle |
| `max_attempts` | 4 | retries with backoff when the page looks blocked |
| `scroll` | 0 | scroll-to-bottom passes (infinite-scroll feeds) |
| `scroll_wait_ms` | 1500 | wait after each scroll pass |
| `challenge_wait_ms` | 20000 | max wait for a Cloudflare interstitial to auto-solve and redirect |
| `headed` | false | run headed Chromium behind a virtual X display (see below) |
| `max_chars` | 8000 | truncate returned page text |

## Headed mode + Xvfb

`headed=true` launches a non-headless Chromium. A container has no display, so
the extension **spawns an Xvfb virtual framebuffer** (`:99`, 1280x800x24) and
points Chromium at it via `DISPLAY`, tearing it down when the browser closes. If
`DISPLAY` is already set (a real/forwarded X server), it reuses that and spawns
nothing.

- `xvfb` is installed in the image by `scripts/install-system-deps.sh`.
- Headed mode removes a class of headless-only tells, but in a **GPU-less
  container it does not fix WebGL** (still SwiftShader) or the network layer, so
  on its own it made no measurable difference against hard gates in testing. It
  is a building block, off by default.

## What it does and does not fix

Measured against the [rebrowser bot-detector](https://bot-detector.rebrowser.net/)
and direct probes, from the sandbox:

**Fixed (green):**

- `navigator.webdriver` (reports `false`, no leaked own-props)
- `userAgentData` / `sec-ch-ua` → *Google Chrome* at the real major version
- viewport (non-default)
- WebGL `UNMASKED_*` → real Intel GPU (SwiftShader hidden)
- `runtimeEnableLeak` — already fixed upstream in the bundled Playwright
  (verified green with raw Playwright), so no CDP patch is applied

**Not fixed (out of scope for page-JS spoofing):**

- **TLS/JA3 fingerprint** — Chromium's handshake still differs from real Chrome;
  it's a network-layer signal unreachable from page JS.
- **IP reputation** — the sandbox egresses from a datacenter IP.
- **Image CAPTCHAs** (e.g. PyPI) and the **hardest managed challenges** (e.g.
  `find.4chan.org`) — need a solver or a residential IP, not a better
  fingerprint.

### Observed effect on the `web-search` blocklist

After these changes, several sources the `web-search` skill had marked blocked
started working from the sandbox; the skill was updated to match:

| Source | Before | After |
|--------|--------|-------|
| Bing | CAPTCHA | works |
| GitLab | Cloudflare "Just a moment" 403 | works |
| WebCrawler | Cloudflare 403 | works |
| Yandex | SmartCaptcha | works |
| Mojeek | ALTCHA CAPTCHA | still blocked — now **correctly reported** `blocked:true` |
| PyPI | image CAPTCHA | still blocked |
| find.4chan.org | Cloudflare managed challenge | still blocked |

## Editing / rebuilding

The extension is TypeScript loaded by pi at runtime; no separate build step is
required for pi. To sanity-check it bundles cleanly before rebuilding the image:

```bash
cd pa-extensions/pa-yousoro-browse
npx esbuild index.ts --bundle --format=esm --platform=node \
  --external:typebox --external:@earendil-works/pi-coding-agent --outfile=/dev/null
```

Then rebuild a single-arch image and smoke-test (see
[testing.md](testing.md)). The smoke test's "baked extension loads (no load
error)" check confirms the extension still loads after edits.
</content>
</invoke>
