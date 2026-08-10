# pi-sandbox

A throwaway Docker sandbox that gives your **AI coding agent** everything it needs to guide and accelerate your software engineering — without polluting your machine. Works on **macOS, Linux, and WSL on Windows**.

Run `pa` (pi **a**gent) in any project directory and the agent gets a full-featured workspace: runtimes on demand, web browsing that actually works, PDFs (even scanned ones), live browser debugging, and semantic search over your codebase. Global installs stay in the container and are cleaned up on exit — **your project files and any skills/extensions the agent authors persist on the host.**

**This sandbox does not contain an LLM. Bring your own.** Model setup and config files are covered in the [pi-agent docs](https://github.com/earendil-works/pi) — this repo is just the sandbox. Cloud providers work great, and **local models are totally usable too** (ollama, LM Studio, etc.) — no lock-in.

This sandbox runs the **pi coding agent** — an AI pair programmer that actually understands your codebase, browses the web like a human, reads PDFs (even scanned ones), and debugs live pages with you. If you've been using pi, the transition to `pa` is seamless: same agent, same skills and extensions, just a sandboxed workspace that cleans up after itself. If you're new to pi, you're in for a treat.

## What the agent can do for you

### 🔍 Search your codebase by meaning, not just keywords
Ask the agent to "find how retry logic is handled" and it uses **hybrid RAG search** (keyword + semantic vector) to surface the right code chunks across source, docs, and CI config — no `grep`-and-pray. **Live RAG** indexes changed files in real time, so the agent always has fresh context.

### 📄 Read PDFs — even scanned ones
The agent can map, search, read, and render PDFs. Scanned pages with no text layer get rendered to PNGs and analyzed by a vision model, so specs, docs, and papers are all readable.

### 🖼️ Analyze images with a vision model
Send screenshots, diagrams, or photos to the agent and it inspects them with a dedicated vision-capable model — great for UI review, layout verification, or reading cropped regions.

### 📸 Capture and inspect web pages
The agent can render any URL in a stealth Chromium (real WebGL GPU, canvas/audio noise to defeat bot detection) and save screenshots. It then **detects UI elements** with pixel-precise bounding boxes, crops to each one, and reads the text — full flow: **screenshot → find elements → crop & read**.

### 🕵️ Browse the web past bot blocks
When sites block headless browsers (reCAPTCHA v3, Cloudflare Turnstile), the agent falls back to **CloakBrowser** — a stealth Chromium with 71 C++ source-level patches. It handles Cloudflare challenges automatically, retries with backoff on rate limits, and scrolls infinite feeds for lazy-loaded content.

### 💻 Debug live web pages together with the agent
Open a page, drive it interactively, and run arbitrary JS (with top-level await) while the agent reads the console output across calls — state persists on `window`. Reproduce "I click this and X happens" bugs by having the agent drive the page while you watch.

### 🛡️ Install anything, safely — no sudo needed
`pa-apt install jq` resolves dependencies and installs to `~/.local/pa-apt` instantly. No root, no system pollution.

### 📊 Know exactly what your agent is spending
**Token usage tracking** with a `summarize-token-usage.rb` script — see per-session consumption so you always know what your agent is spending.

### 📦 Everything a developer needs, preinstalled
**ripgrep + fd** for instant code search, **DNS fallback** for resilient networking, and build caching that makes every run faster.

### 🧠 Pick up where you left off
**Session resume** persists agent state across runs — start a task, come back later, and the agent remembers.

### 🐍 Any language runtime, on demand
**Ruby 3.4 ready to go**; any version of Ruby / Node / Python installable in seconds via [mise](https://mise.jdx.dev/) — `mise install python@3.12`, done. Runtimes cached in a named volume so fetch-once, reuse-forever.

Published to Docker Hub as **`davidsiaw/pi-sandbox`**

## Getting Started

### Try it in one command

```bash
cd ~/some/project && pa
```

That's it. The agent gets a full workspace and you get an AI pair programmer that can search your codebase by meaning, read PDFs (even scanned ones), browse the web past bot blocks, debug live pages with you, and install anything on demand. When you're done, the container exits clean — your files are untouched.

### Use it every day (optional)

`pa` is part of the [crun.d](https://github.com/davidsiaw/crun.d) toolkit. To make it available everywhere:

```bash
cd $HOME
git clone https://github.com/davidsiaw/crun.d
export PATH=$HOME/crun.d:$PATH
```

To keep it on your `PATH` permanently, add the export to your shell config (`~/.bashrc`, `~/.zshrc`, etc.) — put it wherever makes sense for your setup.

### Prerequisites

- **Docker** — the sandbox is a Docker image, so you need Docker installed and running
- **An LLM** — after `pa` starts, run `/login`. Cloud providers (OpenAI, Anthropic) or local models (ollama, LM Studio) both work; config details are in the [pi-agent docs](https://github.com/earendil-works/pi).

## For Maintainers

```bash
# build + push the multi-arch image
sh build.sh

# test an existing local image
sh smoketest.sh
```

## A note on who this is for

This toolchain assumes comfort with Docker, shell configuration, and command-line workflows — it's aimed at experienced developers. If any of that sounds unfamiliar, **that's okay!** You might prefer a UI-based coding assistant instead. There's no shame in it, and you'll probably have more fun with a point-and-click tool.

## Documentation

Full docs are in [`docs/`](docs/README.md) — including architecture, troubleshooting, and how each agent capability works under the hood.
