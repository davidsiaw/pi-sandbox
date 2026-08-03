# Screenshots (`pa-screenshot`)

The image bakes a `pa-screenshot` extension that registers a **`screenshot_url`**
tool. It renders a URL in a fingerprint-masked headless Chromium (JS fully
executed) and **writes a PNG to a file**, returning the path — never the image
bytes.

- Extension source: `pa-extensions/pa-screenshot/index.ts`
- Baked at `/opt/pa/extensions/pa-screenshot`, loaded additively by `pa`
  (see [usage.md](usage.md#baked-skills--extensions)).
- Masking + block detection are shared with `pa-yousoro-browse` via
  `pa-extensions/_shared/stealth.ts` — see
  [yousoro-browsing.md](yousoro-browsing.md) for what the masking covers.
- Playwright is **not** bundled; it resolves the global install at
  `/usr/lib/node_modules/playwright` with browsers at `/opt/ms-playwright`.

## Why a file instead of an inline image

A tool *can* return `{ type: "image", … }` (pi's own `read` tool does). This one
deliberately does not:

- Base64 image bytes land in the **context window** and inflate ~33%. Full-page
  screenshots are routinely hundreds of KB; several in a row are expensive.
- A path is reusable. The agent can `read` it, pass it to `inspect_image`, diff
  it against a previous run, or just leave it for the human.

So the result is a one-line receipt:

```
Saved 1280x800 PNG (13 KB) to /Users/you/proj/ui.png
Page: My App — http://localhost:3000/
To view it, call inspect_image with image="/Users/you/proj/ui.png".
```

## Where the file goes

The `pa` launcher mounts **only the project directory** read-write, at its real
host path (`-v "$PWD:$PWD" --workdir="$PWD"`). Everything else in the container
is ephemeral. That single fact drives the path policy:

| `path` argument | Resolves to | Survives container exit? |
|---|---|---|
| omitted | `./screenshot-<host>-<timestamp>.png` | ✅ yes |
| `ui.png` | `<project>/ui.png` | ✅ yes |
| `out/ui/ui.png` | `<project>/out/ui/ui.png` (dirs created) | ✅ yes |
| `/tmp/ui.png` | `/tmp/ui.png` | ❌ **no** — warned in the receipt |
| `../escape.png` | — | rejected |
| `ui.jpg` | — | rejected (PNG only) |

Absolute paths outside the project are **allowed but warned about**, because a
scratch file is sometimes what you want — but output that silently vanishes is
worse than a refusal.

## It refuses rather than surprise you

**It will not overwrite.** Clobbering a screenshot destroys information with no
way to notice. The tool checks *before* launching a browser (so the failure is
instant) and names a free alternative:

```
A file already exists at /Users/you/proj/ui.png and screenshot_url will not overwrite it.
Retry with a different path, e.g. path="/Users/you/proj/ui-2.png", or delete the existing file first.
```

**It will not write a picture of a bot-block.** Measured from this sandbox on
`reddit.com/r/programming/`:

| Engine | Result |
|---|---|
| Plain Playwright, no masking | **HTTP 200** + "You've been blocked by network security" |
| Masked Chromium (this tool) | real page content |
| CloakBrowser `--humanize` | **HTTP 200** + reCAPTCHA "Prove your humanity" |

Both failures return **HTTP 200**. A tool that trusts the status code writes a
beautiful PNG of a CAPTCHA and reports success — plausible, silent, wrong, and
it costs a vision-model call to discover. So detection (visible text, never raw
HTML) gates the write: if the page looks blocked, **no file is created** and the
receipt explains why. The shared masking is what makes that rare in practice.

## Winning the render race

The most common way a screenshot tool lies is capturing a spinner. A page can
reach `networkidle` while its UI is still `loading…`. Two knobs:

- **`wait_for_selector`** — wait until a CSS selector is *visible* (max 15s).
  Preferred for JS-rendered UIs: it waits for the thing you care about, not a
  guess. If it never appears the tool errors and writes nothing.
- **`wait_ms`** — flat settle delay after load (default 2500).

```
screenshot_url url="http://localhost:3000" wait_for_selector="[data-testid=chart]" path="chart.png"
```

## Parameters

| Parameter | Default | Notes |
|---|---|---|
| `url` | — | http/https. Local addresses work (`http://localhost:3000`). |
| `path` | `./screenshot-<host>-<ts>.png` | Must end in `.png`. Never overwritten. |
| `full_page` | `false` | Entire scrollable page. Off by default: long pages make very large PNGs. |
| `selector` | — | Crop to one element's box. |
| `wait_for_selector` | — | Wait until visible before capturing (15s cap). |
| `width` / `height` | `1280` / `800` | Viewport size. |
| `scale` | `1` | `2` = retina-sharp text at ~4x the bytes. |
| `wait_ms` | `2500` | Settle delay after load. |
| `challenge_wait_ms` | `20000` | Max wait for a Cloudflare interstitial to clear. |
| `headed` | `false` | Headed Chromium behind Xvfb; clears some challenges headless cannot. |

## Relationship to the other browser tools

| Tool | Use it for |
|---|---|
| `screenshot_url` | **How a page looks.** Writes a PNG file. |
| `yousoro_browse` | **What a page says.** Returns text/links; scrolling, extraction, retries. |
| `cloak_browse` | Fallback engine with a different fingerprint profile when the others are blocked. |

`screenshot_url` intentionally does *not* return page text — that is
`yousoro_browse`'s job, and keeping the tools separate keeps each one's purpose
unambiguous to the model.

## Testing

`pa-extensions/pa-screenshot/selftest.mjs` is auth-free and runs in
`smoketest.sh`. It covers the output-path policy (`.png` required, traversal
rejected, inside/outside the project classified correctly), the
refuse-to-overwrite rule, and a real end-to-end capture asserting that **JS ran
before the shot** (the marker text exists only if it did) plus PNG magic bytes
and IHDR dimensions.

```bash
cd /opt/pa/extensions/pa-screenshot && node selftest.mjs
```
