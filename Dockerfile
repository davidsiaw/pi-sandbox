# syntax=docker/dockerfile:1
FROM debian:trixie-slim

COPY scripts/install-system-deps.sh /tmp/install-system-deps.sh
RUN bash /tmp/install-system-deps.sh && rm /tmp/install-system-deps.sh

ARG PI_NODE_MAJOR=22
ENV PI_NODE_MAJOR=${PI_NODE_MAJOR}
COPY scripts/install-node-system.sh /tmp/install-node-system.sh
RUN bash /tmp/install-node-system.sh && rm /tmp/install-node-system.sh
COPY scripts/install-pi.sh /tmp/install-pi.sh
RUN bash /tmp/install-pi.sh && rm /tmp/install-pi.sh

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

COPY pa-context/APPEND_SYSTEM.base.md /opt/pa/APPEND_SYSTEM.base.md
COPY scripts/merge-append-system.sh /usr/local/bin/merge-append-system.sh
COPY scripts/seed-settings.sh /usr/local/bin/seed-settings.sh
RUN chmod 0755 /usr/local/bin/merge-append-system.sh /usr/local/bin/seed-settings.sh

COPY pa-skills /opt/pa/skills
COPY pa-extensions /opt/pa/extensions

COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash", "-l"]
