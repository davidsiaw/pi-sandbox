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
| auth.json seeded writable 0600 from ro staged host file | the host file is staged at `/opt/pa/auth.host.json` and copied into the ephemeral home; asserts the copy is writable and `0600` while the staged original stays read-only |
| no auth sources -> no auth.json written | with neither `PA_AUTH_SEED` nor a staged file, nothing is created — pi makes its own `{}`. Covers `MOUNT_AUTH=0` and the never-logged-in-yet case; a stub file here would mask a launcher problem |
| anthropic-oauth entry rebuilt from persisted token file | with **no** host `auth.json` at all, the entry is synthesized from `~/.pi/agent/auth2api/claude-*.json` with a future expiry. This is what makes a discarded container cost no re-login for oauth-only users |
| PA_AUTH_SEED beats host file; token file beats a stale seeded oauth entry | precedence in both directions. The second half matters: a stub staged from the host can name a refresh token auth2api already rotated away, which is the "works for a while, then every request fails" failure in [anthropic-oauth.md](anthropic-oauth.md) |
| corrupt newest token file falls back to previous readable one | auth2api rewrites those files on every rotation, so a crash mid-write leaves a truncated newest file. Regression test: the first version of `seed-auth.sh` only inspected the newest and gave up, forcing a re-login |
| pi can persist an oauth refresh to the seeded auth.json (no EACCES) | the regression the whole seed exists for. Drives pi's **real** `AuthStorage.modify` — the exact call that died with `Credential store modify failed for anthropic-oauth: EACCES` when the host file was mounted read-only at pi's path |
| entrypoint seeds from PA_AUTH_SEED then unsets it | a credential blob passed by env is consumed and removed before `exec`, so neither pi nor the agent inherits it (`docker inspect` on the host still shows it — unavoidable with `-e`) |
| pa-shaped run: staged auth.json + forwarded env var reaches the wire resolved | the whole credential chain, end to end, in the shape `pa` launches: project bind-mounted at its real path as the workdir, `models.json` and staged `auth.json` read-only, secret forwarded as an env var, under `no-new-privileges`. A loopback capture server asserts the outgoing request carries `Authorization: Bearer <resolved>` — so both the credential's `key` and a `models.json` header interpolated the var. Not a test of `pa` (that lives in its own repo); a test that the image honours what `pa` sets up |
| pa-shaped run: session written into the bind-mounted project dir | `--session-dir "$PWD/.pi-sessions"` inside a project mounted at its real host path actually produces a `.jsonl`, which is what makes sessions survive the container |
| unresolvable env-var key drops the provider from the catalog (no bogus key sent) | the sharp edge of env-var credentials: pi does **not** report an auth error, it removes the provider, so the only symptom is `No models match "<model>"`. This is the exact behaviour that made an empty 1Password field look like a model-config problem; pinned so the troubleshooting docs stay true |
| provider appears in the catalog once its env var resolves | the negative test above is not just asserting a permanently broken fixture |
| docker -e NAME inherits from the client env (secret stays out of argv) | `-e NAME` with no `=` is how the launcher keeps vault-resolved secrets out of its own command line, where host `ps` would expose them. Documented docker behaviour, but the one assumption in that change only a real daemon can confirm |
| legacy rw-mounted auth.json: other credentials preserved, oauth added | **backward compatibility, and the worst bug this script can have.** An older launcher bind-mounts the host `auth.json` read-write at pi's real path; `seed-auth.sh` must then use what is already there as its base. An early version rebuilt the file from the token file alone, which wrote through that mount and destroyed every other provider in the real file. Anyone still on an old launcher has to be able to pull a new image safely |
| legacy rw-mounted auth.json left byte-identical when there is nothing to add | under a legacy read-write mount every write lands on the host, so a no-op rewrite would churn the real credentials file on every launch. Asserted by md5, before and after |
| PI_RESUME_COMMAND=pa in image | the resume command name env is set to `pa` |
| resume-command patch reaches the tree the pi bin loads | the patch is checked in the directory of `package.json`'s `bin.pi` — the minified `dist/bundle/`, not the pretty `dist/modes/` tree. Grepping the pretty copy is how this test passed for a release while the CLI printed vanilla `pi --session-dir … --session <id>`: pi 0.84 moved the bin to a bundle and the patch went inert |
| pi bin prints `pa --session <id>` (no --session-dir) | functional, not textual: extracts `formatResumeCommand` from the bundle and calls it with a stub sessionManager, with and without `PI_RESUME_COMMAND`. Catches an upstream refactor that keeps the env-var reference but stops using it |
| update-command patch reaches the tree the pi bin loads | same bin-relative check for the "Update Available" banner |
| tool-execution patch reaches the tree the pi bin loads | `pi-agent-core` is inlined into the bundle; the functional `Agent` check below constructs it from `node_modules`, so the bundle copy needs its own assertion |
| baked APPEND_SYSTEM.base.md present | container guidance is baked into the image |
| baked skill present | a skill is baked at `/opt/pa/skills` |
| baked extension present | an extension is baked at `/opt/pa/extensions` |
| baked extension loads (no load error) | pi loads the baked extension without error |
| PA_PACKAGES-style mount visible at `/opt/pa/local-packages/<name>` | a host pi-package checkout bind-mounted the way the launcher mounts it is readable by the arbitrary uid |
| mounted host package is read-only | the agent cannot write into your private-package checkout; to edit it you run `pa` inside it |
| mounted private package extension loads (no load error) | `pi -e <mounted dir>` resolves a directory as a package (manifest `pi` key or convention dirs) instead of a single extension file |
| skills/ of a mounted package load from one `-e` flag | pi's local package source feeds `resolveExtensionSources`, whose accumulator carries skills too — so private skills need no separate `--skill`. Probed via a `before_agent_start` hook in the test package, so it reports a NOTE when the smoketest has no model auth |
| pa-checker selftest (read-only checker + bounded loop + fail-open) | The checker subprocess cannot write, edit or run commands — blocked by an allowlist, a denylist, and a `tool_call` hook that holds regardless of flags; a model with no `"checker"` key in `models.json` spawns nothing at all; the revision loop is bounded by `maxRounds` and ends in a shipped answer rather than another turn; a new request gets a fresh budget; a dead checker, a garbage verdict and a timeout all fail OPEN with the answer intact; interrupted and empty answers are never audited; the payload really carries the system prompt, request, tool log and answer; and `session_context` follows the session tree so an abandoned `/fork` branch is never shown to the auditor as history. Drives the real spawn path against a fake `pi` on `PATH` |
| pa-pdf selftest (offsets + windowing + search + render) | `pdf_map` reports a PDF's shape without returning its text; per-page offsets address the right page (the contract `pdf_read`/`pdf_search` will rest on); pages with no text layer are reported rather than silently empty; `pdf_read` windows are bounded, stop on a page boundary and hand back a continuation cursor that round-trips without overlap; `pdf_search` maps match offsets back to the right page, stays literal by default, and its page list feeds `pdf_read`; `pdf_render` rasterises a real PNG, caches per (page, dpi), and warns when a page already has text; and the `pdf-parse` borrowed from `pa-rag` still resolves |
| pa-anthropic-oauth selftest (survives session replacement) | `/resume` used to kill pi with "This extension ctx is stale after session replacement or reload": the usage poller's 60s interval was started in `session_start` with no `session_shutdown`, so it outlived its session and hit the throwing `ctx.ui` getter from a timer callback. Asserts no uncaught throw across three sessions, and no timer/stdout-listener pile-up |
| CloakBrowser is a free release (tag) | the baked `/opt/cloakbrowser/RELEASE_TAG` is not a `-pro` build — the Chromium version alone cannot distinguish them, and a Pro binary baked without a licence fails at runtime, long after the build looked fine |
| pa-cloakbrowser selftest (markdown rendering + two cache files) | `cloak_browse` runs `--dump-dom`, so a real page is hundreds of KB of markup (875 KB for a Wikipedia article) that used to be returned inline in one piece. Asserts the preview is bounded by `max_chars`; that BOTH cache files are written with a shared stem (`.txt` rendered body, `.html` raw DOM) and that the raw markup is NOT folded into the greppable body; that the shared footer names both; and that the regex renderer resolves relative hrefs, shortens same-document anchors, emits tight bullets and real pipe tables, keeps `<pre>` indentation (fences are restored *after* whitespace tidying — doing it before ate the indent), and leaves no tags behind; plus that challenge/CAPTCHA pages are now DETECTED from rendered text and reported as errors (`--dump-dom` exits 0 whatever it was served, so an interstitial used to look exactly like the article) |
| yousoro-browse selftest (fingerprint + detection + markdown) | runs `pa-yousoro-browse/selftest.mjs` in a real Chromium: asserts the fingerprint init script (webdriver=false, no leaked navigator own-props, userAgentData=Google Chrome, non-SwiftShader WebGL, spoofed hardwareConcurrency/platform/screen/dpr, stable canvas noise); that block/challenge detection keys off visible text not raw HTML (the 403-then-redirect fix); and that `format="markdown"` (now the DEFAULT) keeps headings, nested lists, `<ol start>`, tables, `<pre>` fences, blockquotes and code spans, resolves hrefs to absolute URLs, shortens same-document anchors to `#frag` (a prefix test here wrongly mangles every same-origin link — the check that caught it), and drops `display:none`/`visibility:hidden` subtrees that innerText also hides; plus that the raw DOM is always captured and cached to a sibling `.html`; and that a blocked fetch ESCALATES to CloakBrowser in code (call sits after the block guard, so a normal fetch pays nothing), clears the blocked flag on success, names the winning engine, drops the now-stale `extract` list, attributes the HTTP status to the failed attempt, and tells the agent either to stop retrying (both engines failed) or to call `cloak_browse` by name (escalate=false) |
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
