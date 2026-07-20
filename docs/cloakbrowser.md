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
# Build with latest free binary
sh build.sh

# Or pin a specific version (if needed)
CLOAKBROWSER_VERSION=0.4.12 sh build.sh
```

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
