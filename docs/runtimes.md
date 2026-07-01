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

mise also reads existing `.ruby-version`, `.nvmrc`, `.python-version`, and
`.tool-versions` files, so dropping the sandbox into a project that already has
one of those is recognized — but see the next section: nothing is installed
until the agent asks for it.

## No implicit auto-install

By default mise will *silently compile/download* a missing runtime the moment a
shim is called (e.g. running `ruby` in a directory with a `.ruby-version`). We
turn that off in the image with:

```
MISE_NOT_FOUND_AUTO_INSTALL=false
```

So on startup nothing is built automatically. Calling `ruby`/`python`/`node`
for an uninstalled version just reports `command not found`. The agent installs
runtimes **on demand, explicitly**:

```bash
mise use -g ruby@3.3.5     # installs and sets it
mise install python@3.12   # installs without switching
```

This keeps first startup fast and predictable — no surprise multi-minute
compile triggered by merely entering a project. Override at runtime with
`-e MISE_NOT_FOUND_AUTO_INSTALL=true` if you ever want the old behavior.

## What lives where

Everything mise manages sits under a single directory,
`MISE_DATA_DIR=/home/agent/.local/share/mise`:

```
~/.local/share/mise/            <- the cache volume mounts here
├── installs/                   <- the expensive artifacts
│   ├── ruby/3.3.5/             <- compiled Ruby (slow to build)
│   ├── python/3.12.x/          <- compiled Python (slow to build)
│   └── node/20.20.2/           <- downloaded Node (prebuilt, fast)
└── shims/                      <- ruby, gem, node, npm, python, pip, ...
    └── node -> /usr/local/bin/mise
```

- **`installs/`** holds the actual runtimes. Ruby and Python are compiled from
  source (minutes each); Node is a prebuilt download (seconds).
- **`shims/`** are thin dispatchers that point at the mise binary and resolve
  the right version at call time.

Because both live under the one mounted path, caching them is a single volume.

## The cache volume

The `pa` launcher mounts a **named** Docker volume at the mise data dir:

```
-v pi-sandbox-mise:/home/agent/.local/share/mise
```

- First time a version is requested, mise builds/downloads it into the volume.
- Every later run reuses it — no recompilation.
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
