#!/usr/bin/env bash
set -euo pipefail

AUTH_DIR="${HOME}/.pi/agent/auth2api"
CONFIG="${AUTH_DIR}/config.yaml"
API_KEY="pa-anthropic-oauth-local"
# Claude Code version we impersonate. Anthropic version-GATES new models on it:
# a too-old value fails the request with 400 claude_code_version_too_old
# ("Claude Code 2.1.88 does not support this model; version 2.1.280 or newer is
# required") while older models keep working, so the symptom is one model being
# broken rather than auth being broken. auth2api's own default (2.1.88) is
# already behind the gate, hence pinning it here. Bump when the gate moves;
# keep it to a version that really shipped, or the fingerprint stops matching.
CLI_VERSION="${AUTH2API_CLI_VERSION:-2.1.280}"
LOG_FILE="${AUTH_DIR}/auth2api.log"
WATCHER_LOG="${AUTH_DIR}/watcher.log"

mkdir -p "$AUTH_DIR"
exec > "$WATCHER_LOG" 2>&1
echo "=== watcher started $(date) ==="

for _ in $(seq 1 30); do
  command -v auth2api &>/dev/null && break
  sleep 1
done

if ! command -v auth2api &>/dev/null; then
  echo "auth2api binary not found" >&2
  exit 1
fi

cat > "$CONFIG" <<EOF
host: "127.0.0.1"
port: 8317
auth-dir: "~/.pi/agent/auth2api"
api-keys:
  - "${API_KEY}"
body-limit: "200mb"
debug: "errors"
cloaking:
  cli-version: "${CLI_VERSION}"
EOF

echo "waiting for token files in ${AUTH_DIR}..."
while true; do
  ls "$AUTH_DIR"/claude-*.json &>/dev/null 2>&1 && break
  sleep 2
done

echo "token found, starting proxy on :8317"
exec auth2api --config="$CONFIG" >> "$LOG_FILE" 2>&1
