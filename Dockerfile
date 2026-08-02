# syntax=docker/dockerfile:1
FROM debian:trixie-slim

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
COPY scripts/install-mise.sh /tmp/install-mise.sh
RUN bash /tmp/install-mise.sh && rm /tmp/install-mise.sh

COPY scripts/setup-home.sh /tmp/setup-home.sh
RUN bash /tmp/setup-home.sh && rm /tmp/setup-home.sh

# Install fonts required for canvas fingerprinting (critical for Linux/Chrome)
RUN apt-get update && apt-get install -y \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    fonts-unifont \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Install CloakBrowser. Empty CLOAKBROWSER_VERSION (the default) means "detect
# the latest free release"; set it to pin a specific tag when auto-detection
# picks a Pro-only release. Declared as an ARG so build.sh can forward it --
# without this the flag was accepted and silently ignored.
ARG CLOAKBROWSER_VERSION=
COPY scripts/install-cloakbrowser.sh /tmp/install-cloakbrowser.sh
RUN CLOAKBROWSER_VERSION="${CLOAKBROWSER_VERSION}" bash /tmp/install-cloakbrowser.sh \
 && rm /tmp/install-cloakbrowser.sh

COPY pa-context/APPEND_SYSTEM.base.md /opt/pa/APPEND_SYSTEM.base.md
COPY scripts/merge-append-system.sh /usr/local/bin/merge-append-system.sh
COPY scripts/seed-settings.sh /usr/local/bin/seed-settings.sh
COPY scripts/seed-trust.sh /usr/local/bin/seed-trust.sh
RUN chmod 0755 /usr/local/bin/merge-append-system.sh /usr/local/bin/seed-settings.sh /usr/local/bin/seed-trust.sh

COPY pa-skills /opt/pa/skills
COPY pa-extensions /opt/pa/extensions

# Install CloakBrowser npm package globally (for Node API access)
RUN npm install -g cloakbrowser playwright-core 2>/dev/null || true

# Install dependencies for pa-cloakbrowser extension
RUN cd /opt/pa/extensions/pa-cloakbrowser && npm install 2>/dev/null || true
COPY scripts/install-extension-deps.sh /tmp/install-extension-deps.sh
RUN bash /tmp/install-extension-deps.sh && rm /tmp/install-extension-deps.sh

# Bake the pa-rag embedding model and strip ONNX Runtime's CUDA / foreign-platform
# binaries. Must run in the same layer as the prune to actually shrink the image.
COPY scripts/install-rag-model.sh /tmp/install-rag-model.sh
RUN bash /tmp/install-rag-model.sh && rm /tmp/install-rag-model.sh

COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

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
