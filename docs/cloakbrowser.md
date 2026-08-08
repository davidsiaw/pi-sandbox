# CloakBrowser Integration

## Overview

The `pi-sandbox` image now includes **CloakBrowser** (free v146 binary) as a third browsing option alongside `yousoro_browse` and `camoufox_browse`.

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
cloak_browse url="https://example.com" humanize=true format="html"
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | required | URL to fetch (http/https only) |
| `humanize` | boolean | true | Enable human-like behavior (Bézier curves, realistic typing) |
| `headless` | boolean | true | Run in headless mode |
| `format` | enum | "html" | Response format: "html" or "markdown" |
| `fingerprint` | string | optional | Fixed fingerprint seed for consistent identity |

## Tool Comparison

| Tool | Engine | Strengths | Best For |
|------|--------|-----------|----------|
| `yousoro_browse` | Chromium (JS patches) | Fast, lightweight, Cloudflare 403-then-redirect | General browsing, Cloudflare challenges |
| `camoufox_browse` | Firefox (C++ patches) | C++ fingerprint spoofing, different profile | DataDome, PerimeterX, Turnstile |
| `cloak_browse` | Chromium (C++ patches) | **reCAPTCHA v3**, TLS spoofing, behavioral | reCAPTCHA v3, Turnstile, behavioral detection |

## When to Use CloakBrowser

Use `cloak_browse` when:

1. **reCAPTCHA v3 is present**: Only CloakBrowser can reliably pass (with Pro version for 0.9 score)
2. **Behavioral detection**: The `humanize=true` flag simulates real mouse/keyboard patterns
3. **Other tools fail**: Try as a last resort when `yousoro_browse` and `camoufox_browse` are blocked

## Pro Version (Optional)

The free binary (v146) works for most sites. For the latest builds and guaranteed reCAPTCHA v3 0.9 score, you can provide a Pro license:

```bash
export CLOAKBROWSER_LICENSE_KEY=cb_your_license_key
```

The image will automatically download the Pro binary at runtime if the license key is set.

## Building the Image

The CloakBrowser version is automatically fetched from GitHub Releases during build:

```bash
# Build with the newest free binary
sh build.sh

# Or pin an exact release tag
CLOAKBROWSER_VERSION=chromium-v146.0.7680.177.5 sh build.sh
```

Tags look like `chromium-v146.0.7680.177.5`; Pro releases carry a `-pro` suffix
and auto-detection skips them. (An earlier version of this doc suggested
`CLOAKBROWSER_VERSION=0.4.12` — that tag format does not exist and would fail
with "release not found".)

**The image pins an exact tag by default** (`ARG CLOAKBROWSER_VERSION` in the
Dockerfile). The pin lives there rather than in `build.sh` because CI calls
`docker/build-push-action` directly and never goes through `build.sh` — a pin in
the script would leave CI builds drifting.

Why pin, given auto-detection works? Reproducibility: `build.sh` publishes
`davidsiaw/pi-sandbox:<pi-version>`, and without a pin two builds of the *same*
tag can ship different browsers. It costs nothing today — CloakHQ's 148 and 150
lines are Pro-only, so auto-detection resolves to the pinned tag anyway. (It does
**not** save an API call: both paths now make exactly one.)

The pin does not follow upstream on its own. The nightly `check` job compares it
against the newest free release and **files an issue** when it falls behind — not
a warning annotation, which nobody reads on a green run, and not an automatic
bump, because a push to master publishes to Docker Hub and would ship an
untested browser as `:latest`.

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
2. Trying `camoufox_browse` as an alternative (Firefox-based)
3. Adding a residential proxy (CloakBrowser supports `proxy` parameter)

## Files Modified

- `scripts/install-cloakbrowser.sh` - Downloads and installs latest CloakBrowser binary
- `Dockerfile` - Added font installation and CloakBrowser setup
- `pa-extensions/pa-cloakbrowser/index.ts` - Extension registering `cloak_browse` tool
- `build.sh` - Added `CLOAKBROWSER_VERSION` build argument
- `pa-skills/web-search/SKILL.md` - Updated with CloakBrowser documentation

## Future Improvements

Potential enhancements:
- Add proxy support parameters to the tool
- Implement persistent browser contexts
- Add screenshot capture capability
- Better error handling and retry logic
