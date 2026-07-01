# pi-sandbox

A throwaway Docker sandbox for running the **pi coding agent** in isolation.
Global installs (gems, npm, pip, extra language runtimes) stay in the container
and are nuked on exit; your project files and any skills/extensions the agent
authors persist on the host.

- Any version of **Ruby / Node / Python** on demand, via [mise](https://mise.jdx.dev/)
- **Arbitrary-uid**: one image runs correctly as any user on macOS or Linux
- Compiled runtimes **cached** in a named volume — pay the build cost once
- **Playwright + Chromium** preinstalled for web browsing
- Published to Docker Hub as **`davidsiaw/pi-sandbox`**

## Quick start

```bash
# maintainer: build + push the multi-arch image
sh build.sh

# test an existing local image
sh smoketest.sh

# user: run the agent in any project directory
cd ~/some/project && pa
```

The `pa` launcher lives in the crun toolkit (`~/crun.d/pa`) and just runs the
prebuilt image against the current directory.

## Documentation

Full docs are in [`docs/`](docs/README.md):

- [overview.md](docs/overview.md) — what this is and why
- [architecture.md](docs/architecture.md) — how the image is built, layer by layer
- [usage.md](docs/usage.md) — running `pa`, mounts, env toggles
- [runtimes.md](docs/runtimes.md) — mise and the runtime cache volume
- [building.md](docs/building.md) — `build.sh`, dual-arch, CI
- [testing.md](docs/testing.md) — `smoketest.sh`
- [troubleshooting.md](docs/troubleshooting.md) — common problems and fixes
