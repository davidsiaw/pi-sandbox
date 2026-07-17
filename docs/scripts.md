# Scripts reference

The `Dockerfile`, `build.sh`, `smoketest.sh`, and the files in `scripts/` are
kept comment-free. This page is their documentation: what each does, why, and
the non-obvious details.

## Dockerfile

`# syntax=docker/dockerfile:1` is a parser directive, not a comment — leave it.

Multipurpose sandbox for running the pi coding agent in a throwaway container.
mise manages Ruby/Node/Python at any version, installed on demand; compiled
runtimes are cached in a named volume by the launcher. Arbitrary-uid design:
nothing is baked to a specific user, everything installed is root-owned and
read-only, and only HOME, the mounted project, and the mise cache volume are
writable. Build once, push, run anywhere:

```bash
docker build -t davidsiaw/pi-sandbox:latest .
```

Build stages, in order:

1. **System packages** (`install-system-deps.sh`) — build/runtime libraries.
2. **Fixed system Node + pi** (`install-node-system.sh`, `install-pi.sh`) —
   `ARG PI_NODE_MAJOR=22`. pi runs on this Node forever, independent of any Node
   a project later selects through mise.
3. **Playwright + Chromium** (`install-browser.sh`) — `ENV
   PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`.
4. **mise** (`install-mise.sh`) — system-wide, root-owned. Key env set here:
   - `HOME=/home/agent`
   - `MISE_DATA_DIR=/home/agent/.local/share/mise`
   - `PATH=.../mise/shims:/usr/local/bin:$PATH` — shims on PATH so runtimes work
     in non-interactive `docker run` calls.
   - `MISE_NOT_FOUND_AUTO_INSTALL=false` — do NOT silently compile a missing
     runtime when a shim is called; the agent installs versions explicitly.
5. **Writable HOME + passwd/shadow appendable** (`setup-home.sh`).
6. **Baked guidance + merge + resources** (`APPEND_SYSTEM.base.md`,
   `merge-append-system.sh`, `pa-skills/`, `pa-extensions/`). The launcher
   stages any host `APPEND_SYSTEM.md` at `/opt/pa/APPEND_SYSTEM.host.md`; the
   merge script combines host (first) + base (second) into the
   `APPEND_SYSTEM.md` slot pi loads natively. Skills are copied to
   `/opt/pa/skills` and extensions to `/opt/pa/extensions`, loaded additively by
   `pa` via `--skill` / `-e`. See [usage.md](usage.md). Baked extensions that
   declare npm `dependencies` get a deterministic build-time install via
   `install-extension-deps.sh`.
7. **Entrypoint** (`entrypoint.sh`). `CMD ["bash", "-l"]` is a login shell so
   `/etc/profile.d/mise.sh` (mise activation) is sourced.

See [architecture.md](architecture.md) for the full rationale of each stage.

## scripts/install-system-deps.sh (root)

OS packages needed to run mise (`curl`, `ca-certificates`, `git`), compile Ruby
and Python from source (`build-essential`, `libssl-dev`, `libreadline-dev`,
`zlib1g-dev`, `libyaml-dev`, `libffi-dev`, and friends), and build native gems /
pip wheels. `sudo` is installed here; the grant is configured in
`setup-home.sh`. `xvfb` is also installed so `pa-yousoro-browse` can run a headed
Chromium behind a virtual X display (see [yousoro-browsing.md](yousoro-browsing.md)).

## scripts/install-node-system.sh (root)

