#!/usr/bin/env bash
set -euo pipefail

# Default Ruby for the sandbox. Overridable at build time via the
# PA_RUBY_VERSION build arg. "3.4" is a partial version on purpose: mise
# resolves it to the newest installed 3.4.x, so a cache volume holding 3.4.11
# starts using it without a rebuild of this image.
PA_RUBY_VERSION="${PA_RUBY_VERSION:-3.4}"

curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh

chmod 0755 /usr/local/bin/mise

# ---------------------------------------------------------------------------
# System-wide mise config: /etc/mise/config.toml
#
# This is where the default Ruby is pinned, and the location matters. The two
# obvious alternatives both silently lose the setting:
#
#   - `mise use -g ...` writes ~/.config/mise/config.toml. ~/.config is NOT
#     mounted and NOT baked, so it is recreated empty on every container start.
#     The setting evaporates the moment the container exits.
#   - Anything under $MISE_DATA_DIR is shadowed at runtime by the cache volume
#     mounted at /home/agent/.local/share/mise.
#
# /etc/mise/config.toml is root-owned, baked into the image, and outside both,
# so the default survives container restarts AND a nuked cache volume.
#
# Precedence is unaffected for real projects: mise reads local config
# (.mise.toml, .ruby-version, .tool-versions) ahead of global ahead of system,
# so a project that pins its own Ruby still wins.
#
# Note this pins a version, it does not install one. Installs live in the cache
# volume. On a volume that has never built Ruby, the shim reports
# "Tool not installed for shim: ruby / Install all missing tools with:
# mise install" -- actionable, unlike the bare "command not found" an agent used
# to get, and unlike "No version is set for shim: ruby", which is what an
# already-populated volume reported before this file existed.
#
# [settings] idiomatic_version_file_enable_tools
#   Current mise ships this as an EMPTY list, i.e. `.ruby-version`,
#   `.node-version` and `.python-version` are ignored unless a tool is opted in.
#   That is fine when no default exists (an unconfigured `ruby` is simply an
#   error), but it turns dangerous the moment a default is pinned: a repo whose
#   .ruby-version says 3.3.5 would silently get the default 3.4 instead --
#   wrong-version-silently, which is worse than the not-installed error it used
#   to produce. Opting these three in restores the precedence this repo's docs
#   already promise. (.mise.toml and .tool-versions are read either way.)
# ---------------------------------------------------------------------------
mkdir -p /etc/mise
cat > /etc/mise/config.toml <<EOF
[settings]
idiomatic_version_file_enable_tools = ["ruby", "node", "python"]

[tools]
ruby = "${PA_RUBY_VERSION}"
EOF
chmod 0644 /etc/mise/config.toml

cat > /etc/profile.d/mise.sh <<'EOF'
_mise_shims="${MISE_DATA_DIR:-/home/agent/.local/share/mise}/shims"

if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate bash)"
fi

# `mise activate` REMOVES the shims dir from PATH -- activate and shims are two
# competing resolution modes and mise refuses to run both at the front. That is
# why the shims entry set by the Dockerfile's ENV PATH vanished in every login
# shell: Debian's /etc/profile resets PATH, this file re-added shims, and then
# activate stripped them again. Anything pi spawned inherited that stripped PATH
# and saw no ruby at all.
#
# Re-append at the END so activate keeps priority (it injects the resolved tool
# bin dir at the front) while shims remain as a fallback for two cases activate
# does not cover: processes that never ran the shell hook, and versions switched
# later in an already-running session.
case ":$PATH:" in
  *":$_mise_shims:"*) ;;
  *) export PATH="$PATH:$_mise_shims" ;;
esac
unset _mise_shims
EOF
chmod 0644 /etc/profile.d/mise.sh

mise --version
