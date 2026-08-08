# Runtimes: mise and the cache volume

## Why mise

[mise](https://mise.jdx.dev/) is a single, fast (Rust) version manager that
handles Ruby, Node, Python, and more. It replaces the trio of rbenv + nvm +
pyenv (or asdf) with one tool and one config format, and — crucially for a
container — its **shims work without shell hooks**, so runtimes resolve
correctly even in non-interactive `docker run image cmd` invocations.

The agent can install and switch versions on demand:

```bash
mise use -g ruby@3.3.5      # global default
mise use node@20            # in a project dir, writes .mise.toml
mise install python@3.12
```

## Ruby is ready out of the box

Ruby **3.4** is the sandbox default. `ruby`, `gem` and `bundle` work with no
setup, no `mise use`, and no PATH fiddling.

The pin lives in a system-wide config baked into the image:

```toml
# /etc/mise/config.toml
[tools]
ruby = "3.4"
```

It is written by `install-mise.sh` and the version is settable at build time
with the `PA_RUBY_VERSION` build arg. `"3.4"` is a *partial* version on purpose:
mise resolves it to the newest installed `3.4.x`, so a cache volume that later
builds 3.4.11 starts using it without rebuilding the image.

### Why not `mise use -g`

This was the actual bug behind "ruby is installed but I can't run it". There are
three candidate locations for a default and two of them silently lose it:

| Location | Fate at container start |
|---|---|
| `~/.config/mise/config.toml` (what `mise use -g` writes) | **Lost.** `~/.config` is neither mounted nor baked; it is recreated empty every run. |
| anything under `$MISE_DATA_DIR` | **Shadowed.** The cache volume mounts over `/home/agent/.local/share/mise`. |
| `/etc/mise/config.toml` | **Survives.** Root-owned, baked into the image, outside both. |

So an agent could run `mise use -g ruby@3.4.10`, use it happily, and find the
setting gone in the next session — while the installed Ruby was still sitting in
the volume. The shim then reported `No version is set for shim: ruby`, which
reads like a broken install rather than a missing one-line default.

Project config still wins: mise reads local (`.mise.toml`, `.ruby-version`,
`.tool-versions`) ahead of global ahead of system, so a repo that pins its own
Ruby is unaffected — but see the next section, which is what makes that true.

### `.ruby-version` had to be re-enabled

Current mise ships `idiomatic_version_file_enable_tools` as an **empty list**,
meaning `.ruby-version`, `.node-version` and `.python-version` are *ignored* by
default (only `.mise.toml` and `.tool-versions` are read).

That was harmless while nothing was pinned — an unconfigured `ruby` was just an
error. Combined with a default it becomes a trap: a repo pinning 3.3.5 in
`.ruby-version` would silently run **3.4** instead. Silently-wrong-version is a
worse failure than the not-installed error it replaced, so the system config
opts the three back in:

```toml
[settings]
idiomatic_version_file_enable_tools = ["ruby", "node", "python"]
```

Verified precedence: in a directory with `.ruby-version` = 3.3.5 the shims
resolve 3.3.5; outside it, 3.4.

### On a cache volume that has never installed Ruby

**The image bakes the pin, not the runtime.** Both `installs/` *and* `shims/`
live under `$MISE_DATA_DIR`, which is exactly where the cache volume mounts — so
a brand-new volume has no Ruby *and no shims at all*. There is therefore no shim
to produce a helpful error: `ruby` is a plain `command not found`. One
`mise install ruby` (~7s, prebuilt) fixes it permanently.

Once shims exist but the requested version does not, the error is the more
helpful:

```
mise ERROR Tool not installed for shim: ruby
Missing tool version: core:ruby@3.4
Install all missing tools with: mise install
```

So "Ruby 3.4 ready to go" is accurate for any volume that has installed Ruby
once — the normal case after first use — and costs about seven seconds on one
that hasn't. `smoketest.sh` always runs against a fresh volume and so reports
Ruby as not-yet-installed; that is expected, and it asserts the configuration
rather than the binary. After that first install the volume caches
it and every later run is instant.

## PATH: activate vs shims

mise has two resolution modes and they compete. `mise activate` **removes the
shims directory from PATH** by design, because it injects the resolved tool's
real `bin` dir at the front instead.

That interacted badly with Debian's `/etc/profile`, which *resets* `PATH`
wholesale in every login shell — discarding the `ENV PATH` the Dockerfile sets.
The old sequence was:

1. `ENV PATH` includes `.../mise/shims` ✓
2. Debian `/etc/profile` resets `PATH`, dropping it ✗
3. `/etc/profile.d/mise.sh` re-adds shims ✓
4. `mise activate` strips them again ✗

Net result: a login shell had **no shims on PATH**, and since `CMD` is
`bash -l`, pi and every process it spawned inherited that stripped `PATH`.

`/etc/profile.d/mise.sh` now re-prepends the shims dir after activating.

**Front, not end — this is load-bearing.** Appending looks harmless and is not:
with the shims dir sitting after `/usr/bin`, `mise use -g node@20 && node
--version` returns the *system* v22, because `/usr/bin/node` is found first — a
mise-selected runtime silently loses to the system one. The smoke test asserts
the shims dir is the **first** `PATH` entry, not merely present.

A duplicate shims entry further down `PATH` is harmless, so the snippet only
prepends rather than trying to dedupe.

mise also reads existing `.ruby-version`, `.nvmrc`, `.python-version`, and
`.tool-versions` files, so dropping the sandbox into a project that already has
one of those is recognized — but only because the image opts back in to the
first three (see [`.ruby-version` had to be re-enabled](#ruby-version-had-to-be-re-enabled);
mise ignores them by default). And see the next section: nothing is installed
until the agent asks for it.

## No implicit auto-install

By default mise will *silently install* a missing runtime the moment a shim is
called (e.g. running `ruby` in a directory with a `.ruby-version`). Measured,
not assumed: with the setting below removed, a bare `ruby` in a directory
pinning an uninstalled 3.2.9 immediately began downloading it. The same is true
via a second route — `mise activate` installs a bash `command_not_found_handle`
— so both the shim path and the not-found path have to be governed by it. We
turn that off in the image with:

```
MISE_NOT_FOUND_AUTO_INSTALL=false
```

So on startup nothing is installed automatically. Calling `ruby`/`python`/`node`
for an uninstalled version just reports that it is not installed. (Ruby 3.4 is
pinned as the default — see above — but the pin is still subject to this rule:
it selects a version, it never triggers an install.) The agent installs runtimes
**on demand, explicitly**:

```bash
mise use -g ruby@3.3.5     # installs and sets it
mise install python@3.12   # installs without switching
```

This keeps entering a project predictable — no install kicked off by merely
`cd`-ing somewhere. Note the *cost* argument for this setting is now much weaker
than it used to be (installs are seconds, not minutes — see below); what remains
is not wanting a network fetch and a mutated cache volume to happen implicitly.
Override at runtime with `-e MISE_NOT_FOUND_AUTO_INSTALL=true` if you want the
upstream behavior.

## What lives where

Everything mise manages sits under a single directory,
`MISE_DATA_DIR=/home/agent/.local/share/mise`:

```
~/.local/share/mise/            <- the cache volume mounts here
├── installs/                   <- the runtimes themselves
│   ├── ruby/3.4.10/            <- prebuilt download (~7s)
│   ├── python/3.12.x/          <- prebuilt download (~3s)
│   └── node/20.20.2/           <- prebuilt download (seconds)
└── shims/                      <- ruby, gem, node, npm, python, pip, ...
    └── node -> /usr/local/bin/mise
```

- **`installs/`** holds the actual runtimes. **All three are prebuilt downloads
  now** — this doc previously said Ruby and Python were compiled from source and
  took minutes each, which is no longer true. Measured in this image:
  `mise install ruby@3.2.8` → **7.2s**, `mise install python@3.12` → **3.0s**.
  Ruby binaries come from the [`jdx/ruby`](https://github.com/jdx/ruby) releases
  and are verified against GitHub artifact attestations before use
  (`✓ GitHub artifact attestations verified`), for both `x86_64_linux` and
  `arm64_linux` — so neither arch falls back to a compile.
- **`shims/`** are thin dispatchers that point at the mise binary and resolve
  the right version at call time. Note these live **inside the volume**, which
  is why a brand-new volume has no shims at all.

Because both live under the one mounted path, caching them is a single volume.
That cache is now a convenience rather than a necessity: losing it costs seconds
per runtime, not minutes.

## The cache volume

The `pa` launcher mounts a **named** Docker volume at the mise data dir:

```
-v pi-sandbox-mise:/home/agent/.local/share/mise
```

- First time a version is requested, mise builds/downloads it into the volume.
- Every later run reuses it — no re-download.
- The volume is Docker-managed and easy to nuke: `docker volume rm pi-sandbox-mise`.

A fresh named volume inherits the `0777` permissions that `setup-home.sh` set on
this directory in the image, so an arbitrary uid can populate it on first run.

## Why there is no `VOLUME` in the Dockerfile

It's tempting to add `VOLUME /home/agent/.local/share/mise` to the Dockerfile.
We deliberately **do not**, for three reasons:

1. **Anonymous volume sprawl.** `VOLUME` makes every `docker run` *without* an
   explicit `-v` create a new anonymous volume. The launcher always mounts the
   named volume, so the instruction would add nothing useful — but any bare
   `docker run image` (debugging, CI) would spawn throwaway anon volumes that
   accumulate.
2. **It can discard build-time changes.** Docker ignores filesystem changes
   made to a `VOLUME` path *after* the `VOLUME` instruction. The `0777` chmod in
   `setup-home.sh` touches this path; a `VOLUME` declared before it could
   silently drop that fix.
3. **Caching is the caller's choice.** `VOLUME` is for data an image *must* not
   lose regardless of how it's run (like a database's data dir). A dev cache is
   opt-in and belongs on the `-v` flag, which is exactly where the launcher puts
   it.

## pi is not affected by version switches

pi runs on the **fixed system Node** at `/usr/bin/node`, which is *not* under
the mise data dir and *not* in the volume. So when the agent switches the
project's Node version — or when you nuke and recreate the cache volume — pi
keeps working. Inside the container:

```
which pi    -> /usr/bin/pi          (system node, stable)
which node  -> .../mise/shims/node  (project-controlled)
```