Installs a fixed system Node via NodeSource (Debian's own is too old for pi).
Kept separate from mise so that when a project switches Node through mise, pi's
runtime is untouched. Honors `PI_NODE_MAJOR` (default 22).

## scripts/install-pi.sh (root)

`npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}` (default `latest`,
set via the `PI_VERSION` build arg) on the fixed system Node, so pi keeps
working even when a project switches Node via mise and even when the mise data
dir is replaced by a mounted cache volume at runtime. CI pins `PI_VERSION` to an
exact release so each image is reproducible and tagged with its pi version.

After install it **patches pi's resume-command output**. Vanilla pi prints
`pi --session-dir /... --session <id>` when it exits; inside the sandbox that
command wouldn't drive the container. The script edits
`dist/modes/interactive/interactive-mode.js` so `formatResumeCommand` reads the
command name from `PI_RESUME_COMMAND` (set to `pa` via the Dockerfile `ENV`) and
skips the `--session-dir` arg (the `pa` launcher already supplies it from
`$PWD`). Result: `pa --session <id>`, runnable from the host. The patch matches
two exact anchors, is idempotent (safe to re-run), and errors loudly if the
anchors move in a future pi release. See [usage.md](usage.md#resuming-a-session).

Finally, because this step is the **last root step** and ran npm as root (with
`HOME=/home/agent`), it removes and recreates `~/.npm` and `~/.pi/agent/npm`
`0777` at the end. pi installs extensions with npm at runtime as the arbitrary
host uid, writing to those dirs; leaving them root-owned causes `EACCES` (see
[troubleshooting.md](troubleshooting.md)). Any root npm use added *after* this
step must reopen them again.

## scripts/install-browser.sh (root)

Installs the Playwright CLI globally (pinned so browser + CLI versions stay in
lockstep) and Chromium plus OS deps via `playwright install --with-deps
chromium`. Browsers go to a shared, world-readable path (`chmod -R a+rX`) so
they survive the mise data-dir volume overlay, are usable by any uid, and aren't
re-downloaded per container.

## scripts/install-extension-deps.sh (root)

Runs after `COPY pa-extensions /opt/pa/extensions`. For each baked extension
directory at `/opt/pa/extensions/<name>` that ships a `package.json` with a
non-empty `dependencies` block, runs `npm install --omit=dev` there so the
extension's `node_modules/` is baked into the image and jiti can resolve the
deps at runtime. Extensions with no `dependencies` are skipped (most import
their libs — `typebox`, pi types — from pi's own bundle at runtime).

A `.dockerignore` excludes `**/node_modules/`, so a local `node_modules` on the
builder never leaks into the image; the install here is the single source of
truth. Example consumer: `pa-inspect-image` depends on
`@silvia-odwyer/photon-node` (pure WASM, same lib pi uses) to convert images to
PNG before sending them to the vision model.

## scripts/install-mise.sh (root)

Installs the mise binary to `/usr/local/bin/mise` (root-owned, read-only). No
language runtimes are baked — installed on demand and cached in the mounted
volume. Writes `/etc/profile.d/mise.sh` so every login shell activates mise and
puts the shims on PATH; data/cache/config dirs are pointed at writable locations
via env in the Dockerfile.

## scripts/setup-home.sh (root)

Prepares the arbitrary-uid model. Makes `HOME`, `~/.pi`, `~/.local` (mise data),
`~/.cache` (mise lockfiles), and `~/.config` world-writable (`0777`) so any uid
can populate them — including a fresh named cache volume, which inherits the
image dir's perms.

Makes `/etc/passwd` and `/etc/shadow` world-writable (`0666`) so the entrypoint
can append entries for the runtime uid. Both are needed: sudo's PAM validates
the account against `/etc/shadow`, and without a shadow entry sudo fails with
"account validation failure".

Grants passwordless sudo to **all** users (`ALL ALL=(ALL) NOPASSWD:ALL` in
`/etc/sudoers.d/nopasswd-all`). The container runs as an arbitrary uid, so a
specific user can't be named. This lets the agent `apt install` extra
tools/libraries during a task; changes are ephemeral. A deliberate isolation
trade-off for a disposable sandbox — see the security note in
[architecture.md](architecture.md).

## scripts/entrypoint.sh

Runs as the arbitrary runtime uid. If that uid has no `/etc/passwd` entry
(common — many tools misbehave without one), it appends a passwd entry pointing
at the world-writable HOME, plus a matching `/etc/shadow` entry (the `*`
password field means no password login; sudo is NOPASSWD anyway). Then it runs
the APPEND_SYSTEM merge, the settings seed, and the trust seed, and `exec`s the
requested command.

## scripts/seed-settings.sh

Runs from the entrypoint as the runtime uid. Writes a writable
`~/.pi/agent/settings.json` combining the staged host settings
(`/opt/pa/settings.host.json`, if the launcher mounted one) with
`lastChangelogVersion` set to the installed pi version (read from the package's
`package.json`). This stops pi from replaying its startup changelog every run —
the host `settings.json` can't be written to (mounted read-only), so pi could
never persist the seen version itself. The host file is never modified. See
[usage.md](usage.md).

## scripts/seed-trust.sh

Runs from the entrypoint as the runtime uid. **Generates** a writable
`~/.pi/agent/trust.json` that pre-trusts the current project directory:
`{ "<realpath of pwd>": true }`. The project is bind-mounted at its real host
path and the container's workdir is that path, so `pwd` (canonicalized with
`realpathSync`, matching pi's own `canonicalizePath`) is the exact key pi looks
up. The host `trust.json` is **not mounted** — pi persists trust by writing the
file, and a read-only mount makes "Trust" fail with `EROFS`. Generating a
pre-trusted, writable copy means pi never prompts or writes, and the host file
is never touched. (The launcher also passes `pi --approve` as belt-and-braces.)
See [usage.md](usage.md#project-trust).

## scripts/merge-append-system.sh

Assembles the final `~/.pi/agent/APPEND_SYSTEM.md` pi reads: host append (if the
launcher staged one at `/opt/pa/APPEND_SYSTEM.host.md`) first, a `---`
separator, then the baked base (`/opt/pa/APPEND_SYSTEM.base.md`). If no host
file was staged, the target is just the base. Regenerated every start, so
nothing accumulates. See [usage.md](usage.md).

## build.sh

Builds the image for amd64 and arm64 and optionally pushes. Requires Docker with
buildx. Registers QEMU binfmt handlers for foreign-arch builds unless
`SKIP_QEMU=1` (CI sets up QEMU with an action). Creates/selects a
`docker-container` buildx builder (required for multi-arch). Multi-arch images
can't be loaded into the local daemon, so `PUSH=0` only verifies the build.

Env: `IMAGE`, `TAG`, `PLATFORMS`, `PUSH`, `BUILDER`, `SKIP_QEMU`. See
[building.md](building.md).

## smoketest.sh

Tests an existing local image (never builds). Runs every check as an arbitrary
uid with a temporary mise cache volume, which is removed on exit unless
`KEEP=1`. Env: `IMAGE`, `KEEP`, `UID_TEST`. The full check list is in
[testing.md](testing.md).

Notable check internals:
- The auto-install check drops a `.ruby-version` in a temp dir and asserts
  `ruby` reports "command not found" (no compile).
- The merge checks use the baked base file itself as a stand-in host append; the
  sentinel string `沙盒之境` (the first heading) proves host content leads, and a
  count of 2 proves both host and base are present.
