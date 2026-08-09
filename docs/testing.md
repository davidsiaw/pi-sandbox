# Testing: `smoketest.sh`

`smoketest.sh` verifies an **existing** image end to end. It does not build
anything — build or pull the image first, then test it.

```bash
sh smoketest.sh                 # test davidsiaw/pi-sandbox:latest
IMAGE=... sh smoketest.sh       # test a specific image/tag
KEEP=1 sh smoketest.sh          # keep the test cache volume for debugging
UID_TEST=4321 sh smoketest.sh   # run the checks as a different arbitrary uid
```

If the image isn't present locally the script tells you to build or pull it and
exits non-zero.

## What it checks

Everything runs as an **arbitrary uid** (default `1234`) with a temporary mise
cache volume, exercising the real runtime path a user would hit.

> The cache volume is **fresh** on every run, and `shims/` lives inside it — so
> no runtime is installed and there are no shims. Ruby checks therefore assert
> the *configuration* (the baked pin, PATH order, precedence) rather than a
> working `ruby` binary, and the suite prints a `NOTE` instead of a `FAIL` when
> Ruby is not built in the volume. That is expected, not a failure.


| Check | Verifies |
|-------|----------|
| arbitrary uid resolves to a user | the entrypoint's passwd synthesis works |
| HOME is writable | the `0777` HOME model works for a non-baked uid |
| pi present | `pi --version` returns a version |
| node present | system Node is on `PATH` |
| mise present | mise binary is installed and runnable |
| playwright present | Playwright CLI works |
| chromium present | browser is at `/opt/ms-playwright` |
| pdftoppm on PATH (poppler-utils) | `pdf_render` can rasterise scanned PDF pages for `inspect_image`; without it scanned PDFs are unreadable |
| no implicit auto-install on shim call | a bare `ruby`/etc call for a missing version does NOT trigger an install |
| uninstalled .ruby-version stayed uninstalled | `installs/ruby` is still empty afterwards (checks the directory, not `mise ls`, which also lists merely-requested versions) |
| ruby 3.4 pinned as system default | `/etc/mise/config.toml` pins a default that survives restarts |
| default comes from baked /etc/mise/config.toml | the pin is read from the image, not from the wiped `~/.config` |
| mise shims on PATH in a login shell | `mise activate` stripped them, leaving pi's children with no runtimes |
| mise shims are FIRST on PATH (beat /usr/bin) | ordering is load-bearing: appended instead of prepended, `mise use -g node@20` silently returns the system v22 |
| .ruby-version is honored | mise ignores idiomatic version files by default, which would let the pinned default silently override a project's own version |
| system default resolves to a 3.4.x | the pin actually resolves, not just parses |
| mise installs node@20 on demand (explicit) | explicit `mise use` install works as the uid |
| pi resolves to system node | `which pi` → `/usr/bin/pi` (not a mise shim) |
| pi still runs after node switch | pi is unaffected by mise Node changes |
| cache volume persists node@20 | the installed runtime survives across runs |
| passwordless sudo works (pa --sudo path) | the image keeps its sudoers rule, so `pa --sudo` has something to run |
| sudo denied under no-new-privileges (pa default) | the flag `pa` passes by default makes the kernel ignore sudo's setuid bit; verified by message, not just exit code |
| pa-apt installs a package with deps without sudo | `jq` (needs libjq1 + libonig5) installs and runs under `no-new-privileges`, covering dependency resolution and the profile.d PATH wiring |
| pa-apt no-ops on an already-installed package | an already-satisfied package reports so instead of erroring |
| settings seeded with current version (no changelog) | `settings.json` gets `lastChangelogVersion` = installed pi version, so pi doesn't replay its changelog |
| trust.json seeded writable (Trust prompt can persist) | `~/.pi/agent/trust.json` is writable, so clicking "Trust" doesn't fail on a read-only mount |
| PI_RESUME_COMMAND=pa in image | the resume command name env is set to `pa` |
| resume-command patch applied to pi | pi's `formatResumeCommand` reads `PI_RESUME_COMMAND` and drops `--session-dir`, so it prints `pa --session <id>` |
| baked APPEND_SYSTEM.base.md present | container guidance is baked into the image |
| baked skill present | a skill is baked at `/opt/pa/skills` |
| baked extension present | an extension is baked at `/opt/pa/extensions` |
| baked extension loads (no load error) | pi loads the baked extension without error |
| pa-pdf selftest (offsets + windowing + search + render) | `pdf_map` reports a PDF's shape without returning its text; per-page offsets address the right page (the contract `pdf_read`/`pdf_search` will rest on); pages with no text layer are reported rather than silently empty; `pdf_read` windows are bounded, stop on a page boundary and hand back a continuation cursor that round-trips without overlap; `pdf_search` maps match offsets back to the right page, stays literal by default, and its page list feeds `pdf_read`; `pdf_render` rasterises a real PNG, caches per (page, dpi), and warns when a page already has text; and the `pdf-parse` borrowed from `pa-rag` still resolves |
| pa-anthropic-oauth selftest (survives session replacement) | `/resume` used to kill pi with "This extension ctx is stale after session replacement or reload": the usage poller's 60s interval was started in `session_start` with no `session_shutdown`, so it outlived its session and hit the throwing `ctx.ui` getter from a timer callback. Asserts no uncaught throw across three sessions, and no timer/stdout-listener pile-up |
| CloakBrowser is a free release (tag) | the baked `/opt/cloakbrowser/RELEASE_TAG` is not a `-pro` build — the Chromium version alone cannot distinguish them, and a Pro binary baked without a licence fails at runtime, long after the build looked fine |
| yousoro-browse selftest (fingerprint + detection) | runs `pa-yousoro-browse/selftest.mjs` in a real Chromium: asserts the fingerprint init script (webdriver=false, no leaked navigator own-props, userAgentData=Google Chrome, non-SwiftShader WebGL, spoofed hardwareConcurrency/platform/screen/dpr, stable canvas noise) and that block/challenge detection keys off visible text not raw HTML (the 403-then-redirect fix) |
| no host append -> target equals baked base | merge falls back to base when no host file staged |
| host append is merged first | staged host append leads the assembled file |
| host + base both present in merge | merge includes both host and baked content |

Output is colored `PASS`/`FAIL`; the script exits non-zero if any check fails,
so it's CI-friendly.

## Cleanup behavior

- The temporary cache volume (`pa-smoketest-mise`) is removed on exit, pass or
  fail (unless `KEEP=1`).
- The **image is never touched** — the script neither builds nor deletes images.

## Architecture note

The test runs the image for the **current host architecture** (whatever
`docker run` picks from a multi-arch image, or whatever single-arch image you
built with `--load`). To smoke-test a specific arch, build/pull that arch's
image locally and point `IMAGE` at it.

## Typical local loop

```bash
# 1. build a locally-runnable single-arch image
docker buildx build --platform linux/arm64 -t davidsiaw/pi-sandbox:latest --load .

# 2. test it
sh smoketest.sh

# 3. when happy, build+push both arches
sh build.sh
```
