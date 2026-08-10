# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage: uitag-export -- produce yolo-ui.onnx, then throw the toolchain away.
#
# Pinned to $BUILDPLATFORM on purpose. An ONNX graph is architecture-neutral, so
# the arm64 leg of the multi-arch build can reuse the artifact built natively on
# the builder rather than running a torch install under QEMU emulation.
#
# ~1GB of torch/ultralytics lives here and nowhere else; the final image gets a
# single 36MB file. See scripts/export-uitag-model.sh for why the model is
# exported rather than downloaded (upstream ships no ONNX; the only weights
# mirror is a gated HF repo).
# ---------------------------------------------------------------------------
# Pinned by MANIFEST-LIST digest, not by tag. `python:3.13-slim` is a moving
# tag: when upstream re-pushes it, this stage's cache is invalidated and the
# ~1GB torch install below runs again for no reason. Bump deliberately.
# Must be the manifest-list digest, never a per-arch one, or the multi-arch
# build loses the other architecture. Resolve with:
#   docker buildx imagetools inspect python:3.13-slim | head -3
# python:3.13-slim as of 2026-08-07
FROM --platform=$BUILDPLATFORM python:3.13-slim@sha256:9662417aace5ae7b8e2609cce472b72a8958e134ba372808abe9cc1a0c0125e6 AS uitag-export
COPY scripts/export-uitag-model.sh /tmp/export-uitag-model.sh
RUN bash /tmp/export-uitag-model.sh /out

# Pinned by MANIFEST-LIST digest for the same reason as the stage above, and
# it matters more here: this is layer 1 of the final image, so a moved tag
# invalidates EVERYTHING -- apt, node, Chromium, mise, CloakBrowser, the lot.
# `debian:trixie-slim` was re-pushed 2026-08-05, which produces exactly the
# "I changed a README and it rebuilt from apt-get" symptom.
# debian:trixie-slim as of 2026-08-05
FROM debian:trixie-slim@sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY scripts/install-system-deps.sh /tmp/install-system-deps.sh
RUN bash /tmp/install-system-deps.sh && rm /tmp/install-system-deps.sh

ARG PI_NODE_MAJOR=22
ENV PI_NODE_MAJOR=${PI_NODE_MAJOR}
COPY scripts/install-node-system.sh /tmp/install-node-system.sh
RUN bash /tmp/install-node-system.sh && rm /tmp/install-node-system.sh

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
COPY scripts/install-browser.sh /tmp/install-browser.sh
RUN bash /tmp/install-browser.sh && rm /tmp/install-browser.sh

ENV HOME=/home/agent
ENV MISE_DATA_DIR=/home/agent/.local/share/mise
ENV PATH=/home/agent/.local/share/mise/shims:/usr/local/bin:$PATH
ENV MISE_NOT_FOUND_AUTO_INSTALL=false
# Default Ruby, pinned system-wide in /etc/mise/config.toml by the script below.
# Partial on purpose: mise resolves "3.4" to the newest installed 3.4.x.
ARG PA_RUBY_VERSION=3.4
COPY scripts/install-mise.sh /tmp/install-mise.sh
RUN PA_RUBY_VERSION="${PA_RUBY_VERSION}" bash /tmp/install-mise.sh && rm /tmp/install-mise.sh

COPY scripts/setup-home.sh /tmp/setup-home.sh
RUN bash /tmp/setup-home.sh && rm /tmp/setup-home.sh

# Install CloakBrowser. Empty (the default) means "newest free release that has
# a binary for THIS architecture".
#
# WHY NOT PINNED: CloakHQ publishes arm64 only on some point releases. Of the
# free 146 line, .5 ships linux-x64 only while .4/.3/.2 also ship linux-arm64.
# A single pinned tag therefore cannot satisfy both legs of the multi-arch
# build -- pinning .5 fails arm64 outright. Per-arch detection resolves each
# leg to the newest release that actually has its binary, which is why the two
# architectures can legitimately ship different point releases.
#
# Detection costs exactly ONE GitHub API request per build leg; the release
# list embeds each release's assets. See scripts/install-cloakbrowser.sh.
#
# Pin anyway (e.g. to reproduce an old image):
#   CLOAKBROWSER_VERSION=chromium-v146.0.7680.177.4 sh build.sh
# Check an exact tag has BOTH arches before pinning it, or the arm64 leg breaks.
# The resolved tag is recorded at /opt/cloakbrowser/RELEASE_TAG in the image.
ARG CLOAKBROWSER_VERSION=
COPY scripts/install-cloakbrowser.sh /tmp/install-cloakbrowser.sh
RUN CLOAKBROWSER_VERSION="${CLOAKBROWSER_VERSION}" bash /tmp/install-cloakbrowser.sh \
 && rm /tmp/install-cloakbrowser.sh

