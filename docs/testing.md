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
cache volume, exercising the real runtime path a user would hit:

| Check | Verifies |
|-------|----------|
| arbitrary uid resolves to a user | the entrypoint's passwd synthesis works |
| HOME is writable | the `0777` HOME model works for a non-baked uid |
| pi present | `pi --version` returns a version |
| node present | system Node is on `PATH` |
| mise present | mise binary is installed and runnable |
| playwright present | Playwright CLI works |
| chromium present | browser is at `/opt/ms-playwright` |
| no implicit auto-install on shim call | a bare `ruby`/etc call for a missing version does NOT trigger a compile |
| mise installs node@20 on demand (explicit) | explicit `mise use` install works as the uid |
| pi resolves to system node | `which pi` → `/usr/bin/pi` (not a mise shim) |
| pi still runs after node switch | pi is unaffected by mise Node changes |
| cache volume persists node@20 | the installed runtime survives across runs |
| passwordless sudo works | the agent can `sudo apt install` during a task |
| settings seeded with current version (no changelog) | `settings.json` gets `lastChangelogVersion` = installed pi version, so pi doesn't replay its changelog |
| trust.json seeded writable (Trust prompt can persist) | `~/.pi/agent/trust.json` is writable, so clicking "Trust" doesn't fail on a read-only mount |
| PI_RESUME_COMMAND=pa in image | the resume command name env is set to `pa` |
| resume-command patch applied to pi | pi's `formatResumeCommand` reads `PI_RESUME_COMMAND` and drops `--session-dir`, so it prints `pa --session <id>` |
| baked APPEND_SYSTEM.base.md present | container guidance is baked into the image |
| baked skill present | a skill is baked at `/opt/pa/skills` |
| baked extension present | an extension is baked at `/opt/pa/extensions` |
| baked extension loads (no load error) | pi loads the baked extension without error |
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
