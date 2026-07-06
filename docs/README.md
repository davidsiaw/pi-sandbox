# pi-sandbox documentation

A throwaway Docker sandbox for running the **pi coding agent** in isolation.
Anything the agent installs (gems, npm packages, pip packages, extra language
runtimes) stays inside the container and can be nuked at will, while your
project files and the skills/extensions you ask the agent to write persist on
the host.

## Contents

- [overview.md](overview.md) — what this is, goals, and the big picture
- [architecture.md](architecture.md) — how the image is built and why, layer by layer
- [usage.md](usage.md) — running the agent with the `pa` launcher, mounts, env toggles
- [runtimes.md](runtimes.md) — how mise manages Ruby/Node/Python and how the cache works
- [yousoro-browsing.md](yousoro-browsing.md) — the `pa-yousoro-browse` tool: fingerprint masking, Cloudflare handling, headed/Xvfb, what it does/doesn't fix
- [building.md](building.md) — `build.sh`, dual-arch builds, and the GitHub workflow
- [testing.md](testing.md) — `smoketest.sh` and what it verifies
- [scripts.md](scripts.md) — reference for the (comment-free) Dockerfile and scripts
- [troubleshooting.md](troubleshooting.md) — common problems and fixes

The `Dockerfile`, `build.sh`, `smoketest.sh`, and everything in `scripts/` are
kept comment-free by design; [scripts.md](scripts.md) is their documentation.

## TL;DR

```bash
# build + push the multi-arch image (maintainer)
sh build.sh

# test whatever image is present locally
sh smoketest.sh

# run the agent in any project directory (user)
cd ~/some/project && pa
```

## Repository layout

```
picon/
├── Dockerfile                 # the sandbox image definition
├── build.sh                   # dual-arch (amd64+arm64) build & push
├── smoketest.sh               # end-to-end test of an existing image
├── .github/workflows/build.yml# CI: build & push on push/tag/dispatch
├── docs/                      # this documentation
├── pa-context/                # baked always-in-context guidance
│   └── APPEND_SYSTEM.base.md   # env facts injected into pi's system prompt
├── pa-skills/                 # skills baked into the image (subdir per skill)
│   └── <name>/SKILL.md
├── pa-extensions/             # extensions baked into the image (subdir per ext)
│   └── <name>/index.ts
└── scripts/                   # build steps, kept out of the Dockerfile
    ├── install-system-deps.sh # apt packages (build/runtime libs)
    ├── install-node-system.sh # fixed system Node for pi
    ├── install-pi.sh          # the pi agent (global npm)
    ├── install-browser.sh     # Playwright + Chromium
    ├── install-mise.sh        # mise, system-wide
    ├── setup-home.sh          # writable HOME for arbitrary uid
    ├── merge-append-system.sh # merges host + baked APPEND_SYSTEM at startup
    ├── seed-settings.sh       # seeds settings.json to suppress the changelog
    └── entrypoint.sh          # passwd entry + append merge + settings seed
```

The `pa` launcher lives in `~/crun.d/pa` (part of the user's crun toolkit), not
in this repository — the repo only produces the image.
