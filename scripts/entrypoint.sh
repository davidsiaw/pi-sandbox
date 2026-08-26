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

# Generate a writable auth.json in the ephemeral home, from the read-only host
# staging copy and/or the persisted auth2api token file. Nothing is mounted at
# pi's real auth.json path, so pi's own writes (a /login, an OAuth refresh) can
# never fail on a read-only mount, and can never reach the host's file.
#
# Before start-auth2api.sh: not required (the watcher polls for token files and
# does not read auth.json), but the ordering matches the data flow -- token file
# in, auth.json stub out -- and keeps the credential state settled before
# anything reads it.
if [ -x /usr/local/bin/seed-auth.sh ]; then
  /usr/local/bin/seed-auth.sh || true
fi
# Consumed by seed-auth.sh above. Unset before exec so neither pi nor the agent
# inherits a credential blob in its environment; `docker inspect` on the host
# still shows it, which is unavoidable with -e.
unset PA_AUTH_SEED

# Start the auth2api watcher in a fully detached session.
# It waits for token files in ~/.auth2api/ (written by the extension's
# /login), then launches auth2api. Completely separate from pi's process
# tree — setsid + /dev/null so it can never interfere with pi's TUI.
if [ -x /usr/local/bin/start-auth2api.sh ]; then
  setsid /usr/local/bin/start-auth2api.sh < /dev/null > /dev/null 2>&1 &
fi

exec "$@"