# Install CloakBrowser npm package globally (for Node API access)
RUN npm install -g cloakbrowser playwright-core

COPY scripts/patch-auth2api.sh /tmp/patch-auth2api.sh

# Install auth2api (OAuth-to-API proxy for Claude/ChatGPT/Cursor).
# Clone+build because the npm package omits dist/ and has no bin entry.
# Handles billing headers, beta flags, SHA-256 signing, and all cloaking.
# The pa-anthropic-oauth extension writes tokens to ~/.auth2api/ and the
# start-auth2api.sh watcher (started by entrypoint.sh) launches this proxy.
# Errors are NOT hidden — a failed clone must fail the build loudly.
# We patch cloaking.ts to relocate third-party system prompts into the first
# user message (without this, Anthropic rejects OAuth requests with a 400
# "Third-party apps now draw from your extra usage").
RUN git clone --depth 1 https://github.com/AmazingAng/auth2api /opt/auth2api && \
    chmod +x /tmp/patch-auth2api.sh && \
    /tmp/patch-auth2api.sh /opt/auth2api && \
    cd /opt/auth2api && npm install && npm run build && npm prune --production && \
    printf '#!/bin/bash\nexec node /opt/auth2api/dist/index.js "$@"\n' > /usr/local/bin/auth2api && \
    chmod +x /usr/local/bin/auth2api && \
    rm -rf /opt/auth2api/.git /opt/auth2api/src /opt/auth2api/tests /tmp/patch-auth2api.sh

# ---------------------------------------------------------------------------
# Everything ABOVE this line is third-party and slow to build (apt, node,
# Chromium, mise, CloakBrowser, auth2api). Everything BELOW is this repo's own
# source, which changes constantly. Keep that order: these COPYs used to sit
# near the top, so editing one line of one extension invalidated the auth2api
# clone+build, the global npm installs, and the 23MB model bake underneath it.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Extension DEPENDENCIES, installed from manifests alone.
#
# Only package.json (and lockfile, where present) is copied here, deliberately.
# Everything from this point down to the source COPY is expensive -- six npm
# installs (pa-rag's tree alone is 329MB), a 23MB model download, an ONNX
# Runtime prune, two upstream patches and a second model bake -- and none of it
# reads extension SOURCE. Copying the whole tree first meant editing one comment
# in one extension re-ran all of it, plus the pi install below.
#
# Manifests are listed one by one rather than globbed: `COPY a/*/package.json`
# flattens and would collide. Only extensions that DECLARE dependencies need to
# be here; the rest have nothing to install. Forgetting to add one is caught at
# build time by the --verify pass after the source COPY, not at runtime.
#
# The later `COPY pa-extensions` overlays source on top and cannot remove the
# node_modules installed here: COPY merges into the destination, and
# .dockerignore keeps any local node_modules out of the build context.
# ---------------------------------------------------------------------------
COPY pa-extensions/pa-cloakbrowser/package.json    /opt/pa/extensions/pa-cloakbrowser/
COPY pa-extensions/pa-console/package.json         /opt/pa/extensions/pa-console/
COPY pa-extensions/pa-inspect-image/package.json   /opt/pa/extensions/pa-inspect-image/
COPY pa-extensions/pa-screenshot/package.json      /opt/pa/extensions/pa-screenshot/
COPY pa-extensions/pa-uitag/package.json           /opt/pa/extensions/pa-uitag/
COPY pa-extensions/pa-rag/package.json             pa-extensions/pa-rag/package-lock.json             /opt/pa/extensions/pa-rag/
COPY pa-extensions/pa-yousoro-browse/package.json  pa-extensions/pa-yousoro-browse/package-lock.json  /opt/pa/extensions/pa-yousoro-browse/

# pa-cloakbrowser used to get its own `npm install` here. That was redundant:
# it declares only `dependencies` (typebox) and no devDependencies, so the
# generic pass below already produces an identical tree.
COPY scripts/install-extension-deps.sh /tmp/install-extension-deps.sh
RUN bash /tmp/install-extension-deps.sh

# Bake the pa-rag embedding model and strip ONNX Runtime's CUDA / foreign-platform
# binaries. Must run in the same layer as the prune to actually shrink the image.
COPY scripts/install-rag-model.sh /tmp/install-rag-model.sh
RUN bash /tmp/install-rag-model.sh && rm /tmp/install-rag-model.sh

# Cap pi-local-rag's embedding batch size. Upstream's hardcoded BATCH_SIZE=64
# peaks at ~2.2GB RSS for one batch of real source chunks, which OOM-kills the
# container (exit 137) inside Docker Desktop's ~3.8GB VM. See the script header
# for the measured numbers. PA_RAG_BATCH_SIZE overrides the default at runtime.
COPY scripts/patch-rag-batch.sh /tmp/patch-rag-batch.sh
RUN bash /tmp/patch-rag-batch.sh && rm /tmp/patch-rag-batch.sh

