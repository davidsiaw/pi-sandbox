# Overview

## What this is

`pi-sandbox` is a Docker image that runs the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
inside a container. You start it in any project directory; the container mounts
that directory, runs the agent against it, and throws everything else away when
it exits.

## Why

The agent frequently installs things to do its job: bundler gems, npm modules,
pip packages, and sometimes whole new language runtimes. Doing that directly on
your machine litters your environment and risks version conflicts. Running the
agent in a disposable container keeps all of that mess contained:

- **Global installs are ephemeral.** `gem install`, `npm -g`, `pip install`,
  and extra language versions live inside the container and vanish on exit.
- **Your project is real.** The working directory is bind-mounted at its true
  host path, so edits the agent makes are edits to your actual files.
- **Your agent work persists.** Skills and extensions you ask the agent to
  author are mounted read-write and saved back to your host `~/.pi`.
- **Your secrets stay yours.** Only the auth token (read-only, optional) is
  shared; other credentials are never mounted.
- **The agent knows it's in the sandbox.** A baked block of guidance about this
  environment is injected into pi's system prompt every run, composing with any
  personal prompt/context files you keep on the host. See [usage.md](usage.md).

## Design goals

1. **Any version of Ruby, Node, and Python, on demand.**
   Managed by [mise](https://mise.jdx.dev/). The agent can install and switch
   versions per project without touching the host. See [runtimes.md](runtimes.md).

2. **Runs as any user on any host (arbitrary-uid).**
   Nothing is baked to a specific UID. Everything the image installs is
   root-owned and read-only; only `HOME`, the mounted project, and the mise
   cache volume are writable. The container is launched with
   `--user $(id -u):$(id -g)`, so file ownership lines up on Linux and stays
   harmless on macOS. One image works everywhere — build once, push, run
   anywhere. See [architecture.md](architecture.md).

3. **Fast repeat runs.**
   Compiling Ruby/Python from source is slow. Those compiled runtimes are
   cached in a named Docker volume, so you pay the cost once. See
   [runtimes.md](runtimes.md).

4. **Browser automation built in.**
   Playwright + Chromium are preinstalled so the agent's web-search / browsing
   features work out of the box. A baked `yousoro_browse` tool adds
   fingerprint masking and Cloudflare-challenge handling for reading pages that
   reject plain headless browsers. See [architecture.md](architecture.md) and
   [yousoro-browsing.md](yousoro-browsing.md).

5. **The agent is told how to use the sandbox.**
   Always-in-context guidance (runtimes are on demand, what's ephemeral,
   Chromium needs `--no-sandbox`) is baked into the image and merged with your
   own host prompt files, so the knowledge is present on every device without
   editing each machine's config. See [usage.md](usage.md).

## The moving parts

| Piece                       | Where it lives                | Purpose                                  |
|-----------------------------|-------------------------------|------------------------------------------|
| `Dockerfile` + `scripts/`   | this repo                     | defines/builds the image                 |
| `build.sh`                  | this repo                     | dual-arch build & push                   |
| `smoketest.sh`              | this repo                     | verifies an existing image               |
| GitHub workflow             | this repo                     | CI build & push                          |
| `pa` launcher               | `~/crun.d/pa` (crun toolkit)  | runs the image against the current dir   |
| mise cache volume           | Docker named volume           | persists compiled runtimes across runs   |
| `pa-context/`               | this repo                     | baked system-prompt guidance for the agent |
| `pa-skills/`, `pa-extensions/` | this repo                  | skills & extensions baked into the image |

The image is published to Docker Hub as **`davidsiaw/pi-sandbox`**.
