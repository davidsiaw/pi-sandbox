#!/usr/bin/env bash
set -euo pipefail

# Ensure agent user exists in /etc/passwd BEFORE any sudo operations.
# sudo needs to resolve the current user from /etc/passwd; if the user isn't there,
# sudo fails with "you do not exist in the passwd database".
# The matching /etc/shadow entry is NOT written here: it carries no uid, so
# setup-home.sh creates it at build time and shadow stays root-only (0640).
# sudo does need that entry to exist -- without it PAM's account stage fails
# with "account validation failure" -- but it does not need it to be writable.
# Diagnostics go to stderr, never stdout: this entrypoint wraps every command
# run in the container, so anything printed to stdout is prepended to that
# command's real output. `pi --version | head -1` would otherwise return
# "Adding agent user to /etc/passwd..." instead of a version.
if ! whoami >/dev/null 2>&1; then
  echo "Adding agent user to /etc/passwd..." >&2
  echo "agent:x:$(id -u):$(id -g):agent:${HOME:-/home/agent}:/bin/bash" >> /etc/passwd
fi

export HOME=/home/agent

# NOTE: there is deliberately no DNS repair here. An earlier version probed
# resolution and rewrote /etc/resolv.conf via sudo when it failed. That existed
# only because the launcher passed `--dns 100.100.100.100` on Tailscale hosts,
# which replaced the container's working resolvers with a tailnet-local address
# the container often could not reach. The launcher now injects tailnet names as
# --add-host entries instead, so the container keeps docker's default DNS and
# there is nothing to fix up. It also could not work: sudo is dead under
# --security-opt no-new-privileges, which is how pa always launches.

if [ -x /usr/local/bin/merge-append-system.sh ]; then
  /usr/local/bin/merge-append-system.sh || true
fi

if [ -x /usr/local/bin/seed-settings.sh ]; then
  /usr/local/bin/seed-settings.sh || true
fi

if [ -x /usr/local/bin/seed-trust.sh ]; then
  /usr/local/bin/seed-trust.sh || true
fi

# Start the auth2api watcher in a fully detached session.
# It waits for token files in ~/.auth2api/ (written by the extension's
# /login), then launches auth2api. Completely separate from pi's process
# tree — setsid + /dev/null so it can never interfere with pi's TUI.
if [ -x /usr/local/bin/start-auth2api.sh ]; then
  setsid /usr/local/bin/start-auth2api.sh < /dev/null > /dev/null 2>&1 &
fi

exec "$@"
