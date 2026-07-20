#!/usr/bin/env bash
set -euo pipefail

# Ensure agent user exists in /etc/passwd BEFORE any sudo operations.
# sudo needs to resolve the current user from /etc/passwd; if the user isn't there,
# sudo fails with "you do not exist in the passwd database".
if ! whoami >/dev/null 2>&1; then
  echo "Adding agent user to /etc/passwd..."
  echo "agent:x:$(id -u):$(id -g):agent:${HOME:-/home/agent}:/bin/bash" >> /etc/passwd
  echo "agent:*:20000:0:99999:7:::" >> /etc/shadow
fi

export HOME=/home/agent

# Configure fallback DNS servers early (using sudo to modify /etc/resolv.conf)
# Check if DNS resolution works; if not, add public DNS servers while preserving search domains
if ! getent hosts google.com >/dev/null 2>&1; then
  echo "DNS resolution failed. Adding fallback DNS servers (8.8.8.8, 1.1.1.1, 9.9.9.9)..."
  # Extract existing search/domains if present
  SEARCH_LINE=$(grep '^search\|^domain' /etc/resolv.conf 2>/dev/null || true)
  OPTIONS_LINE=$(grep '^options' /etc/resolv.conf 2>/dev/null || true)
  
  if sudo tee /etc/resolv.conf > /dev/null <<EOF
${SEARCH_LINE:+$SEARCH_LINE}
nameserver 8.8.8.8
nameserver 1.1.1.1
nameserver 9.9.9.9
${OPTIONS_LINE:+$OPTIONS_LINE}
options timeout:2 attempts:3
EOF
  then
    echo "Fallback DNS servers added."
  else
    echo "WARNING: Could not write /etc/resolv.conf. Try running with --dns 8.8.8.8 --dns 1.1.1.1"
  fi
fi

if [ -x /usr/local/bin/merge-append-system.sh ]; then
  /usr/local/bin/merge-append-system.sh || true
fi

if [ -x /usr/local/bin/seed-settings.sh ]; then
  /usr/local/bin/seed-settings.sh || true
fi

if [ -x /usr/local/bin/seed-trust.sh ]; then
  /usr/local/bin/seed-trust.sh || true
fi

exec "$@"
