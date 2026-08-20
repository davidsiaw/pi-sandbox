# Architecture

How the image is assembled and why each decision was made. Read alongside the
`Dockerfile` and the scripts in `scripts/`.

## Base image

`debian:trixie-slim` (current Debian stable, glibc 2.41 — mise's prebuilt binary
now requires glibc ≥ 2.38, which the older bookworm's 2.36 does not satisfy).
Chosen over Alpine because mise's runtimes are **glibc** binaries: Ruby and
Python now arrive as prebuilt `*_linux` tarballs linked against glibc, which
simply will not run on musl. (This used to be argued as "Ruby and Python are
compiled from source, and musl makes that painful" — the conclusion is the same
but the reason is now stronger, since on Alpine there would be no prebuilt to
fall back to.) Slim keeps the base small; we add only what we need.

## Build stages (Dockerfile order)

The Dockerfile runs a sequence of small scripts rather than long inline `RUN`
blocks, so each step is readable and independently editable.

### 1. System packages — `scripts/install-system-deps.sh` (root)

Installs the toolchain and libraries needed to:

- run mise (`curl`, `ca-certificates`, `git`)
- give pi its search tools on PATH (`fd-find` → `/usr/bin/fdfind`, `ripgrep` →
  `/usr/bin/rg`) so pi finds them via its system-PATH check and never downloads
  copies into the ephemeral `~/.pi/agent/bin` on every container start
- build native gems and pip wheels (`build-essential`, `libssl-dev`,
  `libreadline-dev`, `zlib1g-dev`, `libyaml-dev`, `libffi-dev`, and friends)
- compile a runtime from source in the rare case no prebuilt exists for a
  requested version (the common path is a prebuilt download and needs none of
  this)

`sudo` is included so that `pa --sudo` has something to run; the default launch
denies it at the kernel level and the agent uses `pa-apt` instead (see the
security note below). (Remove the sudo grant in `setup-home.sh`/deps if you want
stricter isolation — see note below.)

### 2. Fixed system Node + pi — `install-node-system.sh`, `install-pi.sh` (root)

A pinned Node.js (NodeSource, major version `PI_NODE_MAJOR`, default 22) is
installed **system-wide** at `/usr/bin/node`, and pi is installed globally with
that Node.

**Why a separate, fixed Node?** The agent switches Node versions per project
through mise. If pi ran on a mise-managed Node, switching the project's Node —
or mounting a fresh mise cache volume — could make pi's runtime disappear.
Keeping pi on a system Node in `/usr/bin` means pi always works regardless of
what the project does. `which pi` → `/usr/bin/pi`; `which node` → the mise shim.

### 2a. Playwright + Chromium — `install-browser.sh` (root)

Installs the Playwright CLI globally (on the system Node) and Chromium plus its
OS dependencies via `playwright install --with-deps chromium`. Browsers are
placed at `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`, world-readable and
root-owned, so they:

- survive the mise data-dir volume overlay at runtime,
- are usable by whatever uid the container runs as,
- are not re-downloaded per run.

This adds roughly 0.5–1 GB to the image. See
[troubleshooting.md](troubleshooting.md) for the Chromium-in-Docker sandbox note.

`xvfb` is also installed (in `install-system-deps.sh`) so the `pa-yousoro-browse`
tool can run a **headed** Chromium behind a virtual X display when asked. See
[yousoro-browsing.md](yousoro-browsing.md).

### 3. mise — `install-mise.sh` (root)

mise is installed **system-wide** to `/usr/local/bin/mise` (root-owned,
read-only). No language runtimes are baked; they are installed on demand at
runtime and cached in a volume (see [runtimes.md](runtimes.md)).

Activation is wired via `/etc/profile.d/mise.sh` so any login shell picks it up
regardless of user or home directory. The shims directory is also placed on
`PATH` via the Dockerfile `ENV`, so runtimes work even in **non-interactive**
`docker run image cmd` calls (which don't read profile scripts).

**Implicit auto-install is disabled** via `MISE_NOT_FOUND_AUTO_INSTALL=false`
(set in the Dockerfile). Without this, calling a shim for a version that isn't
installed — e.g. running `ruby` in a directory containing a `.ruby-version` —
silently downloads and installs it (verified). Instead, missing runtimes report
that they are not installed, and the agent installs versions explicitly with
`mise use` / `mise install`. See [runtimes.md](runtimes.md).

This is about implicitness, not cost: installs are prebuilt downloads taking
seconds. It also covers a second route — `mise activate` registers a bash
`command_not_found_handle` that installs on any miss, which is what fires on a
fresh volume where no shims exist yet.

### 4. Writable HOME — `setup-home.sh` (root)

Prepares the arbitrary-uid model:

- `HOME=/home/agent` is created `0777` so any uid can write config/state/sessions.
- `~/.pi/agent`, `~/.local/share/mise`, `~/.cache/mise`, `~/.config` are created
  and made `0777`. (mise writes lockfiles under `~/.cache/mise` and config under
  `~/.config/mise`; both were root-owned from the install step, so they're
  opened up here.)
- `/etc/passwd` is made world-writable so the entrypoint can append a user entry.

### 5. Baked guidance + merge — `merge-append-system.sh`

A short block of always-in-context guidance about this environment is baked into
the image at `/opt/pa/APPEND_SYSTEM.base.md`. The `pa` launcher stages any host
`APPEND_SYSTEM.md` at `/opt/pa/APPEND_SYSTEM.host.md`. At startup the merge
script writes `~/.pi/agent/APPEND_SYSTEM.md` as **host first, then the baked
base** (or just the base if there is no host append). pi loads that slot
natively — no flag, no shell interpolation of prompt text. See
[usage.md](usage.md) for the full context/system-prompt file behavior.

### 6. Entrypoint — `entrypoint.sh`

At runtime the container is launched with `--user <uid>:<gid>`. That uid may not
exist in `/etc/passwd`, which makes tools like npm, git, and mise misbehave. The
entrypoint appends a synthetic passwd entry for the current uid (pointing at the
world-writable `HOME`), runs the APPEND_SYSTEM merge and the settings seed
(`seed-settings.sh`), then `exec`s the requested command (default: a login shell
so mise activates).

`seed-settings.sh` writes a writable `~/.pi/agent/settings.json` from the staged
host copy (`/opt/pa/settings.host.json`, if mounted) plus `lastChangelogVersion`
set to the image's pi version, so pi never replays its startup changelog. See
[usage.md](usage.md).

## The arbitrary-uid model (why no user is baked)

Earlier iterations baked a `UID`/`GID` at build time to match the host. That
requires a per-host build and breaks when the image is pushed and pulled onto a
machine with a different uid.

The current model borrows the OpenShift pattern:

- **Everything installed is root-owned and read-only** — node, pi, playwright,
  chromium, the mise binary, all system libs.
- **Only three things are writable:** the world-writable `HOME`, the
  bind-mounted project directory, and the mise cache volume. Host package
  checkouts passed via `PA_PACKAGES` are mounted read-only at
  `/opt/pa/local-packages/<name>-<n>` and are explicitly *not* writable (see
  [usage.md](usage.md#private-extensions-and-skills)).
- **The container runs as the host uid** via `--user $(id -u):$(id -g)` in the
  launcher, and the entrypoint gives that uid a valid identity.

Result: one image runs correctly as uid 501 (macOS), 1000 (Linux), or anything
else. Files written to bind mounts get the host uid, so ownership is correct on
Linux and irrelevant on macOS (Docker Desktop's VM maps it anyway).

## What is *not* in the image

- **No language runtimes** — installed on demand, cached in the volume.
- **No user account tied to a uid** — synthesized at runtime.
- **No `VOLUME` instruction** — caching is the launcher's job via a *named*
  volume. Declaring `VOLUME` would spawn stray anonymous volumes on bare
  `docker run` and could discard the `setup-home.sh` chmod. See
  [runtimes.md](runtimes.md).

## Security note: sudo is opt-in

The image still carries a passwordless sudoers rule, but `pa` launches the
container with `--security-opt no-new-privileges`, so the kernel ignores the
setuid bit on `/usr/bin/sudo` and it fails:

```
sudo: The "no new privileges" flag is set, which prevents sudo from running as root.
```

That is deliberately a **kernel** control rather than a configuration one. This
image makes `/etc/passwd` world-writable to support the arbitrary-uid model, so
anything that resolves privilege through files is potentially reachable by the
agent; `no_new_privs` is a process flag it cannot clear.

`pa --sudo` drops the flag for a single run, and warns on the host terminal that
the agent has root — including over the bind-mounted project directory, which is
the part that outlives the container. It is per-invocation by design: there is no
sticky setting, so enabling it is always a deliberate act.

**Losing sudo does not mean losing package installs.** `pa-apt install <pkg>`
installs Debian packages, with dependency resolution, into `~/.local/pa-apt`
without any privilege — see [scripts.md](scripts.md#scriptsinstall-pa-aptsh).
What it cannot do is run maintainer scripts, so system integration (services,
CA certificates, `update-alternatives`) still needs `pa --sudo`, or is better
solved by building from source into `$HOME` or baking it into the image.

Note the boundary lives in the **launcher**: a bare `docker run` of this image
still has sudo, which is what makes the image debuggable and what `smoketest.sh`
relies on to test both modes.
