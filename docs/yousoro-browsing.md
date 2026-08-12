# Yousoro browsing (`pa-yousoro-browse`)

**Yousoro** (宜候) is the helmsman's call for "steady as she goes" — hold course.
The `yousoro_browse` tool holds a steady course past bot-blocks.

The image bakes a browsing extension, `pa-yousoro-browse`, that registers a
`yousoro_browse` tool. It fetches a page with a **fingerprint-masked Chromium**
(Playwright), waits out Cloudflare interstitial challenges, and retries
transient blocks — so the agent can read pages that reject plain headless
browsers (403/429/503) from the sandbox's egress IP.

- Extension source: `pa-extensions/pa-yousoro-browse/index.ts`
- Output caching lives in `pa-extensions/_shared/cache.ts`, shared with
  `cloak_browse` (see [cloakbrowser.md](cloakbrowser.md#output-caching)).
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
   - adds **per-session canvas + audio fingerprint noise** (see below)
   - spoofs the permissions/notifications query
4. Navigates, waits `wait_ms`, then (unless `humanize=false`) emits brief
   **human-ish mouse movement and scroll** so behavior-scoring gates don't see a
   zero-interaction session (see below).
5. **Waits out Cloudflare interstitials** — see [The 403-then-redirect
   pattern](#the-403-then-redirect-pattern) below.
6. Treats real blocks (403/429/503, or CAPTCHA/verification markers) as
   `blocked` and retries with backoff up to `max_attempts` (default 2 — see
   [Backoff budget](#backoff-budget-one-retry-then-a-different-engine)).
7. Optionally scrolls for lazy/infinite-scroll feeds and extracts elements by
   CSS selector.

### The 403-then-redirect pattern

Many Cloudflare-fronted sites (Stack Overflow, Stack Exchange, GitLab, …) do
**not** hard-block a headless browser. Instead they use a *403-then-redirect*
gate:

1. The first response is the **interstitial**, usually **HTTP 403**, with title
   `"Just a moment…"` and visible text like *"Checking your browser…"* /
   *"Verifying you are human…"*.
2. Cloudflare's JavaScript runs its fingerprint checks in that page.
3. **If the fingerprint passes**, it redirects/renders the **real content** —
   same URL, now a normal page. If it fails, you stay on the interstitial (or
   get a CAPTCHA).

So an initial `403` is *not* a definitive block on these sites — it's the
challenge gate. `yousoro_browse` waits for the interstitial to clear (up to
`challenge_wait_ms`, default 20s); if it does, the initial 403 is treated as a
`200`, because the fingerprint masking (Google-Chrome UA, real WebGL GPU,
`webdriver:false`, canvas/audio noise, human-ish interaction) got us through.

**The critical detail — detect on VISIBLE text, not raw HTML.** When the
challenge clears, Cloudflare **leaves its challenge `<script>` tags in the DOM**
(`challenge-platform`, `cf_chl_opt`, `cf-chl`, `cf-browser-verification`). Those
strings persist in `page.content()` (raw HTML) on the *fully loaded, real* page.
Early versions matched against raw HTML and so reported a perfectly good page as
`blocked: true` — a false positive. The fix: all block/challenge detection keys
off **`document.title` + `document.body.innerText`** (what a human actually
sees), which flips to the real page the instant it renders and never contains
the leftover script markers. See `looksChallenge` / `visibleText` and the note
on `CHALLENGE_MARKERS` in `index.ts`.

This is why Stack Overflow, Stack Exchange, GitLab, Bing, WebCrawler, and Yandex
now succeed from the sandbox: they use fingerprint-gated 403-then-redirect, which
the masking clears — as opposed to CAPTCHA/managed challenges (PyPI search, Mojeek,
`find.4chan.org`), which don't.

### Backoff budget: one retry, then a different engine

`max_attempts` defaults to **2**, and a block that retrying cannot fix skips the
backoff entirely.

It used to be 4, which meant a blocked page slept **27 seconds** (6+9+12s) and
loaded three extra times *before CloakBrowser was tried at all*. That ordering is
backwards. A second identical request from the same engine, same fingerprint and
same IP rarely changes a block; a different engine sometimes does. So the cheap
retry happens once — for a genuinely transient hiccup — and after that the budget
goes to escalation, which is the thing that might actually work.

On top of that, `looksHopeless()` (in `_shared/stealth.ts`) recognises blocks where
even one retry is pointless, because they are a verdict on the IP or a puzzle a
human must solve: Google's `/sorry/`, image CAPTCHAs, ALTCHA-style client
challenges. Those break out of the loop immediately — 1 load, 0s of sleeping.

It does **not** suppress escalation: `result.blocked` is still set, so CloakBrowser
still gets its one try. What is skipped is only re-asking the same engine the same
question. Measured on Google's `/sorry/`: 27s and 3 page loads saved.

### The block that reported success: Google's `/sorry/`

Worth calling out, because it defeated all three signals at once and was found in
a live drive rather than by a test. Google redirects a datacenter IP to
`/sorry/index?continue=...`, and that page:

- returns **HTTP 200**, so the `403/429/503` check passes it;
- takes the **requested URL as its `<title>`**, so nothing looks challenge-like;
- says *"detected unusual traffic … not a robot"*, which matched none of the
  `BLOCK_MARKERS` (`"are you a robot"`, `"i'm not a robot"` — close, but not it).

So a fetch of a page whose entire content is the refusal was reported as
`Blocked: false`, `Status: 200`, and **escalation never fired** — the worst kind
of failure, since the caller gets a plausible-looking success. `BLOCK_MARKERS` now
carries Google's own wording (`"detected unusual traffic"`).

The bare phrase `"not a robot"` was deliberately *not* added: a page explaining
how CAPTCHAs work contains it, and a false block is worse than a missed one — it
throws away good content *and* spends a CloakBrowser fetch. Both directions are
asserted in `pa-yousoro-browse/selftest.mjs`.

### Canvas + audio fingerprint noise

Anti-bot systems hash a canvas render or an `AudioContext` buffer into a stable
device fingerprint. Two problems for the sandbox: headless SwiftShader produces a
*known* fingerprint that flags automation, and a perfectly identical fingerprint
across "different users" from one image is itself suspicious.

The init script shims `CanvasRenderingContext2D.getImageData`,
`HTMLCanvasElement.toDataURL`, `AudioBuffer.getChannelData`, and
`AnalyserNode.getFloatFrequencyData` to inject an imperceptible perturbation
(±1 on a few pixel channels; ~1e-7 on audio samples). Key property: all
perturbations derive from **one random seed per page load and reset to it before
each read**, so the fingerprint is *stable within a session* but off the known
headless baseline. (A hash that changes on every read is itself a tell — that's
what naive anti-fingerprinting does.) `toString()` on each shim returns the
original's, so the patched methods still look native.

### Human-ish interaction (`humanize`)

After load, the tool moves the mouse along a short jittery path and does a couple
of small scroll nudges before reading the page, so behavior-scoring gates see
*some* organic interaction instead of a zero-interaction session. It's
best-effort (never fails the fetch) and adds ~1–2s. Set `humanize=false` for the
fastest possible fetch.

### Parameters

| Param | Default | Purpose |
|-------|---------|---------|
| `url` | — | page to fetch (http/https) |
| `extract` | — | CSS selector; returns innerText of every match |
| `extract_attr` | — | also return an attribute per match; use `href` (resolved absolute URL) with `extract="a"` to collect links |
| `wait_ms` | 2500 | wait after load for JS to settle |
| `max_attempts` | 2 | one retry with backoff, then escalate; see [Backoff budget](#backoff-budget-one-retry-then-a-different-engine) |
| `scroll` | 0 | scroll-to-bottom passes (infinite-scroll feeds) |
| `scroll_wait_ms` | 1500 | wait after each scroll pass |
| `challenge_wait_ms` | 20000 | max wait for a Cloudflare interstitial to auto-solve and redirect |
| `format` | `markdown` | `markdown` = structure + inline link URLs (see below); `text` = flat innerText; `html` = raw DOM |
| `headed` | false | run headed Chromium behind a virtual X display (see below) |
| `max_chars` | 8000 | inline budget for page text (the full text is always cached) |
| `max_items` | 50 | inline budget for the `extract` list (the full list is always cached) |

## `format="markdown"` (the default)

`format="text"` is `document.body.innerText`. It is flat: headings, list nesting
and **every link URL** are gone. That last one costs a round trip — the agent can
see that a link exists but not where it points, so it re-fetches with
`extract="a" extract_attr="href"` and then re-aligns two lists by hand. That is
why it is no longer the default.

`format="markdown"` walks the DOM instead and emits headings, lists (nested,
`<ol start>` honoured), tables, `<pre>` fences, blockquotes, `**bold**`, code
spans, and links as `[text](url)` with hrefs already resolved to absolute URLs.

```
innerText:   Ruby is a general-purpose programming language ... Yukihiro Matsumoto
markdown:    [Ruby](https://en.wikipedia.org/wiki/Ruby_(programming_language)) is a
             [general-purpose programming language](https://en.wikipedia.org/wiki/...)
```

The conversion runs **inside the page** (`page.evaluate`), not over a serialised
HTML string in Node. That is what makes `Element.checkVisibility()` available, so
`display:none` menus, collapsed accordions and hidden cookie banners are dropped
— a Node-side HTML converter cannot tell a rendered nav from a hidden one. It
also means no `turndown` dependency, and it operates on the DOM we already have:
post-JS, post-`scroll`, post-challenge. Source: `pa-yousoro-browse/markdown.ts`.

Two deliberate reductions, both measured on the Wikipedia article for Ruby:

- **Same-document anchors collapse to `#frag`.** A table of contents otherwise
  repeats the full page URL on every entry: 94 KB → 86.5 KB for that one change.
- **`javascript:` links keep their label and lose the target**, which goes
  nowhere anyway.

### What it costs

Same page: **innerText 41 KB, markdown 86.5 KB** (639 inline links). URLs cost
characters — but **not context**, because the inline preview is capped by
`max_chars` either way. Markdown simply packs more information into the same
budget, which is why it is the default. The extra bytes land in the cache file,
which is free. `format="text"` remains available when you want prose with no
markup at all.

This is not a general-purpose HTML→Markdown library. It covers the subset an
agent reads; anything unrecognised degrades to its text.

## Automatic escalation to CloakBrowser

A blocked fetch used to end with `Blocked: true` and no suggestion. Agents were
observed **reporting failure to the user instead of reaching for
`cloak_browse`** — the tool that exists for exactly this case and defeats what
Playwright-with-patches cannot (reCAPTCHA v3, behaviour scoring). Guidance in a
system prompt is too far from that moment to be acted on reliably.

So when a fetch ends up blocked, `yousoro_browse` retries it with CloakBrowser
itself and returns that content:

```
Status: n/a (CloakBrowser reports none; yousoro saw 403)  Attempts: 1  Blocked: false
Title: The Real Article
Format: markdown  Engine: cloakbrowser (yousoro was blocked; escalated automatically)
```

- It runs **only after a block**, so a normal fetch pays nothing.
- The header always names the engine, so a reader knows what produced the bytes.
- CloakBrowser reports no HTTP status, so the status is attributed to the failed
  yousoro attempt rather than printed next to `Blocked: false` as if it applied.
- `extract` results are **dropped** on escalation: they matched the blocked page,
  not the content now returned. Re-run with the same selector to extract from it.
- `escalate=false` turns it off; the blocked output then names `cloak_browse` and
  the URL explicitly, so the model has a concrete next step either way.

If the escalated fetch is *also* blocked, the result says both engines failed and
to stop retrying — that is a genuinely unreachable site, not a tool choice
problem.

The spawn logic lives in `pa-extensions/_shared/cloak.ts`, shared with
`pa-cloakbrowser`, so the container flags cannot drift between the two callers.
`cloak_browse` gained the same visible-text block detection at the same time: it
runs `--dump-dom`, which exits 0 whatever it was served, so before this a
Cloudflare interstitial came back looking exactly like the article.

## Output caching: two files per fetch

Every fetch writes **two** files and reports both paths. The inline result is
only a preview.

```
/tmp/pa-browse-<host>-<ts>-<rand>.txt    complete rendered body (+ extract list)
/tmp/pa-browse-<host>-<ts>-<rand>.html   raw DOM exactly as fetched
```

The pair shares a stem and differs only in extension. That is the whole "curl for
web pages" idea: you get something readable by default, and the raw markup is
still on disk for when you suspect the rendering dropped something — a table, a
form field, a value that should have been there. Reading the `.html` beats
re-fetching with `format="html"`: it is the same bytes, without a second request.

The raw markup is a separate file rather than a third section of the `.txt`
deliberately: the rendered body exists to be `rg`-ed, and folding 875 KB of
markup into it would make every search hit twice and bury the readable match.
(When `format="html"` is requested, the body already *is* the raw DOM, so no
duplicate `.html` is written.)

Caching also fixes two ways output used to be lost outright:

- `extract` was **uncapped**. `extract="a"` on a link-dense page emitted every
  match into the context window — a Wikipedia article yields 483 links, i.e.
  ~966 lines of tool result.
- Page text was capped by `max_chars` and **the remainder was discarded**.
  Truncation is head-first, so on a long page it is the *bottom* that vanishes —
  the part `scroll` had just paid to load. Recovery meant re-fetching.

The body section is labelled by what it actually is — `=== PAGE MARKDOWN ===`,
`=== PAGE TEXT ===` or `=== PAGE HTML ===` — so a reader grepping the file knows
which it got. The report gives exact line ranges, so `read offset=` lands on data
rather than a header:

```
--- Full content cached ---
  Rendered: /tmp/pa-browse-en.wikipedia.org-20260811-225859-8b45.txt  (134 KB, 1181 lines)
  Raw HTML: /tmp/pa-browse-en.wikipedia.org-20260811-225859-8b45.html  (857 KB, 2119 lines)
  Sections: extracted TSV lines 2-484, page body lines 487-741
  Truncation is head-first, so the TAIL is only in the file.
  Tail:   read path="..." offset=1081
  Search: rg -n "pattern" "..."
  Rendering looks wrong or incomplete? Read the raw HTML file above.
```

The extract list is stored as **TSV** (`text<TAB>attr`, one record per line, tabs
and newlines in link text collapsed to spaces) so `rg` and `cut` work on it
directly. The inline preview keeps the numbered human-readable form.

`/tmp` matches pi's own `bash` tool, which spills oversized output to
`/tmp/pi-bash-<id>.log` the same way. Files die with the container, which is the
right lifetime for a fetch. A cache write failure never fails the fetch — the
preview is still returned, with a note saying the remainder is unavailable.

This is why raising `max_chars` is rarely the right move: the content is already
on disk.

The module is `pa-extensions/_shared/cache.ts`, and `cloak_browse` uses it —
including `formatCacheFooter`, so **both tools print the identical footer**.
There is nothing extra for an agent to learn per tool. Its unit checks live in
`pa-yousoro-browse/selftest.mjs` and `pa-cloakbrowser/selftest.mjs`.

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
- **IP reputation** — the sandbox egresses from whatever IP Docker resolves (home/ISP on macOS, datacenter on cloud).
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
| Stack Overflow | 403-then-redirect (was false-flagged blocked) | works |
| Stack Exchange | 403-then-redirect (was false-flagged blocked) | works |
| Mojeek | ALTCHA CAPTCHA | still blocked — now **correctly reported** `blocked:true` |
| PyPI | image CAPTCHA | still blocked |
| find.4chan.org | Cloudflare managed challenge | still blocked |

Stack Overflow / Stack Exchange are the case that motivated the visible-text
detection fix: they *did* clear the challenge, but leftover CF scripts in the
raw HTML made the old detector report them blocked. See
[The 403-then-redirect pattern](#the-403-then-redirect-pattern).

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
