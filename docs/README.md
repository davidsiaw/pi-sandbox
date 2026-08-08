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
- [screenshot.md](screenshot.md) — the `screenshot_url` tool: renders a URL with JS and writes a PNG **to a file**, where that file goes, and why it refuses to overwrite or to capture a bot-block page
- [pdf.md](pdf.md) — the `pdf_map` / `pdf_search` / `pdf_read` / `pdf_render` tools: why a `read_pdf(path) -> text` tool drowns the model rather than hanging it (95ms of extraction = 43k tokens), the extract-once/serve-from-cache design, scanned-page detection, and why `pdf-parse` is borrowed from `pa-rag`
- [uitag.md](uitag.md) — the `detect_ui_elements` tool: pixel bounding boxes for UI elements so an agent can crop and inspect regions; why it is ONNX-in-Node rather than the 3 GB Python package, and the measured fidelity gap
- [token-usage.md](token-usage.md) — the `pa-token-usage` extension: a daily CSV of tokens/cost per response, why the data lives in the host-mounted extensions dir rather than beside the code, the append-atomicity rule that lets several containers share one file, and the host-side `summarize-token-usage.rb` report
- [rag.md](rag.md) — the `pa-rag` extension: automatic local hybrid index in `.pirag/`, what gets indexed (dotfiles, past sessions), the size gate, and how it reuses `pi-local-rag` without forking
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
├── summarize-token-usage.rb   # host tool: daily report over the pa-token-usage
│                              # CSVs; NOT baked into the image
├── .github/workflows/build.yml# CI: build & push on push/tag/dispatch
├── docs/                      # this documentation
├── pa-context/                # baked always-in-context guidance
│   └── APPEND_SYSTEM.base.md   # env facts injected into pi's system prompt
├── pa-skills/                 # skills baked into the image (subdir per skill)
│   └── <name>/SKILL.md
├── pa-extensions/             # extensions baked into the image (subdir per ext)
│   ├── _shared/               # helpers shared by extensions; NOT an extension
│   │                          # itself (no index.ts, so the pa launcher skips it)
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
