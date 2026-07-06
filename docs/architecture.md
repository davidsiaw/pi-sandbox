# Architecture

How the image is assembled and why each decision was made. Read alongside the
`Dockerfile` and the scripts in `scripts/`.

## Base image

`debian:trixie-slim` (current Debian stable, glibc 2.41 — mise's prebuilt binary
now requires glibc ≥ 2.38, which the older bookworm's 2.36 does not satisfy).
Chosen over Alpine because Ruby and Python are compiled
from source by mise, and glibc (Debian) avoids the musl-related build pain that
Alpine introduces. Slim keeps the base small; we add only what we need.

## Build stages (Dockerfile order)

The Dockerfile runs a sequence of small scripts rather than long inline `RUN`
blocks, so each step is readable and independently editable.

### 1. System packages — `scripts/install-system-deps.sh` (root)

Installs the toolchain and libraries needed to:

- run mise (`curl`, `ca-certificates`, `git`)
- compile Ruby and Python from source (`build-essential`, `libssl-dev`,
  `libreadline-dev`, `zlib1g-dev`, `libyaml-dev`, `libffi-dev`, and friends)
- build native gems and pip wheels

`sudo` is included so the agent *can* `apt install` an extra library mid-task if
a build needs one. (Remove the sudo grant in `setup-home.sh`/deps if you want
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
would silently trigger a multi-minute source compile. Instead, missing runtimes
report `command not found`, and the agent installs versions explicitly with
`mise use` / `mise install`. See [runtimes.md](runtimes.md).

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
  bind-mounted project directory, and the mise cache volume.
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

## Security note

The image grants the agent passwordless `sudo` so it can install an occasional
missing system library during a task. This is convenient but reduces isolation:
a task could `apt install` anything or modify the (ephemeral) container as root.
Since the container is disposable and the host filesystem is only exposed
through explicit mounts, this is an acceptable trade-off for a dev sandbox. If
you want stricter isolation, remove the sudo grant and the `sudo` package.
