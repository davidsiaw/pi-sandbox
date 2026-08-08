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

# Put the shims dir back at the FRONT of PATH.
#
# Two things conspire to remove it. Debian's /etc/profile resets PATH wholesale
# in every login shell, discarding the entry the Dockerfile's ENV PATH sets; and
# `mise activate` then strips the shims dir whenever its hook actually resolves
# something, because activate and shims are competing resolution modes. The
# result was a login shell with no shims at all -- and since CMD is `bash -l`,
# pi and everything it spawned inherited that.
#
# FRONT, not end: the shims dir must beat /usr/bin, or a mise-selected runtime
# loses to the system one. Appending instead of prepending is a silent failure
# -- `mise use -g node@20 && node --version` returns the system v22 -- because
# /usr/bin/node is found first. Ordering here is load-bearing; the smoke test
# asserts the shims dir is the first PATH entry.
#
# A duplicate entry further down PATH (left by activate) is harmless, so this
# only prepends rather than trying to dedupe.
case "$PATH" in
  "$_mise_shims":*) ;;
  *) export PATH="$_mise_shims:$PATH" ;;
esac
unset _mise_shims
EOF
chmod 0644 /etc/profile.d/mise.sh

mise --version
