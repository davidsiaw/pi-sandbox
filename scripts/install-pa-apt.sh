#!/usr/bin/env bash
set -euo pipefail

# Install `pa-apt`: Debian packages without root, plus the profile.d wiring that
# puts its prefix on PATH.
#
# This is what makes sudo optional: `pa` runs with --security-opt
# no-new-privileges by default, so sudo fails at the kernel level and installing
# a missing CLI tool has to work unprivileged.
#
# apt is NOT patched or globally reconfigured -- the wrapper redirects apt's
# state with documented -o Dir::* options and replaces only the privileged
# unpack. How and why (including why not an /etc/apt/apt.conf.d snippet):
# docs/scripts.md.
#
# The one behavioural difference from a real install: maintainer scripts do NOT
# run. pa-apt says so when it skips them, so a tool that misbehaves for that
# reason is diagnosable rather than mysterious.

install -d -m 0755 /usr/local/bin

cat > /usr/local/bin/pa-apt <<'PAAPT'
#!/usr/bin/env bash
# pa-apt -- install Debian packages into a user prefix, without root.
#
#   pa-apt install <pkg>...   resolve deps, download, unpack into the prefix
#   pa-apt update             refresh package lists
#   pa-apt list               show what has been unpacked
#   pa-apt path               print the prefix
#
# The prefix ($HOME/.local/pa-apt) is EPHEMERAL, exactly like `sudo apt install`
# was: /home/agent does not survive the container. Script it if a project needs
# a tool every session.
set -euo pipefail

PREFIX="${PA_APT_PREFIX:-$HOME/.local/pa-apt}"
STATE="$PREFIX/.apt"

case "$(uname -m)" in
  x86_64)  TRIPLET=x86_64-linux-gnu ;;
  aarch64) TRIPLET=aarch64-linux-gnu ;;
  *)       TRIPLET="$(uname -m)-linux-gnu" ;;
esac

apt_opts=(
  -o Dir::State::Lists="$STATE/lists"
  -o Dir::Cache="$STATE/cache"
  -o Dir::Cache::archives="$STATE/cache/"
  -o Debug::NoLocking=1
  -qq
)

ensure_dirs() { mkdir -p "$STATE/lists/partial" "$STATE/cache/partial" "$PREFIX"; }

# apt insists on tidying /var/cache/apt/archives/partial even when its cache is
# pointed elsewhere, and that is root-owned. The failure is cosmetic; drop just
# that line rather than hiding all of apt's stderr.
run_apt() { apt-get "${apt_opts[@]}" "$@" 2> >(grep -v "cannot remove '/var/cache/apt" >&2); }

do_update() { ensure_dirs; run_apt update; }

do_install() {
  [ "$#" -gt 0 ] || { echo "pa-apt: no packages given" >&2; exit 2; }
  ensure_dirs
  # Refresh lists on first use only; they are ephemeral like everything else.
  [ -n "$(ls -A "$STATE/lists" 2>/dev/null | grep -v '^partial$' || true)" ] || run_apt update

  rm -f "$STATE/cache"/*.deb
  run_apt install --download-only --no-install-recommends -y "$@"

  shopt -s nullglob
  local debs=("$STATE/cache"/*.deb) skipped=()
  shopt -u nullglob
  if [ "${#debs[@]}" -eq 0 ]; then
    echo "pa-apt: nothing to unpack -- already satisfied by the image."
    return 0
  fi

  local ctrl
  ctrl="$(mktemp -d)"
  for d in "${debs[@]}"; do
    dpkg -x "$d" "$PREFIX"
    # Surface skipped maintainer scripts: this is the one behavioural
    # difference from a real install, and silence here turns into a confusing
    # "the tool is there but does not work" later.
    rm -rf "${ctrl:?}"/*
    if dpkg -e "$d" "$ctrl" 2>/dev/null; then
      # Test each file separately. `ls a b` exits non-zero when EITHER is
      # missing, so a single ls would only ever fire for a package shipping
      # both scripts -- which silently disabled this warning for nano, whose
      # update-alternatives postinst is exactly the case worth reporting.
      if [ -f "$ctrl/postinst" ] || [ -f "$ctrl/preinst" ]; then
        skipped+=("$(basename "$d" | cut -d_ -f1)")
      fi
    fi
    echo "  unpacked $(basename "$d")"
  done
  rm -rf "$ctrl"

  echo "pa-apt: installed into $PREFIX"
  if [ "${#skipped[@]}" -gt 0 ]; then
    echo "pa-apt: NOTE these packages ship maintainer scripts that were NOT run:" >&2
    echo "        ${skipped[*]}" >&2
    echo "        (no ldconfig/alternatives/system config). If the tool misbehaves," >&2
    echo "        that is why -- build it from source into \$HOME instead." >&2
  fi
}

case "${1:-}" in
  install) shift; do_install "$@" ;;
  update)  do_update ;;
  list)    find "$PREFIX/usr/bin" "$PREFIX/usr/sbin" -maxdepth 1 -type f 2>/dev/null | sort || true ;;
  path)    echo "$PREFIX" ;;
  *)
    echo "usage: pa-apt {install <pkg>... | update | list | path}" >&2
    echo "installs into ${PREFIX} (already on PATH); no root required" >&2
    exit 2
    ;;
esac
PAAPT

chmod 0755 /usr/local/bin/pa-apt

# Put the prefix on PATH for every login shell. Doing this here rather than
# making the agent eval something matters: a tool it has to remember to
# activate is a tool it will forget to activate. Harmless when the prefix does
# not exist.
cat > /etc/profile.d/pa-apt.sh <<'EOF'
_pa_apt_prefix="${PA_APT_PREFIX:-$HOME/.local/pa-apt}"
case "$(uname -m)" in
  x86_64)  _pa_apt_triplet=x86_64-linux-gnu ;;
  aarch64) _pa_apt_triplet=aarch64-linux-gnu ;;
  *)       _pa_apt_triplet="$(uname -m)-linux-gnu" ;;
esac
export PATH="$_pa_apt_prefix/usr/bin:$_pa_apt_prefix/usr/sbin:$PATH"
export LD_LIBRARY_PATH="$_pa_apt_prefix/usr/lib/$_pa_apt_triplet:$_pa_apt_prefix/usr/lib:${LD_LIBRARY_PATH:-}"
unset _pa_apt_prefix _pa_apt_triplet
EOF
chmod 0644 /etc/profile.d/pa-apt.sh

bash -n /usr/local/bin/pa-apt
echo "pa-apt installed"
