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
(TLS/JA3 handshake, egress IP) or solve CAPTCHAs. So:

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

## Build fails: "Could not find a free CloakBrowser release"

Usually a **GitHub API rate limit**, not a licensing change:

```bash
curl -s https://api.github.com/rate_limit    # "remaining": 0 means this is it
```

Unauthenticated requests get 60/hour/IP, and anything else on the same IP spends
the same budget. Wait for the reset, set `GITHUB_TOKEN`, or pin the version
(which needs a single API call):

```bash
CLOAKBROWSER_VERSION=chromium-v146.0.7680.177.4 sh build.sh   # has both x64 and arm64
```

See [cloakbrowser.md](cloakbrowser.md#building-the-image) for why the old script
misreported this as "the latest releases appear to be Pro-only".

## The image is huge

Chromium + its dependencies add roughly 0.5–1 GB. That's inherent to bundling a
browser. If you don't need browsing, drop the Playwright step
(`install-browser.sh` + the `2a` block and `PLAYWRIGHT_BROWSERS_PATH` env in the
Dockerfile) to slim it down substantially.

## First run in a project installs a runtime

Installing a runtime mise doesn't have yet is a **prebuilt download of a few
seconds** — measured in this image: Ruby 7.2s, Python 3.0s, Node similar. It is
cached in the `pi-sandbox-mise` volume and reused on later runs.

This section used to warn that Ruby and Python were compiled from source and
took minutes. That is no longer true; mise ships prebuilt, attestation-verified
builds for both linux arches. If you *do* see a multi-minute build, it means no
prebuilt exists for the exact version requested and mise fell back to compiling
— pick a mainstream patch version to avoid it. See [runtimes.md](runtimes.md).

## Stale runtime cache

To force a clean slate for runtimes:

```bash
docker volume rm pi-sandbox-mise
```

The next `pa` run recreates the volume and reinstalls versions on demand.

## Nothing resolves in the container / a tailnet hostname is unknown

First check whether DNS is broken at all:

```bash
getent hosts example.com     # plain DNS
getent hosts my-mac.tail12345.ts.net   # a tailnet peer
```

If **plain DNS** fails, it is the host's docker daemon DNS, not `pa` — `pa`
passes no `--dns` and the entrypoint does not touch `/etc/resolv.conf`. Check
`docker run --rm alpine nslookup example.com` and your daemon's `dns` setting.

If **only the tailnet name** fails, the launcher's MagicDNS snapshot missed it.
`pa` reads `tailscale status` on the host at launch and injects each peer with
`--add-host` (see [usage.md](usage.md#networking-dns-and-tailnet-hostnames)), so:

- the peer must be visible in `tailscale status` **on the host** when `pa`
  starts — a peer that appeared later needs a `pa` restart;
- use the **full** MagicDNS name (`host.tail12345.ts.net`); short names are not
  injected;
- `tailscale status --json` must report `MagicDNSSuffix` (MagicDNS enabled).

If **`<env>.<suffix>` (the heighliner app) fails** but everything else resolves,
heighliner's DNS container was down when `pa` started, so its resolver was
deliberately not wired up. Start it and restart `pa`. `pa` warns on the host
terminal if that container is running but has no IPv4 on the spice network.

It is called `heighliner-dns`, or `kaiser-dns` on an install predating the
rename. `pa` does not guess: `sp up` asks heighliner and labels the spice
container with the answer. `sp status` prints which one is in use. A spice server
started by an older `sp` carries no labels, so `pa` assumes the heighliner names
— if that server is on `kaiser_net`, `sp down && sp up` fixes it.

Older versions passed `--dns 100.100.100.100` and papered over the fallout with
a `sudo` rewrite of `/etc/resolv.conf` in the entrypoint. If you are carrying a
local `~/crun.d/pa` from back then, that flag alone will break **all** DNS in the
container — remove it.

## Agent can't reach a model / auth errors

By default `pa` mounts `~/.pi/agent/auth.json` read-only. If you ran with
`MOUNT_AUTH=0`, the sandbox has no host credentials and needs its own auth. Drop
`MOUNT_AUTH=0` (or provide auth inside the sandbox) to fix.
