# Troubleshooting

## Chromium won't launch / crashes immediately

Chromium's own sandbox needs kernel capabilities most containers don't grant, so
a headless launch inside the container often needs one of:

- Launch Chromium with `--no-sandbox` in the Playwright launch args
  (pragmatic for a disposable sandbox), **or**
- Give the container `--cap-add=SYS_ADMIN` (keeps Chromium's sandbox intact but
  grants the container more privilege), **or**
- Run with a suitable seccomp profile.

If the agent drives Playwright and browsing fails with a sandbox/namespace
error, add `args: ['--no-sandbox']` to the browser launch, or add
`--cap-add=SYS_ADMIN` to the `pa` launcher's `docker run`.

## `yousoro_browse` still blocked on some sites

`yousoro_browse` masks the JavaScript/DOM fingerprint layer (webdriver,
userAgentData → Google Chrome, real WebGL GPU, viewport) and waits out
Cloudflare "Just a moment" interstitials. It does **not** fix the network layer
(TLS/JA3 handshake, datacenter IP) or solve CAPTCHAs. So:

- **Cloudflare interstitial ("Just a moment")** — usually clears on its own; if
  it doesn't within `challenge_wait_ms` (default 20s), it's a harder managed
  challenge and won't pass.
- **Image CAPTCHA / "verification required" / "I'm not a robot"** (e.g. PyPI,
  Mojeek) — reported as `blocked: true`; move to another source. Needs a solver,
  not a better fingerprint.
- **Hardest managed challenges** (e.g. `find.4chan.org`) — TLS/IP-level; page-JS
  spoofing can't help.

`headed=true` (Xvfb-backed) removes some headless tells but, in a GPU-less
container, does not fix WebGL or the network layer. See
[yousoro-browsing.md](yousoro-browsing.md) for the full breakdown and the
before/after effect on the `web-search` source list.

## Headed Chromium fails: "Missing X server or $DISPLAY"

`yousoro_browse headed=true` needs an X display. The extension auto-spawns Xvfb
on `:99` when `DISPLAY` is unset. If it errors that Xvfb is missing, the image
was built without it — `scripts/install-system-deps.sh` installs `xvfb`; rebuild
and re-run the smoke test. If a stale `:99` socket lingers, it reuses/serves
that display; a fresh container clears it.

## `mise: Permission denied` when installing a runtime

Symptom:

```
mise ERROR Failed to install ...: failed create_dir_all: ~/.cache/mise/... : Permission denied
```

Cause: a directory mise writes to was left root-owned from the build. The fix
lives in `scripts/setup-home.sh`, which chmods `~/.cache`, `~/.config`,
`~/.local`, and `~/.pi` to `0777`. If you hit this after changing the build
order, make sure `setup-home.sh` runs **after** anything that creates those
directories (e.g. the mise install step). Rebuild and re-run `smoketest.sh`.

## `npm error EACCES` / `mkdir /home/agent/.npm/_cacache` when pi installs an extension

Symptom (e.g. installing an extension like `pi-caveman`):

```
npm error code EACCES
npm error path /home/agent/.npm/_cacache
npm error Your cache folder contains root-owned files ...
Error: npm install pi-caveman --prefix /home/agent/.pi/agent/npm ... failed with code 1
```

Cause: pi installs extensions with npm at runtime as the arbitrary host uid,
writing to `~/.npm` (cache) and `~/.pi/agent/npm` (prefix). If a build step ran
npm **as root** after `setup-home.sh` did its `0777` chmod, it left those dirs
root-owned, so the runtime uid can't write them.

Fix: `install-pi.sh` (the last root step) removes and recreates `~/.npm` and
`~/.pi/agent/npm` and chmods them `0777` at the end, after any root npm use.
If you add a build step that runs npm as root *after* `install-pi.sh`, re-open
those dirs again or you'll reintroduce this. Rebuild and re-run `smoketest.sh`
(the "npm dirs writable" check guards this).

## Files created in the project have the wrong owner (Linux)

The `pa` launcher runs the container as `--user $(id -u):$(id -g)`, so mounted
files should get your host uid. If ownership is off, confirm the launcher still
passes `--user`, and that you're not overriding it. On macOS ownership is
handled by Docker Desktop's file sharing and this generally isn't an issue.

## `unbound variable` from `build.sh` on macOS

macOS ships Bash 3.2. The script guards empty-array expansion with
`${OUTPUT_ARGS[@]+"${OUTPUT_ARGS[@]}"}` for exactly this reason. If you edit the
script and reintroduce a bare `"${arr[@]}"` on a possibly-empty array under
`set -u`, it will fail on macOS. Keep the guard.

## `docker buildx` can't `--load` a multi-arch image

Expected. A multi-platform build produces a manifest list the local daemon
can't load. Build a single platform with `--load` for local testing, or pull
the pushed image. See [building.md](building.md) and [testing.md](testing.md).

## The image is huge

Chromium + its dependencies add roughly 0.5–1 GB. That's inherent to bundling a
browser. If you don't need browsing, drop the Playwright step
(`install-browser.sh` + the `2a` block and `PLAYWRIGHT_BROWSERS_PATH` env in the
Dockerfile) to slim it down substantially.

## First run in a project is slow

Ruby and Python are compiled from source by mise on first use (minutes). This is
a one-time cost per version — results are cached in the `pi-sandbox-mise`
volume and reused on later runs. Node is a prebuilt download and is fast. See
[runtimes.md](runtimes.md).

## Stale runtime cache

To force a clean slate for runtimes:

```bash
docker volume rm pi-sandbox-mise
```

The next `pa` run recreates the volume and reinstalls versions on demand.

## Agent can't reach a model / auth errors

By default `pa` mounts `~/.pi/agent/auth.json` read-only. If you ran with
`MOUNT_AUTH=0`, the sandbox has no host credentials and needs its own auth. Drop
`MOUNT_AUTH=0` (or provide auth inside the sandbox) to fix.
