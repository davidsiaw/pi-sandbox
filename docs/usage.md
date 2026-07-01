# Usage

## Running the agent: the `pa` launcher

`pa` (short for **pi-agent**) is a small launcher script that lives in your
crun toolkit at `~/crun.d/pa`. It runs the prebuilt `davidsiaw/pi-sandbox`
image against the current directory. It never builds anything — the image is
built and pushed separately (see [building.md](building.md)).

```bash
cd ~/some/project
pa
```

That starts the pi agent inside the container, with your project directory as
the working directory.

## What gets mounted

| Host path                          | Container path                                   | Mode | Why |
|------------------------------------|--------------------------------------------------|------|-----|
| `$PWD` (current dir)               | same path as on the host                         | rw   | your project — edits are real |
| named volume `pi-sandbox-mise`     | `/home/agent/.local/share/mise`                  | rw   | caches compiled runtimes (see [runtimes.md](runtimes.md)) |
| `~/.pi/agent/skills`               | `/home/agent/.pi/agent/skills`                   | rw   | agent-authored skills persist |
| `~/.pi/agent/extensions`           | `/home/agent/.pi/agent/extensions`               | rw   | agent-authored extensions persist |
| `~/.pi/agent/settings.json`        | same                                             | ro   | agent reads, shouldn't rewrite |
| `~/.pi/agent/models.json`          | same                                             | ro   | model config |
| `~/.pi/agent/trust.json`           | same                                             | ro   | trust config |
| `~/.pi/agent/auth.json` (optional) | same                                             | ro   | model auth token (see below) |
| `~/.pi/agent/AGENTS.md` (if present) | same                                           | ro   | your global context file |
| `~/.pi/agent/CLAUDE.md` (if present) | same                                           | ro   | your global context file |
| `~/.pi/agent/SYSTEM.md` (if present) | same                                           | ro   | replaces pi's system prompt (opt out: `NO_MOUNT_SYSTEM=1`) |
| `~/.pi/agent/APPEND_SYSTEM.md` (if present) | `/opt/pa/APPEND_SYSTEM.host.md`         | ro   | staged, then merged (see below) |

Note the project is mounted **at its real host path** (e.g.
`/Users/you/proj` → `/Users/you/proj`), matching the convention of the other
crun tools. This keeps absolute paths in output/errors meaningful on the host.

### What is deliberately *not* mounted

- `~/.pi/firecrawl-key.env`, `~/.pi/redash/` — other tool credentials stay on
  the host, out of the sandbox.
- `~/.pi/agent/sessions`, `bin`, `npm` — sandbox-local, ephemeral, auto-cleaned.

## Environment toggles

Set these when invoking `pa`:

| Variable        | Default                          | Effect |
|-----------------|----------------------------------|--------|
| `PA_IMAGE`      | `davidsiaw/pi-sandbox:latest`    | image to run |
| `MOUNT_AUTH`    | `1`                              | `0` = do **not** mount `auth.json`; keeps all credentials out of the sandbox (the agent then needs its own auth inside) |
| `MISE_VOLUME`   | `pi-sandbox-mise`                | name of the runtime cache volume |
| `NO_MOUNT_SYSTEM` | `0`                            | `1` = do **not** mount a host `SYSTEM.md` (which would replace pi's default system prompt) |

Examples:

```bash
# run a specific image tag
PA_IMAGE=davidsiaw/pi-sandbox:dev pa

# run fully offline w.r.t. credentials
MOUNT_AUTH=0 pa

# use a separate throwaway runtime cache
MISE_VOLUME=scratch pa
```

## System prompt & context files

Pi injects always-in-context guidance from fixed files in `~/.pi/agent/`. The
sandbox composes two sources without either clobbering the other:

- **Baked container guidance** — a short block describing this environment
  (mise on demand, cache volume, Chromium `--no-sandbox`, what's ephemeral) is
  built into the image at `/opt/pa/APPEND_SYSTEM.base.md`.
- **Your host files** — if present, `pa` mounts them in:
  - `AGENTS.md` / `CLAUDE.md` → their real slots (context files, always loaded)
  - `SYSTEM.md` → replaces the default prompt (opt out with `NO_MOUNT_SYSTEM=1`)
  - `APPEND_SYSTEM.md` → **not** mounted directly; it is *staged* at
    `/opt/pa/APPEND_SYSTEM.host.md`.

At container start the entrypoint runs `merge-append-system.sh`, which writes
the final `~/.pi/agent/APPEND_SYSTEM.md` as **your host append first, then a
separator, then the baked container guidance**. If you have no host append, the
target is simply the baked guidance. This is regenerated every run, so nothing
accumulates.

Even when a host `SYSTEM.md` *replaces* the base prompt, pi still appends
`APPEND_SYSTEM.md` afterward — so the container guidance lands either way. No
shell interpolation of prompt text is involved; pi loads the files natively.

## Credentials: the `auth.json` trade-off

By default `pa` mounts `~/.pi/agent/auth.json` read-only so the agent can talk
to a model immediately. This shares your model provider token with the
container. For a disposable sandbox this is usually fine (the isolation goal is
about *installs*, not credentials), but if you want the container to have no
access to your host credentials, run with `MOUNT_AUTH=0` and provide the
sandbox its own auth.

## Inside the container

- `pi` is the agent, running on the fixed system Node.
- `mise` manages Ruby/Node/Python — see [runtimes.md](runtimes.md).
- `playwright` / Chromium are available for browsing.
- The current uid has a synthesized identity (`whoami` → `agent`) and a
  writable `HOME` at `/home/agent`.

## Cleaning up

The container is `--rm`, so it's gone the moment the agent exits. To reclaim the
cached runtimes:

```bash
docker volume rm pi-sandbox-mise
```

The next `pa` run recreates the volume and recompiles versions on first use.
