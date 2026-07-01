#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/agent

if ! whoami >/dev/null 2>&1; then
  echo "agent:x:$(id -u):$(id -g):agent:${HOME}:/bin/bash" >> /etc/passwd
  echo "agent:*:20000:0:99999:7:::" >> /etc/shadow
fi

if [ -x /usr/local/bin/merge-append-system.sh ]; then
  /usr/local/bin/merge-append-system.sh || true
fi

exec "$@"