# Route .jsonl extraction through pa-rag, so an opted-in session transcript is
# indexed as message prose rather than raw JSON lines. Inert unless pa-rag
# installs the hook. See the script header for the retrieval-quality measurement.
COPY scripts/patch-rag-jsonl.sh /tmp/patch-rag-jsonl.sh
RUN bash /tmp/patch-rag-jsonl.sh && rm /tmp/patch-rag-jsonl.sh

# Bake the pa-uitag UI-element detection model (ONNX). Runs after pa-rag because
# it reuses that extension's onnxruntime-node to verify the model loads. Takes
# the artifact from the uitag-export stage by default; PA_UITAG_MODEL_URL
# overrides it with a self-hosted copy.
ARG PA_UITAG_MODEL_URL=
COPY --from=uitag-export /out/ /tmp/uitag-prebuilt/
COPY scripts/install-uitag-model.sh /tmp/install-uitag-model.sh
RUN PA_UITAG_MODEL_URL="${PA_UITAG_MODEL_URL}" bash /tmp/install-uitag-model.sh \
 && rm -rf /tmp/install-uitag-model.sh /tmp/uitag-prebuilt

# ---------------------------------------------------------------------------
# Extension SOURCE. Everything above this line survives a source-only edit.
# The --verify pass asserts each extension declaring dependencies actually got a
# node_modules, so an extension added without a manifest COPY above fails the
# build here instead of failing at runtime when jiti cannot resolve its imports.
# ---------------------------------------------------------------------------
COPY pa-extensions /opt/pa/extensions
RUN bash /tmp/install-extension-deps.sh --verify && rm /tmp/install-extension-deps.sh

# Skills are 36KB of markdown and change often, so they sit BELOW every
# expensive step. Copied higher up they invalidated the extension npm installs,
# both model bakes and the pi install for a one-line doc edit.
COPY pa-skills /opt/pa/skills

# The sandbox's own documentation, so an agent can answer "why can't I sudo?" or
# "where do files persist?" from inside a container without being handed a repo
# URL. Mirrors how pi ships its own docs: files on disk plus a pointer in the
# system prompt (APPEND_SYSTEM.base.md), read on demand with the ordinary `read`
# tool. NOT inlined into the prompt -- 17 files, ~24k words, ~32k tokens.
#
# The whole directory is copied so the relative cross-links between the docs
# resolve. Baked docs describe THIS image rather than whatever master says,
# which is the point.
#
# Also low, for the same cache reason as skills: docs change constantly.
COPY docs /opt/pa/docs
COPY README.md /opt/pa/docs/repo-README.md

# The agent's baked guidance, and the entrypoint helpers that assemble it at
# runtime. Moved down here from the top of this section simply because nothing
# in the BUILD depends on them -- they are read only by entrypoint.sh at
# runtime -- so they belong with the other prose rather than above six npm
# installs, the model bakes and the patches.
#
# In steady state APPEND_SYSTEM.base.md rarely changes; this is not optimising
# for churn, just putting a no-dependency COPY where it cannot cost anything.
COPY pa-context/APPEND_SYSTEM.base.md /opt/pa/APPEND_SYSTEM.base.md
COPY scripts/merge-append-system.sh /usr/local/bin/merge-append-system.sh
COPY scripts/seed-settings.sh /usr/local/bin/seed-settings.sh
COPY scripts/seed-trust.sh /usr/local/bin/seed-trust.sh
RUN chmod 0755 /usr/local/bin/merge-append-system.sh /usr/local/bin/seed-settings.sh /usr/local/bin/seed-trust.sh

# `pa-apt`: install Debian packages without root, into a user prefix, plus the
# profile.d wiring that puts that prefix on PATH. This is what makes sudo
# optional -- `pa` runs with --security-opt no-new-privileges by default, so
# sudo fails at the kernel level, and installing a missing CLI tool has to work
# unprivileged. Deliberately placed low: it depends on nothing above it, so a
# change here cannot invalidate the npm installs or model bakes.
COPY scripts/install-pa-apt.sh /tmp/install-pa-apt.sh
RUN bash /tmp/install-pa-apt.sh && rm /tmp/install-pa-apt.sh

COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/start-auth2api.sh /usr/local/bin/start-auth2api.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/start-auth2api.sh

ARG PI_VERSION=latest
ENV PI_VERSION=${PI_VERSION}
ENV PI_RESUME_COMMAND=pa
# Serialize tool calls: one at a time instead of concurrent fan-out. Read by the
# tool-execution patch in install-pi.sh. Set PI_TOOL_EXECUTION=parallel to opt out.
ENV PI_TOOL_EXECUTION=sequential
COPY scripts/install-pi.sh /tmp/install-pi.sh
RUN bash /tmp/install-pi.sh && rm /tmp/install-pi.sh

WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash", "-l"]
